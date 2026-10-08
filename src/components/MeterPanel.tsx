import { useEffect, useRef, useState } from 'react'
import type { AudioEngine, SourceKind } from '../audio/engine'
import type { Energy } from '../lib/types'
import { ENERGY_BANDS } from '../lib/levels'

export interface Take {
  webmUrl: string
  webmSize: number
  wavUrl: string | null
  wavSize: number
  greenPct: number
  avgDb: number
  clips: number
  wpm: number
  wpmMethod: 'speech' | 'script'
  takeSec: number
  stamp: string
}

interface Props {
  engine: AudioEngine
  started: boolean
  source: SourceKind
  onSource: (kind: SourceKind, file?: File) => Promise<boolean>
  recording: boolean
  onToggleRecord: () => void
  take: Take | null
  energy: Energy
  error: string | null
}

const fmtDb = (db: number) => (db <= -99 ? '−∞' : db.toFixed(1).replace('-', '−'))
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`)

export function MeterPanel({ engine, started, source, onSource, recording, onToggleRecord, take, energy, error }: Props) {
  const meter = useRef<HTMLCanvasElement>(null)
  const history = useRef<HTMLCanvasElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLDivElement>(null)
  const peak = useRef<HTMLDivElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [calib, setCalib] = useState<{ busy: boolean; db: number | null }>({ busy: false, db: engine.noiseFloor })

  useEffect(() => {
    engine.setTargets({
      meter: meter.current,
      history: history.current,
      readout: readout.current,
      status: status.current,
      peak: peak.current,
    })
  }, [engine])

  const calibrate = async () => {
    if (!started) await onSource(source)
    setCalib({ busy: true, db: null })
    const db = await engine.calibrate()
    setCalib({ busy: false, db })
  }

  const [lo, hi] = ENERGY_BANDS[energy]

  return (
    <section className="left">
      <header className="panel-head">
        <h1>Voice Coach</h1>
        <label className="source">
          Input
          <select
            value={source}
            onChange={(e) => {
              const k = e.target.value as SourceKind
              if (k === 'file') fileInput.current?.click()
              else onSource(k)
            }}
          >
            <option value="mic">Microphone</option>
            <option value="tone-30">Simulate: tone −30 dBFS</option>
            <option value="tone-16">Simulate: tone −16 dBFS</option>
            <option value="tone-3">Simulate: tone −3 dBFS</option>
            <option value="file">Simulate: audio file…</option>
          </select>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onSource('file', f)
            }}
          />
        </label>
      </header>

      <div className="meter-row">
        <canvas ref={meter} className="meter" aria-label="Level meter" />
        <div className="readouts">
          <div ref={readout} className="readout" data-testid="readout">
            −∞
          </div>
          <div className="unit">dBFS RMS · 300 ms</div>
          <div ref={status} className="status" data-testid="status">
            —
          </div>
          <div ref={peak} className="peak" data-testid="peak">
            peak −∞ dBFS
          </div>
          <div className="band">
            target <b className={`energy-${energy}`}>{energy.toUpperCase()}</b>
            <br />
            {fmtDb(lo)} to {fmtDb(hi)} dBFS
          </div>
          {!started && (
            <button className="primary" onClick={() => onSource(source)}>
              Start input
            </button>
          )}
        </div>
      </div>

      <canvas ref={history} className="history" aria-label="10 second level history" />
      <div className="note">dBFS = relative to digital full scale, not dB SPL. 10 s history.</div>
      {error && <div className="warn">{error}</div>}

      <div className="controls">
        <button className={recording ? 'rec on' : 'rec'} onClick={onToggleRecord} title="Space">
          {recording ? '■ Stop' : '● Record'}
        </button>
        <button disabled={!take || recording} onClick={() => audio.current?.play()}>
          ▶ Play
        </button>
        <button onClick={calibrate} disabled={calib.busy || recording}>
          {calib.busy ? 'Listening… stay quiet' : 'Calibrate'}
        </button>
      </div>
      {calib.db !== null && (
        <div className={calib.db > -50 ? 'warn' : 'ok'}>
          Noise floor {fmtDb(calib.db)} dBFS
          {calib.db > -50 ? ' — too noisy (above −50). Find a quieter room or move closer to the mic.' : ' — good.'}
        </div>
      )}

      {take && (
        <div className="take">
          <audio ref={audio} src={take.webmUrl} controls />
          <div className="downloads">
            <a href={take.webmUrl} download={`voice-coach-${take.stamp}.webm`} data-testid="dl-webm">
              ⬇ .webm ({fmtSize(take.webmSize)})
            </a>
            {take.wavUrl && (
              <a href={take.wavUrl} download={`voice-coach-${take.stamp}.wav`} data-testid="dl-wav">
                ⬇ .wav ({fmtSize(take.wavSize)})
              </a>
            )}
          </div>
          <div className="summary" data-testid="summary">
            <div>
              <b>{take.greenPct.toFixed(0)}%</b>
              <span>in green</span>
            </div>
            <div>
              <b>{fmtDb(take.avgDb)}</b>
              <span>avg dBFS</span>
            </div>
            <div>
              <b>{take.clips}</b>
              <span>clipped peaks</span>
            </div>
            <div>
              <b>{Math.round(take.wpm)}</b>
              <span>wpm ({take.wpmMethod === 'speech' ? 'recognised words' : 'script estimate'})</span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
