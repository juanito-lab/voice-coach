import { useEffect, useMemo, useRef } from 'react'
import { cleanToken } from '../lib/markup'
import { segmentWords } from '../lib/prompter'
import type { Segment } from '../lib/types'

interface Props {
  segments: Segment[]
  /** global index of the word being spoken; -1 when idle */
  pos: number
  /** extra manual scroll from ↑/↓ while idle */
  scrollNudge: number
}

export function Prompter({ segments, pos, scrollNudge }: Props) {
  const box = useRef<HTMLDivElement>(null)

  const layout = useMemo(() => {
    let g = 0
    return segments.map((seg) => {
      const emph = new Set(seg.emphasis.map((e) => e.toLowerCase()))
      const words = segmentWords(seg).map((w) => ({ w, i: g++, bold: emph.has(cleanToken(w).toLowerCase()) }))
      return { seg, words, first: words[0]?.i ?? 0, last: words[words.length - 1]?.i ?? 0 }
    })
  }, [segments])

  useEffect(() => {
    const el = box.current
    if (!el) return
    if (pos < 0) {
      el.scrollTo({ top: scrollNudge, behavior: 'smooth' })
      return
    }
    const target = el.querySelector<HTMLElement>(`[data-w="${Math.min(pos, Math.max(0, layout.at(-1)?.last ?? 0))}"]`)
    if (target) el.scrollTo({ top: target.offsetTop - el.clientHeight * 0.35, behavior: 'smooth' })
  }, [pos, layout, scrollNudge])

  if (!segments.length) return <div className="prompter empty">Paste a script and press “Direct it”.</div>

  return (
    <div className="prompter" ref={box} data-testid="prompter">
      {layout.map(({ seg, words, first, last }, si) => {
        const active = pos >= first && pos <= last
        const done = pos > last
        const tags = [
          seg.pace !== 'normal' && seg.pace.toUpperCase(),
          seg.energy === 'punch' && 'PUNCH',
          seg.energy === 'soft' && 'SOFT',
          seg.rising && '↗',
        ].filter(Boolean) as string[]
        return (
          <div
            key={si}
            className={`seg pace-${seg.pace} energy-${seg.energy} pause-${seg.pauseAfter}${active ? ' active' : ''}${done ? ' done' : ''}`}
            data-seg={si}
          >
            <div className="tags">
              {tags.map((t) => (
                <span key={t} className={`tag tag-${t === '↗' ? 'rise' : t.toLowerCase()}`}>
                  {t}
                </span>
              ))}
              {seg.source !== 'auto' && <span className="tag tag-src">{seg.source}</span>}
            </div>
            <p>
              {words.map(({ w, i, bold }) => (
                <span key={i} data-w={i} className={`w${i === pos ? ' now' : ''}${i < pos ? ' said' : ''}`}>
                  {bold ? <strong>{w}</strong> : w}{' '}
                </span>
              ))}
              {seg.pauseAfter !== 'none' && (
                <span className={`pause pause-mark-${seg.pauseAfter}`} title={seg.pauseAfter === 'long' ? '0.8 s' : '0.3 s'}>
                  {seg.pauseAfter === 'long' ? '‖‖' : '‖'}
                </span>
              )}
            </p>
          </div>
        )
      })}
    </div>
  )
}
