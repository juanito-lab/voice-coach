import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type SourceKind } from './audio/engine'
import { SpeechTracker, speechAvailable } from './audio/speech'
import { FocusView } from './components/FocusView'
import { SetupView, type LevelPhase } from './components/SetupView'
import { deviceKey, micNeedsReopen, type MicChoice } from './lib/devices'
import { directScript } from './lib/direct'
import { computeLevelCheck, type LevelCheck } from './lib/levelcheck'
import { buildSchedule } from './lib/prompter'
import { load, save, type MicCal, type Saved } from './lib/storage'
import { TakeTracker, type Live, type Mode } from './lib/take'
import { takeFileBase, type Take } from './lib/takes'
import { buildTiming, linesJson, prettyJson, type TimingInput } from './lib/timing'
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
  const [eng] = useState(() => new AudioEngine())
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
  const [levelPhase, setLevelPhase] = useState<LevelPhase>('idle')
  const [levelResult, setLevelResult] = useState<LevelCheck | null>(null)
  const checking = levelPhase === 'quiet' || levelPhase === 'speak'

  // Mic: the device the user picked (null = system default), what is open now, and level-check results per mic.
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [micChoice, setMicChoice] = useState<MicChoice | null>(saved?.mic ?? null)
  const [activeMic, setActiveMic] = useState<{ deviceId: string; label: string } | null>(null)
  const [micCal, setMicCal] = useState<Record<string, MicCal>>(saved?.micCal ?? {})
  const activeCal = activeMic ? (micCal[deviceKey(activeMic)] ?? null) : null
  const micGainDb = activeCal?.gainDb ?? null

  // Take
  const [phase, setPhase] = useState<Phase>('setup')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [mode, setMode] = useState<Mode>('timed')
  const [elapsed, setElapsed] = useState(0)
  // Every take of the session stays in memory (nothing is uploaded or persisted).
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTake, setSelectedTake] = useState<number | null>(null)
  const takeCount = useRef(0)
  const tracker = useRef<TakeTracker | null>(null)
  const takeT0 = useRef(0)
  const takeWall = useRef<Date | null>(null)
  const takeScript = useRef('')
  const speechError = useRef('')
  const timers = useRef<number[]>([])

  const firstWord = useMemo(() => buildSchedule(segments).segFirstWord, [segments])

  useEffect(() => save({ script, claude, mic: micChoice, micCal }), [script, claude, micChoice, micCal])

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

  const refreshDevices = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list)
      return list
    } catch {
      return []
    }
  }, [])

  const opening = useRef(false)
  const setSource = useCallback(
    async (kind: SourceKind, file?: File, mic: MicChoice | null = micChoice): Promise<boolean> => {
      setAudioError(null)
      opening.current = true
      const before = eng.micDevice
      try {
        await eng.setSource(kind, file, mic)
        // Gain comes from this mic's own level check (0 dB until it has one); test sources stay at unity so their levels read true.
        const dev = kind === 'mic' ? eng.micDevice : null
        const cal = dev ? micCal[deviceKey(dev)] : undefined
        eng.setGainDb(cal?.gainDb ?? 0)
        eng.setNoiseFloor(cal?.noiseFloor ?? null)
        if (!dev || !before || deviceKey(dev) !== deviceKey(before)) {
          setLevelResult(null)
          setLevelPhase('idle')
        }
        setActiveMic(dev)
        setSourceKind(kind)
        setStarted(true)
        if (kind === 'mic') void refreshDevices() // labels become readable once permission is granted
        return true
      } catch (err) {
        setAudioError(`Input failed: ${err instanceof Error ? err.message : err}`)
        return false
      } finally {
        opening.current = false
      }
    },
    [eng, micChoice, micCal, refreshDevices],
  )

  const chooseMic = (choice: MicChoice | null) => {
    setMicChoice(choice)
    if (started && source === 'mic') void setSource('mic', undefined, choice)
  }

  // Follow plugging and unplugging: back to the chosen mic when it returns, to the system default
  // when the open mic disappears. Never switches during a take or a level check.
  const latest = useRef({ started, source, phase: 'setup' as string, checking, micChoice, setSource })
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    md.enumerateDevices().then(setDevices, () => {})
    const onChange = async () => {
      const list = await refreshDevices()
      const s = latest.current
      if (!s.started || s.source !== 'mic' || s.phase !== 'setup' || s.checking || eng.recording || opening.current) return
      if (micNeedsReopen(list, s.micChoice, eng.micDevice, eng.micLive)) void s.setSource('mic')
    }
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [eng, refreshDevices])

  const checkLevel = async () => {
    if (source !== 'mic' || !(await setSource('mic'))) return
    const dev = eng.micDevice
    const prevGain = eng.gainDb
    eng.setGainDb(0)
    setLevelResult(null)
    setLevelPhase('quiet')
    const quiet = await eng.collect(3000)
    setLevelPhase('speak')
    const spoken = await eng.collect(5000)
    const res = computeLevelCheck(quiet, spoken)
    if (res.ok) {
      eng.setNoiseFloor(res.floorDb)
      if (dev) setMicCal((m) => ({ ...m, [deviceKey(dev)]: { gainDb: res.gainDb, noiseFloor: res.floorDb } }))
    }
    eng.setGainDb(res.ok ? res.gainDb : prevGain)
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
    // A take playing back through the speakers would bleed into the new recording.
    document.querySelectorAll('audio').forEach((a) => a.pause())
    const m: Mode = speechAvailable() ? 'speech' : 'timed'
    const t = new TakeTracker(segments, m)
    tracker.current = t
    takeScript.current = script
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
        takeWall.current = new Date()
        takeT0.current = performance.now()
        tracker.current?.start(takeT0.current)
        setPhase('recording')
      }, COUNTDOWN_STEP_MS * 3),
    ]
  }, [segments, started, setSource, source, eng, script])

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
    const rec = await eng.stopRecording()
    const { webm, stats } = rec
    const usedSpeech = t.mode === 'speech' && heardCount > 0
    // Only count words actually reached, so stopping early doesn't inflate the pace.
    const words = Math.round(t.followed * t.words.length)
    const minutes = (usedSpeech ? stats.speakingSec : stats.takeSec) / 60
    const lines = t.results()
    logTake({ source, mode: t.mode, speechError: speechError.current, heardCount, followed: t.followed, gainDb: eng.gainDb, noiseFloor: eng.noiseFloor, stats, lines })
    const n = ++takeCount.current
    const recordedAt = takeWall.current ?? new Date()
    // Word times on the recording's own clock. Measured in Chromium: the recorded audio starts at
    // MediaRecorder.start() (within ~10 ms), so the countdown and the earlier recognition start drop out
    // by subtracting the recorder's start time; the few ms it comes up short are lost at the end.
    const wordReach = t.wordTimes().map((x) => (x === null ? null : Math.max(0, (x - rec.startedAt) / 1000)))
    const wallSec = (rec.stoppedAt - rec.startedAt) / 1000
    const take: Take = {
      n,
      recordedAt,
      base: takeFileBase(recordedAt, n),
      webmUrl: URL.createObjectURL(webm),
      webmSize: webm.size,
      wavUrl: null,
      wavSize: 0,
      durationSec: stats.takeSec,
      greenPct: stats.greenPct,
      avgDb: stats.avgDb,
      clips: stats.clips,
      wpm: minutes > 0 ? words / minutes : 0,
      wpmMethod: usedSpeech ? 'speech' : 'script',
      followed: t.followed,
      lines,
      script: takeScript.current,
      segments: t.segments,
      mode: t.mode,
      status: 'measuring',
      analysis: null,
      timing: null,
      timingUrl: null,
      linesUrl: null,
    }
    setTakes((prev) => [...prev, take])
    setSelectedTake(n)
    const update = (patch: Partial<Take>) => setTakes((prev) => prev.map((x) => (x.n === n ? { ...x, ...patch } : x)))
    const timingFor = (a: { durationSec: number; sampleRate: number | null; regions: TimingInput['regions']; lufs: number | null; floor: number | null }) => {
      const timing = buildTiming({
        take: n,
        recordedAt,
        durationSec: a.durationSec,
        sampleRate: a.sampleRate,
        script: take.script,
        lines: take.segments.map((s) => s.text),
        tracking: t.mode,
        wordReach,
        regions: a.regions,
        stats: {
          integratedLufs: a.lufs,
          noiseFloorDb: a.floor,
          greenPct: take.greenPct,
          avgDb: take.avgDb,
          clippedPeaks: take.clips,
          wpm: take.wpm,
          followedPct: take.followed * 100,
        },
      })
      const json = (text: string) => URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      return { timing, timingUrl: json(prettyJson(timing) + '\n'), linesUrl: json(linesJson(timing)) }
    }
    // Decoding and measuring can take a moment on long takes; show the take first, add the numbers after.
    try {
      const { wav, analysis } = await eng.decode(webm)
      const a = analysis
      update({
        wavUrl: URL.createObjectURL(wav),
        wavSize: wav.size,
        durationSec: a.durationSec,
        analysis: a,
        status: 'ready',
        ...timingFor({ durationSec: a.durationSec, sampleRate: a.sampleRate, regions: a.regions, lufs: a.lufs, floor: a.noiseFloorDb }),
      })
    } catch {
      // Decoding failed: webm only, and timing from recognition alone.
      update({ status: 'failed', ...timingFor({ durationSec: wallSec, sampleRate: null, regions: null, lufs: null, floor: null }) })
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

  useEffect(() => {
    latest.current = { started, source, phase, checking, micChoice, setSource }
  })

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
      devices={devices}
      micChoice={micChoice}
      activeMic={activeMic}
      onMicChoice={chooseMic}
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
      takes={takes}
      selectedTake={selectedTake}
      onSelectTake={setSelectedTake}
    />
  )
}
