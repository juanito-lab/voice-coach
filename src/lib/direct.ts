import { cleanToken, longerPause, parseScript, type RawSegment } from './markup'
import type { Segment } from './types'

const SETUP_RE = /^(here'?s|imagine|picture this|let me|first,|for context)/i

function isList(text: string): boolean {
  return (text.match(/,/g) ?? []).length >= 2
}

/**
 * Heuristic director. Rules apply in order, later rules override earlier ones on the
 * same property, the longer pause always wins, and manual markup overrides everything.
 */
export function directSegments(raws: RawSegment[]): Segment[] {
  const n = raws.length
  return raws.map((r, i) => {
    const text = r.words.map((w) => w.text).join(' ')
    const seg: Segment = {
      text,
      pace: 'normal',
      energy: 'normal',
      pauseAfter: 'none',
      emphasis: r.words.filter((w) => w.emph).map((w) => cleanToken(w.text)),
      rising: false,
      source: 'auto',
    }
    // 2. lists and setup context → fast
    if (isList(text) || SETUP_RE.test(text)) seg.pace = 'fast'
    // 3. numbers / stats → slow + emphasis on the number token (with unit)
    const nums = r.words.map((w) => cleanToken(w.text)).filter((t) => /\d/.test(t))
    if (nums.length) {
      seg.pace = 'slow'
      seg.emphasis.push(...nums)
    }
    // 4. questions → rising + short pause
    if (/\?["'”’)\]]*$/.test(text)) {
      seg.rising = true
      seg.pauseAfter = longerPause(seg.pauseAfter, 'short')
    }
    // 5. hook → punch, normal pace unless a number made it slow
    if (i === 0) {
      seg.energy = 'punch'
      if (seg.pace !== 'slow') seg.pace = 'normal'
    }
    // 6. the line before the CTA → long pause
    if (n > 1 && i === n - 2) seg.pauseAfter = longerPause(seg.pauseAfter, 'long')
    // 7. last line / CTA → slow + punch
    if (i === n - 1) {
      seg.pace = 'slow'
      seg.energy = 'punch'
    }
    // 8. manual markup wins
    const first = r.words[0]
    let manual = false
    if (first?.pace) {
      seg.pace = first.pace
      manual = true
    }
    if (first?.energy) {
      seg.energy = first.energy
      manual = true
    }
    if (r.manualPause) {
      seg.pauseAfter = r.manualPause
      manual = true
    }
    if (r.words.some((w) => w.emph)) manual = true
    if (manual) seg.source = 'manual'
    seg.emphasis = [...new Set(seg.emphasis.filter(Boolean))]
    return seg
  })
}

export function directScript(script: string): Segment[] {
  return directSegments(parseScript(script))
}
