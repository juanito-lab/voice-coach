import type { Energy, Pace, Pause } from './types'

export interface WordTok {
  text: string
  pace?: Pace
  energy?: Energy
  emph: boolean
}

/** A clause/sentence before direction is applied, carrying any manual markup. */
export interface RawSegment {
  words: WordTok[]
  manualPause?: Pause
}

const TAG_RE = /(\[\/?(?:slow|fast|loud|soft)\])/i
const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/
const CLAUSE_END_RE = /[;—–]$/
const LONG_SENTENCE_WORDS = 20

export function longerPause(a: Pause, b: Pause): Pause {
  const rank: Record<Pause, number> = { none: 0, short: 1, long: 2 }
  return rank[a] >= rank[b] ? a : b
}

/** Split sentences over 20 words at ; and — so each line stays readable. */
function splitLong(words: WordTok[]): WordTok[][] {
  if (words.length <= LONG_SENTENCE_WORDS) return [words]
  const out: WordTok[][] = []
  let cur: WordTok[] = []
  for (const w of words) {
    if ((w.text === '—' || w.text === '–') && cur.length) {
      cur.push(w)
      out.push(cur)
      cur = []
      continue
    }
    cur.push(w)
    if (CLAUSE_END_RE.test(w.text)) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * Parse script text with inline markup into raw segments.
 * Markup: [slow]…[/slow] [fast]…[/fast] [loud]…[/loud] [soft]…[/soft] *emphasis* / (short pause) // (long pause)
 * Segments break at sentence ends, pause markers and wherever the pace/energy tags change.
 */
export function parseScript(script: string): RawSegment[] {
  const segs: RawSegment[] = []
  let cur: WordTok[] = []
  let pace: Pace | undefined
  let energy: Energy | undefined
  let emphOpen = false

  const close = (pause?: Pause) => {
    if (cur.length) {
      const parts = splitLong(cur)
      parts.forEach((words, i) => segs.push({ words, manualPause: i === parts.length - 1 ? pause : undefined }))
      cur = []
    } else if (pause && segs.length) {
      const last = segs[segs.length - 1]
      last.manualPause = longerPause(last.manualPause ?? 'none', pause)
    }
  }

  const pushWord = (raw: string) => {
    let text = raw
    let emph = emphOpen
    if (text.startsWith('*')) {
      emphOpen = true
      emph = true
      text = text.replace(/^\*+/, '')
    }
    if (/\*+[^\p{L}\p{N}]*$/u.test(text)) {
      // closing asterisk, possibly followed by punctuation: "*now*." -> "now."
      text = text.replace(/\*+([^\p{L}\p{N}]*)$/u, '$1')
      emphOpen = false
    }
    if (!text) return
    const prev = cur[cur.length - 1]
    if (prev && (prev.pace !== pace || prev.energy !== energy)) close()
    cur.push({ text, pace, energy, emph })
    if (SENTENCE_END_RE.test(text)) close()
  }

  for (const chunk of script.split(/\s+/).filter(Boolean)) {
    for (const part of chunk.split(TAG_RE).filter(Boolean)) {
      const tag = part.match(/^\[(\/?)(slow|fast|loud|soft)\]$/i)
      if (tag) {
        const closing = tag[1] === '/'
        const name = tag[2].toLowerCase()
        if (name === 'slow' || name === 'fast') pace = closing ? undefined : name
        else energy = closing ? undefined : name === 'loud' ? 'punch' : 'soft'
        continue
      }
      const m = part.match(/^(\/{1,2})?(.*?)(\/{1,2})?$/s)
      if (!m) continue
      const [, lead, word, trail] = m
      if (lead) close(lead.length === 2 ? 'long' : 'short')
      if (word) pushWord(word)
      if (trail) close(trail.length === 2 ? 'long' : 'short')
    }
  }
  close()
  return segs
}

/** Strip surrounding punctuation but keep units like % and $: "10%." -> "10%". */
export function cleanToken(w: string): string {
  return w.replace(/^[^\p{L}\p{N}$€£]+/u, '').replace(/[^\p{L}\p{N}%]+$/u, '')
}
