import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type SourceKind } from './audio/engine'
import { SpeechTracker, speechAvailable } from './audio/speech'
import { FocusView } from './components/FocusView'
import { SetupView, type LevelPhase, type TakeResult } from './components/SetupView'
import { directScript } from './lib/direct'
import { computeLevelCheck, type LevelCheck } from './lib/levelcheck'
import { buildSchedule } from './lib/prompter'
import { load, save, type Saved } from './lib/storage'
import { TakeTracker, type Live, type Mode } from './lib/take'
import { validateSegments } from './lib/types'

const SAMPLE =
  "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."

const COUNTDOWN_STEP_MS = 700
/** Speech mode stops by itself this long after the last word is recognised. */
const AUTO_STOP_MS = 1500

type Phase = 'setup' | 'countdown' | 'recording'

/** Send take diagnostics to the dev server log (dev builds only). */
function logTake(data: unknown) {
  if (import.meta.env.DEV) void fetch('/api/take-log', { method: 'POST', body: JSON.stringify(data) }).catch(() => {})
}

const saved = load()

export default function App() {
  const [eng] = useState(() => {
    const e = new AudioEngine()
    e.setNoiseFloor(saved?.noiseFloor ?? null)
    return e
  })
  const speech = useRef(new SpeechTracker())

  // Script + direction: heuristics follow every edit; Claude's direction sticks until the script changes.
  const [script, setScript] = useState(saved?.script || SAMPLE)
  const [claude, setClaude] = useState<Saved['claude']>(saved?.claude ?? null)
  const segments = useMemo(() => (claude && claude.script === script ? claude.segments : directScript(script)), [script, claude])
  const directedBy = claude && claude.script === script ? 'claude' : 'auto'
  const [claudeEnabled, setClaudeEnabled] = useState(false)
  const [directing, setDirecting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Input
  const [started, setStarted] = useState(false)
  const [source, setSourceKind] = useState<SourceKind>('mic')
  const [audioError, setAudioError] = useState<string | null>(null)
  const [micGainDb, setMicGainDb] = useState<number | null>(saved?.micGainDb ?? null)
  const [levelPhase, setLevelPhase] = useState<LevelPhase>('idle')
  const [levelResult, setLevelResult] = useState<LevelCheck | null>(null)

  // Take
  const [phase, setPhase] = useState<Phase>('setup')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [mode, setMode] = useState<Mode>('timed')
  const [elapsed, setElapsed] = useState(0)
  const [take, setTake] = useState<TakeResult | null>(null)
  const tracker = useRef<TakeTracker | null>(null)
  const takeT0 = useRef(0)
  const speechError = useRef('')
  const timers = useRef<number[]>([])

  const firstWord = useMemo(() => buildSchedule(segments).segFirstWord, [segments])

  useEffect(() => save({ script, claude, micGainDb, noiseFloor: eng.noiseFloor }), [script, claude, micGainDb, eng, levelResult])

  useEffect(() => {
    fetch('/api/direct')
      .then((r) => r.json())
      .then((j: { enabled?: boolean }) => setClaudeEnabled(Boolean(j.enabled)))
      .catch(() => setClaudeEnabled(false))
  }, [])

  const refineWithClaude = async () => {
    setNotice(null)
    setDirecting(true)
    try {
      const r = await fetch('/api/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script }) })
      const j = await r.json()
      const segs = r.ok ? validateSegments(j.segments, 'claude') : null
      if (!segs) throw new Error(j.error ?? 'invalid response')
      setClaude({ script, segments: segs })
    } catch (err) {
      setClaude(null)
      setNotice(`Claude failed (${err instanceof Error ? err.message : err}) — using auto-direction.`)
    } finally {
      setDirecting(false)
    }
  }

  const setSource = useCallback(
    async (kind: SourceKind, file?: File): Promise<boolean> => {
      setAudioError(null)
      try {
        await eng.setSource(kind, file)
        // Mic gain comes from the level check; test sources stay at unity so their levels read true.
        eng.setGainDb(kind === 'mic' ? (micGainDb ?? 0) : 0)
        setSourceKind(kind)
        setStarted(true)
        return true
      } catch (err) {
        setAudioError(`Input failed: ${err instanceof Error ? err.message : err}`)
        return false
      }
    },
    [eng, micGainDb],
  )

  const checkLevel = async () => {
    if (source !== 'mic' || !(await setSource('mic'))) return
    eng.setGainDb(0)
    setLevelResult(null)
    setLevelPhase('quiet')
    const quiet = await eng.collect(3000)
    setLevelPhase('speak')
    const spoken = await eng.collect(5000)
    const res = computeLevelCheck(quiet, spoken)
    if (res.ok) {
      eng.setNoiseFloor(res.floorDb)
      setMicGainDb(res.gainDb)
    }
    eng.setGainDb(res.ok ? res.gainDb : (micGainDb ?? 0))
    setLevelResult(res)
    setLevelPhase('done')
  }

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }

  const startTake = useCallback(async () => {
    if (!segments.length) return
    if (!started && !(await setSource(source))) return
    const m: Mode = speechAvailable() ? 'speech' : 'timed'
    const t = new TakeTracker(segments, m)
    tracker.current = t
    speechError.current = ''
    setMode(m)
    setLive(null)
    setElapsed(0)
    // Start recognition during the countdown so the first words aren't lost while it warms up.
    if (m === 'speech') {
      speech.current.start(
        (words) => t.setHeard(words),
        (reason) => {
          speechError.current = reason
          // Fall back to timed scrolling for the rest of this take.
          const timed = new TakeTracker(segments, 'timed')
          timed.start(takeT0.current || performance.now())
          tracker.current = timed
          setMode('timed')
        },
      )
    }
    setPhase('countdown')
    setCountdown(3)
    timers.current = [
      window.setTimeout(() => setCountdown(2), COUNTDOWN_STEP_MS),
      window.setTimeout(() => setCountdown(1), COUNTDOWN_STEP_MS * 2),
      window.setTimeout(() => {
        setCountdown(null)
        eng.startRecording()
        takeT0.current = performance.now()
        tracker.current?.start(takeT0.current)
        setPhase('recording')
      }, COUNTDOWN_STEP_MS * 3),
    ]
  }, [segments, started, setSource, source, eng])

  const stopTake = useCallback(async () => {
    clearTimers()
    const heardCount = speech.current.stop()
    if (phase === 'countdown') {
      setCountdown(null)
      setPhase('setup')
      return
    }
    if (!eng.recording) return
    setPhase('setup')
    eng.setBand('normal')
    const t = tracker.current!
    const { webm, stats } = await eng.stopRecording()
    const usedSpeech = t.mode === 'speech' && heardCount > 0
    // Only count words actually reached, so stopping early doesn't inflate the pace.
    const words = Math.round(t.followed * t.words.length)
    const minutes = (usedSpeech ? stats.speakingSec : stats.takeSec) / 60
    const lines = t.results()
    logTake({ source, mode: t.mode, speechError: speechError.current, heardCount, followed: t.followed, gainDb: eng.gainDb, noiseFloor: eng.noiseFloor, stats, lines })
    const webmUrl = URL.createObjectURL(webm)
    setTake((prev) => {
      if (prev) {
        URL.revokeObjectURL(prev.webmUrl)
        if (prev.wavUrl) URL.revokeObjectURL(prev.wavUrl)
      }
      return {
        webmUrl,
        webmSize: webm.size,
        wavUrl: null,
        wavSize: 0,
        stamp: new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
        greenPct: stats.greenPct,
        avgDb: stats.avgDb,
        clips: stats.clips,
        wpm: minutes > 0 ? words / minutes : 0,
        wpmMethod: usedSpeech ? 'speech' : 'script',
        followed: t.followed,
        lines,
      }
    })
    // WAV conversion can take a moment on long takes; show the review first, add the link after.
    try {
      const wav = await eng.toWav(webm)
      const wavUrl = URL.createObjectURL(wav)
      setTake((cur) => (cur && cur.webmUrl === webmUrl ? { ...cur, wavUrl, wavSize: wav.size } : cur))
    } catch {
      /* decoding failed: webm only */
    }
  }, [phase, eng, source])

  // 10 Hz follow loop while recording.
  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => {
      const t = tracker.current
      if (!t) return
      const now = performance.now()
      const l = t.tick(now, eng.speaking, eng.levelDb)
      setLive(l)
      setElapsed(now - takeT0.current)
      eng.setBand(segments[l.cur]?.energy ?? 'normal')
      if (l.done && t.mode === 'speech' && now - t.lastAdvance > AUTO_STOP_MS) void stopTake()
    }, 100)
    return () => clearInterval(id)
  }, [phase, eng, segments, stopTake])

  // Keyboard: Space start/stop · Esc stop · R restart · ↑/↓ nudge. Ignored while typing.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable="true"]') !== null
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return
        if (phase === 'setup') void startTake()
        else void stopTake()
      } else if (e.key === 'Escape' && phase !== 'setup') {
        void stopTake()
      } else if ((e.key === 'r' || e.key === 'R') && phase === 'recording') {
        tracker.current?.start(performance.now())
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && phase === 'recording') {
        e.preventDefault()
        tracker.current?.nudge(e.key === 'ArrowDown' ? 1 : -1)
      }
    }
    // Stop Space from also "clicking" a focused button.
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing(e.target)) e.preventDefault()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [phase, startTake, stopTake])

  if (phase !== 'setup') {
    return <FocusView engine={eng} segments={segments} firstWord={firstWord} live={live} countdown={countdown} mode={mode} elapsedMs={elapsed} />
  }

  return (
    <SetupView
      engine={eng}
      script={script}
      onScript={setScript}
      segments={segments}
      source={source}
      onSource={setSource}
      started={started}
      error={audioError}
      levelPhase={levelPhase}
      levelResult={levelResult}
      micGainDb={micGainDb}
      onCheckLevel={checkLevel}
      claudeEnabled={claudeEnabled}
      directedBy={directedBy}
      directing={directing}
      notice={notice}
      onClaude={refineWithClaude}
      onStart={startTake}
      take={take}
    />
  )
}
