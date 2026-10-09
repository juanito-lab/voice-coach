import { useEffect, useRef, useState } from 'react'
import { BEST, fmtDuration, pickBest, scoreOf, takeIssues, type Take } from '../lib/takes'

const num = (x: number, digits = 0) => x.toFixed(digits).replace('-', '−')
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`)
const MAX_SUGGESTED = 3

interface Props {
  takes: Take[]
  selected: number | null
  onSelect: (n: number) => void
}

export function TakesPanel({ takes, selected, onSelect }: Props) {
  const player = useRef<HTMLAudioElement>(null)
  const playNext = useRef<number | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const best = pickBest(takes.map(scoreOf))
  const sel = takes.find((t) => t.n === selected) ?? takes[takes.length - 1]

  // Selecting another take swaps the player's source; start it once the new source is in.
  useEffect(() => {
    if (sel && playNext.current === sel.n) {
      playNext.current = null
      void player.current?.play().catch(() => {})
    }
  }, [sel])

  if (!sel) return null
  const issues = takeIssues(scoreOf(sel))
  const measuring = takes.some((t) => t.status === 'measuring')

  const play = (n: number) => {
    const a = player.current
    if (!a) return
    if (n === sel.n) {
      if (a.paused) void a.play().catch(() => {})
      else a.pause()
    } else {
      playNext.current = n
      onSelect(n)
    }
  }

  return (
    <div className="card takes" data-testid="summary">
      <div className="takes-head">
        <h2>Takes</h2>
        <span className="hint">
          {takes.length >= MAX_SUGGESTED
            ? `That's ${takes.length}. Pick one: another take rarely beats the best of three.`
            : `Record up to ${MAX_SUGGESTED}, then pick by the numbers and by ear.`}
        </span>
      </div>
      <div className="takes-scroll">
        <table className="takes-table">
          <thead>
            <tr>
              <th scope="col">Take</th>
              <th scope="col">Length</th>
              <th scope="col" title="Integrated loudness (BS.1770) of the file">
                Loudness
              </th>
              <th scope="col" title="Quietest 10% of the take, dBFS RMS">
                Noise floor
              </th>
              <th scope="col">In green</th>
              <th scope="col">Clipped</th>
              <th scope="col">Pace</th>
              <th scope="col">
                <span className="sr-only">Play and download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {takes.map((t) => {
              const a = t.analysis
              const isBest = best === t.n
              const lufsOff = a?.lufs != null && Math.abs(a.lufs - BEST.targetLufs) > BEST.maxLufsOff
              const noisy = a?.noiseFloorDb != null && a.noiseFloorDb > BEST.maxNoiseFloorDb
              const pending = t.status === 'measuring' ? '…' : '—'
              return (
                <tr key={t.n} className={`${t.n === sel.n ? 'sel' : ''}${isBest ? ' best' : ''}`}>
                  <th scope="row">
                    <button className="take-n" aria-pressed={t.n === sel.n} onClick={() => onSelect(t.n)} title={`Show take ${t.n}`}>
                      {isBest && (
                        <span className="star" role="img" aria-label="Best take">
                          ★
                        </span>
                      )}
                      {t.n}
                    </button>
                  </th>
                  <td>{fmtDuration(t.durationSec)}</td>
                  <td className={lufsOff ? 't-behind' : ''}>{a?.lufs != null ? `${num(a.lufs, 1)} LUFS` : pending}</td>
                  <td className={noisy ? 't-behind' : ''}>{a?.noiseFloorDb != null ? `${num(a.noiseFloorDb)} dB` : pending}</td>
                  <td className={t.greenPct >= 70 ? 't-on' : 't-behind'}>{num(t.greenPct)}%</td>
                  <td className={t.clips ? 't-hot' : ''}>{t.clips}</td>
                  <td>
                    {Math.round(t.wpm)} wpm{t.wpmMethod === 'script' ? ' (est.)' : ''}
                  </td>
                  <td>
                    <div className="take-dl">
                      <button className="icon" onClick={() => play(t.n)} aria-label={`${playing === t.n ? 'Pause' : 'Play'} take ${t.n}`}>
                        {playing === t.n ? '❚❚' : '▶'}
                      </button>
                      <a href={t.webmUrl} download={`${t.base}.webm`} title={`Opus, ${fmtSize(t.webmSize)}`}>
                        webm
                      </a>
                      {t.wavUrl ? (
                        <a href={t.wavUrl} download={`${t.base}.wav`} title={`16-bit PCM, ${fmtSize(t.wavSize)}`}>
                          wav
                        </a>
                      ) : (
                        <span className="dl-wait" title={t.status === 'failed' ? 'This browser could not decode the take' : 'Converting…'}>
                          wav
                        </span>
                      )}
                      {t.timingUrl && t.linesUrl ? (
                        <>
                          <a href={t.timingUrl} download={`${t.base}.json`} title="Line and word times, chunks and stats (.json)" aria-label={`Download timing of take ${t.n} (.json)`}>
                            timing
                          </a>
                          <a href={t.linesUrl} download={`${t.base}.lines.json`} title="Just the chunks: lines.json for voice_assemble.py" aria-label={`Download lines.json of take ${t.n}`}>
                            lines
                          </a>
                        </>
                      ) : (
                        <span className="dl-wait" title="Measuring…">
                          timing
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <audio
        ref={player}
        src={sel.webmUrl}
        controls
        aria-label={`Take ${sel.n}`}
        onPlay={() => setPlaying(sel.n)}
        onPause={() => setPlaying(null)}
        onEnded={() => setPlaying(null)}
        onEmptied={() => setPlaying(null)}
      />
      {sel.followed < 0.9 && sel.wpmMethod === 'speech' && (
        <div className="warn">Voice tracking followed {Math.round(sel.followed * 100)}% of the script.</div>
      )}
      {sel.timing && sel.timing.notes.length > 0 && (
        <ul className="timing-notes" aria-label={`Timing notes for take ${sel.n}`}>
          {sel.timing.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {issues.length > 0 && !measuring && (
        <div className="warn">
          Take {sel.n} fails: {issues.join(' · ')}.{best === null && takes.length > 1 ? ' No take passes every check yet.' : ''}
        </div>
      )}
      <div className="hint">
        <span className="star" aria-hidden="true">
          ★
        </span>
        best by the numbers: no clipped peaks, noise floor ≤ {num(BEST.maxNoiseFloorDb)} dBFS, loudness within ±{BEST.maxLufsOff} LU of {num(BEST.targetLufs)}{' '}
        LUFS and at least {BEST.minFollowed * 100}% of the script. Of those, the most time in the green wins; within {BEST.greenTiePts} points, the loudness
        closest to {num(BEST.targetLufs)} LUFS. Then trust your ear.
      </div>
    </div>
  )
}
