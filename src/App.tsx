import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type SourceKind } from './audio/engine'
import { SpeechTracker, speechAvailable } from './audio/speech'
import { MeterPanel, type Take } from './components/MeterPanel'
import { Prompter } from './components/Prompter'
import { directScript } from './lib/direct'
import { matchPosition } from './lib/matcher'
import { buildSchedule, scriptWordList, wordAtTime } from './lib/prompter'
import { load, save } from './lib/storage'
import { PACE_WPM, validateSegments, type Energy, type Segment } from './lib/types'

const SAMPLE =
  "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."

const WPM_WINDOW_MS = 5000
const NUDGE_MS = 1000

type Mode = 'speech' | 'timed'
type PaceCall = 'SPEED UP' | 'ON PACE' | 'SLOW DOWN' | '—'

function paceCall(live: number | null, target: number): PaceCall {
  if (live === null) return '—'
  if (live < target * 0.85) return 'SPEED UP'
  if (live > target * 1.15) return 'SLOW DOWN'
  return 'ON PACE'
}

const saved = load()

export default function App() {
  const [eng] = useState(() => new AudioEngine())
  const engine = useRef(eng)
  const tracker = useRef(new SpeechTracker())

  const [script, setScript] = useState(saved?.script || SAMPLE)
  const [segments, setSegments] = useState<Segment[]>(saved?.segments ?? [])
  const [useClaude, setUseClaude] = useState(saved?.useClaude ?? false)
  const [claudeEnabled, setClaudeEnabled] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [directing, setDirecting] = useState(false)

  const [started, setStarted] = useState(false)
  const [source, setSourceKind] = useState<SourceKind>('mic')
  const [audioError, setAudioError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [take, setTake] = useState<Take | null>(null)

  const [pos, setPos] = useState(-1)
  const [mode, setMode] = useState<Mode>(speechAvailable() ? 'speech' : 'timed')
  const [liveWpm, setLiveWpm] = useState<number | null>(null)
  const [idleScroll, setIdleScroll] = useState(0)

  const schedule = useMemo(() => buildSchedule(segments), [segments])
  const scriptWords = useMemo(() => scriptWordList(segments), [segments])

  // Mutable run state for the prompter; read by the 10 Hz loop, never rendered directly.
  const run = useRef({ start: 0, offset: 0, heard: [] as string[], heardBase: 0, heardTimes: [] as number[], nudge: 0, mode: 'timed' as Mode })

  useEffect(() => save({ script, segments, useClaude }), [script, segments, useClaude])

  useEffect(() => {
    fetch('/api/direct')
      .then((r) => r.json())
      .then((j: { enabled?: boolean }) => setClaudeEnabled(Boolean(j.enabled)))
      .catch(() => setClaudeEnabled(false))
  }, [])

  const direct = async () => {
    setNotice(null)
    if (useClaude && claudeEnabled) {
      setDirecting(true)
      try {
        const r = await fetch('/api/direct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script }) })
        const j = await r.json()
        const segs = r.ok ? validateSegments(j.segments, 'claude') : null
        if (!segs) throw new Error(j.error ?? 'invalid response')
        setSegments(segs)
        setNotice('Directed by Claude.')
      } catch (err) {
        setSegments(directScript(script))
        setNotice(`Claude failed (${err instanceof Error ? err.message : err}) — fell back to heuristics.`)
      } finally {
        setDirecting(false)
      }
    } else {
      setSegments(directScript(script))
    }
    setIdleScroll(0)
  }

  const setSource = useCallback(async (kind: SourceKind, file?: File): Promise<boolean> => {
    setAudioError(null)
    try {
      await engine.current.setSource(kind, file)
      setSourceKind(kind)
      setStarted(true)
      return true
    } catch (err) {
      setAudioError(`Input failed: ${err instanceof Error ? err.message : err}. Try a Simulate input.`)
      return false
    }
  }, [])

  const restartPrompter = useCallback(() => {
    const r = run.current
    r.start = performance.now()
    r.offset = 0
    r.nudge = 0
    r.heardBase = r.heard.length
  }, [])

  const toggleRecord = useCallback(async () => {
    const eng = engine.current
    if (eng.recording) {
      const heardCount = tracker.current.stop()
      const { webm, stats } = await eng.stopRecording()
      setRecording(false)
      setPos(-1)
      setLiveWpm(null)
      eng.setBand('normal')
      let wavUrl: string | null = null
      let wavSize = 0
      try {
        const wav = await eng.toWav(webm)
        wavUrl = URL.createObjectURL(wav)
        wavSize = wav.size
      } catch {
        /* decoding failed: webm only */
      }
      const usedSpeech = run.current.mode === 'speech' && heardCount > 0
      const words = usedSpeech ? heardCount : scriptWords.length
      const minutes = (usedSpeech ? stats.speakingSec : stats.takeSec) / 60
      setTake((prev) => {
        if (prev) {
          URL.revokeObjectURL(prev.webmUrl)
          if (prev.wavUrl) URL.revokeObjectURL(prev.wavUrl)
        }
        return {
          webmUrl: URL.createObjectURL(webm),
          webmSize: webm.size,
          wavUrl,
          wavSize,
          greenPct: stats.greenPct,
          avgDb: stats.avgDb,
          clips: stats.clips,
          wpm: minutes > 0 ? words / minutes : 0,
          wpmMethod: usedSpeech ? 'speech' : 'script',
          takeSec: stats.takeSec,
          stamp: new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
        }
      })
      return
    }
    if (!started && !(await setSource(source))) return
    eng.startRecording()
    const r = run.current
    r.heard = []
    r.heardTimes = []
    r.heardBase = 0
    r.mode = speechAvailable() ? 'speech' : 'timed'
    setMode(r.mode)
    restartPrompter()
    if (r.mode === 'speech') {
      tracker.current.start(
        (words) => {
          const now = performance.now()
          for (let k = r.heard.length; k < words.length; k++) r.heardTimes.push(now)
          r.heard = words
        },
        () => {
          r.mode = 'timed'
          setMode('timed')
        },
      )
    }
    setRecording(true)
  }, [started, source, setSource, restartPrompter, scriptWords.length])

  // 10 Hz prompter loop while recording.
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => {
      const r = run.current
      const now = performance.now()
      const n = scriptWords.length
      let p: number
      if (r.mode === 'speech') {
        p = matchPosition(scriptWords, 0, r.heard.slice(r.heardBase)) + r.nudge
      } else {
        p = wordAtTime(schedule, now - r.start + r.offset)
      }
      p = Math.max(0, Math.min(n, p))
      setPos(p)
      const seg = segments[schedule.wordSeg[Math.min(p, n - 1)]]
      if (seg) engine.current.setBand(seg.energy)
      while (r.heardTimes.length && now - r.heardTimes[0] > WPM_WINDOW_MS) r.heardTimes.shift()
      setLiveWpm(r.mode === 'speech' && r.heardTimes.length ? (r.heardTimes.length * 60000) / WPM_WINDOW_MS : null)
    }, 100)
    return () => clearInterval(id)
  }, [recording, schedule, scriptWords, segments])

  // Keyboard shortcuts — ignored while typing.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.closest('input, textarea, select, [contenteditable="true"]') !== null)
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) void toggleRecord()
      } else if (e.key === 'r' || e.key === 'R') {
        restartPrompter()
        setIdleScroll(0)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        const r = run.current
        if (!recording) setIdleScroll((s) => Math.max(0, s + dir * 80))
        else if (r.mode === 'speech') r.nudge += dir
        else r.offset += dir * NUDGE_MS
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
  }, [toggleRecord, restartPrompter, recording])

  const curSeg = recording && pos >= 0 ? segments[schedule.wordSeg[Math.min(pos, scriptWords.length - 1)]] : undefined
  const energy: Energy = curSeg?.energy ?? 'normal'
  const target = curSeg ? PACE_WPM[curSeg.pace] : null
  const call = target ? paceCall(liveWpm, target) : '—'

  return (
    <div className="app">
      <MeterPanel
        engine={eng}
        started={started}
        source={source}
        onSource={setSource}
        recording={recording}
        onToggleRecord={toggleRecord}
        take={take}
        energy={energy}
        error={audioError}
      />
      <section className="right">
        {!recording && (
          <div className="editor">
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
              placeholder="Paste your script…"
              aria-label="Script"
            />
            <div className="editor-bar">
              <button className="primary" onClick={direct} disabled={directing || !script.trim()}>
                {directing ? 'Directing…' : 'Direct it'}
              </button>
              {claudeEnabled && (
                <label className="toggle">
                  <input type="checkbox" checked={useClaude} onChange={(e) => setUseClaude(e.target.checked)} /> Direct with Claude
                </label>
              )}
              {notice && <span className="notice">{notice}</span>}
            </div>
            <div className="legend">
              <code>[slow]…[/slow]</code> <code>[fast]…[/fast]</code> <code>[loud]…[/loud]</code> <code>[soft]…[/soft]</code>{' '}
              <code>*emphasis*</code> <code>/</code> short pause <code>//</code> long pause
              <span className="keys">
                <kbd>Space</kbd> record/stop <kbd>R</kbd> restart <kbd>↑</kbd>
                <kbd>↓</kbd> nudge
              </span>
              <span className="colors">
                <i className="c-slow">slow 120</i> <i className="c-normal">normal 150</i> <i className="c-fast">fast 180 wpm</i>
              </span>
            </div>
          </div>
        )}
        <div className="pacebar">
          <span className={`mode mode-${mode}`}>{mode === 'speech' ? 'speech tracking' : 'timed mode'}</span>
          {recording ? (
            <>
              <span>
                live <b>{liveWpm === null ? '—' : Math.round(liveWpm)}</b> wpm
              </span>
              <span>
                target <b>{target ?? '—'}</b>
              </span>
              <span className={`call call-${call.replace(' ', '-').toLowerCase()}`} data-testid="pace-call">
                {call}
              </span>
            </>
          ) : (
            <span className="hint">Press Space to record — the prompter follows you.</span>
          )}
        </div>
        <Prompter segments={segments} pos={recording ? pos : -1} scrollNudge={idleScroll} />
      </section>
    </div>
  )
}
