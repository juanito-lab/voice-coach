import { useEffect, useMemo, useRef } from 'react'
import type { AudioEngine } from '../audio/engine'
import { cleanToken } from '../lib/markup'
import { segmentWords } from '../lib/prompter'
import type { Live, Mode } from '../lib/take'
import type { Segment } from '../lib/types'

interface Props {
  engine: AudioEngine
  segments: Segment[]
  firstWord: number[]
  live: Live | null
  countdown: number | null
  mode: Mode
  elapsedMs: number
}

function tagsFor(seg: Segment): string[] {
  return [
    seg.pace === 'slow' && 'SLOW',
    seg.pace === 'fast' && 'FAST',
    seg.energy === 'punch' && 'PUNCH',
    seg.energy === 'soft' && 'SOFT',
    seg.rising && '↗',
  ].filter(Boolean) as string[]
}

/**
 * Recording screen: one line in focus. Signals instead of words —
 *  · words light up as you say them
 *  · the bar under the words moves at the target pace (green on pace, blue rushing, amber dragging)
 *  · the slim bar on the left is your level against this line's target band
 *  · a draining ring means "hold the pause"
 */
export function FocusView({ engine, segments, firstWord, live, countdown, mode, elapsedMs }: Props) {
  const meter = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    engine.setTargets({ meter: meter.current })
    return () => engine.setTargets({})
  }, [engine])

  const cur = live?.cur ?? 0
  const seg = segments[cur]
  const prev = cur > 0 ? segments[cur - 1] : null
  const next = segments[cur + 1] ?? null
  const first = firstWord[cur] ?? 0
  const words = useMemo(() => (seg ? segmentWords(seg) : []), [seg])
  const emph = useMemo(() => new Set(seg?.emphasis.map((e) => e.toLowerCase()) ?? []), [seg])
  const spoken = live ? live.pos - first : 0
  const holding = (live?.hold ?? 0) > 0
  const done = live?.done ?? false
  const pace = live?.pace ?? 'idle'
  const secs = Math.floor(elapsedMs / 1000)

  return (
    <div className="focus">
      <div className="focus-top">
        <span className="rec-dot" /> {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        {mode === 'timed' && <span className="timed">timed</span>}
      </div>

      <div className="stage">
        <p className="line-prev">{countdown === null && prev ? prev.text : ' '}</p>

        <div className="line-row">
          <canvas ref={meter} className="slim-meter" aria-label="Level" />
          <div className={`line-cur pace-${pace}${holding ? ' holding' : ''}`} data-testid="focus-line">
            {countdown !== null ? (
              <div className="countdown">{countdown}</div>
            ) : done ? (
              <div className="finished">✓</div>
            ) : (
              <>
                <div className="tags">
                  {holding && (
                    <svg className="hold-ring" viewBox="0 0 36 36" aria-label="Hold">
                      <circle cx="18" cy="18" r="15" pathLength={1} style={{ strokeDashoffset: 1 - (live?.hold ?? 0) }} />
                    </svg>
                  )}
                  {seg && tagsFor(seg).map((t) => (
                    <span key={t} className={`tag tag-${t === '↗' ? 'rise' : t.toLowerCase()}`}>
                      {t}
                    </span>
                  ))}
                </div>
                <p className={`words pace-color-${seg?.pace}`}>
                  {words.map((w, i) => {
                    const said = i < spoken
                    const paced = live ? i < live.pacer : false
                    const bold = emph.has(cleanToken(w).toLowerCase())
                    return (
                      <span key={i} className={`w${said ? ' said' : ''}${paced ? ' paced' : ''}${bold ? ' em' : ''}`}>
                        {w}
                      </span>
                    )
                  })}
                </p>
              </>
            )}
          </div>
        </div>

        <p className="line-next">{countdown === null && next ? next.text : ' '}</p>
      </div>

      <div className="focus-bottom">
        {done ? 'Space to finish' : countdown !== null ? 'Get ready · Space to cancel' : 'Space to stop'}
      </div>
    </div>
  )
}
