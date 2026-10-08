import { useEffect, useRef } from 'react'
import type { AudioEngine, SourceKind } from '../audio/engine'
import type { LevelCheck } from '../lib/levelcheck'
import { cleanToken } from '../lib/markup'
import { segmentWords } from '../lib/prompter'
import type { LineResult } from '../lib/take'
import { PACE_WPM, type Segment } from '../lib/types'

export interface TakeResult {
  webmUrl: string
  webmSize: number
  wavUrl: string | null
  wavSize: number
  stamp: string
  greenPct: number
  avgDb: number
  clips: number
  wpm: number
  wpmMethod: 'speech' | 'script'
  followed: number
  lines: LineResult[]
}

export type LevelPhase = 'idle' | 'quiet' | 'speak' | 'done'

interface Props {
  engine: AudioEngine
  script: string
  onScript: (s: string) => void
  segments: Segment[]
  source: SourceKind
  onSource: (k: SourceKind, f?: File) => void
  started: boolean
  error: string | null
  levelPhase: LevelPhase
  levelResult: LevelCheck | null
  micGainDb: number | null
  onCheckLevel: () => void
  claudeEnabled: boolean
  directedBy: 'auto' | 'claude'
  directing: boolean
  notice: string | null
  onClaude: () => void
  onStart: () => void
  take: TakeResult | null
}

