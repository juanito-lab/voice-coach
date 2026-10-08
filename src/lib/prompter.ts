import { tokenize } from './matcher'
import { PACE_WPM, PAUSE_SEC, type Segment } from './types'

export interface Schedule {
  /** start time (ms) of each script word, in reading order */
  wordStart: number[]
  /** end time (ms) of each script word (before any pause) */
  wordEnd: number[]
  /** segment index of each word */
  wordSeg: number[]
  /** first word index of each segment */
  segFirstWord: number[]
  totalMs: number
}

export function segmentWords(seg: Segment): string[] {
  return seg.text.split(/\s+/).filter(Boolean)
}

export function buildSchedule(segments: Segment[]): Schedule {
  const wordStart: number[] = []
  const wordEnd: number[] = []
  const wordSeg: number[] = []
  const segFirstWord: number[] = []
  let t = 0
  segments.forEach((seg, si) => {
    segFirstWord.push(wordStart.length)
    const per = 60000 / PACE_WPM[seg.pace]
    for (let k = 0; k < segmentWords(seg).length; k++) {
      wordStart.push(t)
      wordSeg.push(si)
      t += per
      wordEnd.push(t)
    }
    t += PAUSE_SEC[seg.pauseAfter] * 1000
  })
  return { wordStart, wordEnd, wordSeg, segFirstWord, totalMs: t }
}

/** Index of the word being spoken at elapsed ms (timed mode). Returns word count when finished. */
export function wordAtTime(s: Schedule, ms: number): number {
  if (ms < 0) return 0
  if (ms >= s.totalMs) return s.wordStart.length
  let lo = 0
  let hi = s.wordStart.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s.wordStart[mid] <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Normalised script words, aligned 1:1 with the schedule's word indices. */
export function scriptWordList(segments: Segment[]): string[] {
  return segments.flatMap((s) => segmentWords(s).map((w) => tokenize(w)[0] ?? ''))
}

/** Number of words finished at elapsed ms (timed mode) — same meaning as the speech matcher's position. */
export function wordsDoneAt(s: Schedule, ms: number): number {
  let lo = 0
  let hi = s.wordEnd.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (s.wordEnd[mid] <= ms) lo = mid + 1
    else hi = mid
  }
  return lo
}