const fmtDb = (db: number) => (db <= -99 ? '−∞' : db.toFixed(0).replace('-', '−'))
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`)

export function SetupView(p: Props) {
  const meter = useRef<HTMLCanvasElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const { engine } = p

  useEffect(() => {
    engine.setTargets({ meter: meter.current, readout: readout.current, status: status.current })
    return () => engine.setTargets({})
  }, [engine])

  const firstLine = p.segments[0]?.text ?? 'Testing, one, two, three — this is my voiceover level.'

  return (
    <div className="setup">
      <header className="topbar">
        <h1>Voice Coach</h1>
        <select
          value={p.source}
          aria-label="Input"
          onChange={(e) => {
            const k = e.target.value as SourceKind
            if (k === 'file') fileInput.current?.click()
            else p.onSource(k)
          }}
        >
          <option value="mic">Microphone</option>
          <option value="tone-30">Test tone −30 dBFS</option>
          <option value="tone-16">Test tone −16 dBFS</option>
          <option value="tone-3">Test tone −3 dBFS</option>
          <option value="file">Test with audio file…</option>
        </select>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) p.onSource('file', f)
          }}
        />
        <div className="spacer" />
        <button className="start" onClick={p.onStart} disabled={!p.segments.length || p.levelPhase === 'quiet' || p.levelPhase === 'speak'}>
          ● Start take <kbd>Space</kbd>
        </button>
      </header>

      <div className="setup-grid">
        <aside className="col-left">
          <section className="card level">
            <div className="level-row">
              <canvas ref={meter} className="meter" aria-label="Level meter" />
              <div className="level-read">
                <div ref={readout} className="readout" data-testid="readout">
                  −∞
                </div>
                <div className="unit">dBFS</div>
                <div ref={status} className="status" data-testid="status">
                  —
                </div>
                {!p.started && (
                  <button onClick={() => p.onSource(p.source)} className="ghost">
                    Turn on input
                  </button>
                )}
              </div>
            </div>

            {p.source === 'mic' && (
              <div className="check">
                {p.levelPhase === 'quiet' && <div className="check-step">Stay quiet…</div>}
                {p.levelPhase === 'speak' && (
                  <div className="check-step">
                    Read aloud, like the real take:
                    <q>{firstLine}</q>
                    <div className="progress" />
                  </div>
                )}
                {(p.levelPhase === 'idle' || p.levelPhase === 'done') && (
                  <>
                    {p.levelResult && <div className={p.levelResult.ok && p.levelResult.floorDb <= -50 ? 'ok' : 'warn'}>{p.levelResult.message}</div>}
                    <div className="check-row">
                      <button onClick={p.onCheckLevel}>{p.micGainDb === null ? 'Check level' : 'Re-check level'}</button>
                      {p.micGainDb !== null && <span className="chip">mic gain +{p.micGainDb} dB</span>}
                    </div>
                    {p.micGainDb === null && <div className="hint">8 s. Sets your mic so a normal read lands in the green.</div>}
                  </>
                )}
              </div>
            )}
            {p.error && <div className="warn">{p.error}</div>}
          </section>

          <section className="card script">
            <textarea value={p.script} onChange={(e) => p.onScript(e.target.value)} spellCheck={false} placeholder="Paste your script…" aria-label="Script" />
            <div className="script-bar">
              <span className="by">{p.directedBy === 'claude' ? 'Directed by Claude' : 'Auto-directed'}</span>
              {p.claudeEnabled && (
                <button className="ghost" onClick={p.onClaude} disabled={p.directing || !p.script.trim()}>
                  {p.directing ? 'Asking Claude…' : 'Refine with Claude'}
                </button>
              )}
            </div>
            {p.notice && <div className="notice">{p.notice}</div>}
            <details>
              <summary>Markup</summary>
              <div className="legend">
                <code>[slow]…[/slow]</code> <code>[fast]…[/fast]</code> <code>[loud]…[/loud]</code> <code>[soft]…[/soft]</code> <code>*emphasis*</code>{' '}
                <code>/</code> short pause <code>//</code> long pause
              </div>
            </details>
          </section>
        </aside>

        <main className="col-right">
          {p.take ? <TakeCard take={p.take} /> : <Signals />}
          <ol className="lines" data-testid="lines">
            {p.segments.map((seg, i) => (
              <LineRow key={i} seg={seg} result={p.take?.lines[i] ?? null} />
            ))}
          </ol>
        </main>
      </div>
    </div>
  )
}

function Signals() {
  return (
    <div className="card signals">
      <div className="signals-title">While you record, watch one line. Three signals:</div>
      <div className="signal">
        <span className="demo-words">
          <span className="said">every</span> <span className="said">rental</span> car
        </span>
        Words light up as you say them.
      </div>
      <div className="signal">
        <span className="demo-bars">
          <i className="b-on" />
          <i className="b-ahead" />
          <i className="b-behind" />
        </span>
        The bar under the words moves at the target pace. <b className="t-on">Green</b> on pace · <b className="t-ahead">blue</b> rushing ·{' '}
        <b className="t-behind">amber</b> dragging.
      </div>
      <div className="signal">
        <span className="demo-ring" />A draining ring before a line means hold the pause.
      </div>
      <div className="signal">
        <span className="demo-meter" />
        The slim bar on the left is your level. Stay inside the green bracket.
      </div>
    </div>
  )
}

function TakeCard({ take }: { take: TakeResult }) {
  return (
    <div className="card takecard" data-testid="summary">
      <div className="stats">
        <div>
          <b className={take.greenPct >= 70 ? 't-on' : 't-behind'}>{take.greenPct.toFixed(0)}%</b>
          <span>in the green</span>
        </div>
        <div>
          <b>{fmtDb(take.avgDb)}</b>
          <span>avg dBFS</span>
        </div>
        <div>
          <b className={take.clips ? 't-hot' : ''}>{take.clips}</b>
          <span>clipped</span>
        </div>
        <div>
          <b>{Math.round(take.wpm)}</b>
          <span>wpm{take.wpmMethod === 'script' ? ' (est.)' : ''}</span>
        </div>
      </div>
      <div className="take-actions">
        <audio src={take.webmUrl} controls />
        <a href={take.webmUrl} download={`voice-coach-${take.stamp}.webm`}>
          .webm {fmtSize(take.webmSize)}
        </a>
        {take.wavUrl && (
          <a href={take.wavUrl} download={`voice-coach-${take.stamp}.wav`}>
            .wav {fmtSize(take.wavSize)}
          </a>
        )}
      </div>
      {take.followed < 0.9 && take.wpmMethod === 'speech' && (
        <div className="warn">Voice tracking followed {Math.round(take.followed * 100)}% of the script.</div>
      )}
    </div>
  )
}

function LineRow({ seg, result }: { seg: Segment; result: LineResult | null }) {
  const emph = new Set(seg.emphasis.map((e) => e.toLowerCase()))
  const tags = [seg.pace !== 'normal' && seg.pace.toUpperCase(), seg.energy === 'punch' && 'PUNCH', seg.energy === 'soft' && 'SOFT', seg.rising && '↗'].filter(
    Boolean,
  ) as string[]
  return (
    <li className={`line pace-color-${seg.pace} pause-${seg.pauseAfter}`}>
      <div className="line-meta">
        {tags.map((t) => (
          <span key={t} className={`tag tag-${t === '↗' ? 'rise' : t.toLowerCase()}`}>
            {t}
          </span>
        ))}
        {result && (
          <>
            {result.pace && (
              <span className={`res res-pace-${result.pace}`} title={`target ${PACE_WPM[seg.pace]} wpm`}>
                {result.pace === 'on' ? '●' : result.pace === 'fast' ? '▲' : '▼'} {Math.round(result.wpm!)} wpm
              </span>
            )}
            {result.level && result.levelDb !== null && (
              <span className={`res res-level-${result.level}`}>
                {result.level === 'good' ? '●' : result.level === 'quiet' ? '▼' : '▲'} {fmtDb(result.levelDb)} dB
              </span>
            )}
          </>
        )}
      </div>
      <p>
        {segmentWords(seg).map((w, i) => (
          <span key={i}>{emph.has(cleanToken(w).toLowerCase()) ? <strong>{w}</strong> : w} </span>
        ))}
        {seg.pauseAfter !== 'none' && <span className="pause">{seg.pauseAfter === 'long' ? '‖‖' : '‖'}</span>}
      </p>
    </li>
  )
}
