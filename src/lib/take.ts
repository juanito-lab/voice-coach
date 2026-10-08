import { ENERGY_BANDS, powerToDb } from './levels'
import { matchPosition } from './matcher'
import { buildSchedule, scriptWordList, segmentWords, wordsDoneAt, type Schedule } from './prompter'
import { PACE_WPM, PAUSE_SEC, type Segment } from './types'

export type Mode = 'speech' | 'timed'
/** idle = line not started yet · on = with the pacer · ahead = rushing · behind = dragging */
export type PaceState = 'idle' | 'on' | 'ahead' | 'behind'

export interface Live {
  /** words finished so far (index of the next unspoken word) */
  pos: number
  /** current line */
  cur: number
  /** where the target pace says you should be, in words from the start of the current line */
  pacer: number
  pace: PaceState
  /** fraction of the pause before the current line still to wait (1 → 0); 0 = go */
  hold: number
  done: boolean
}

export type PaceVerdict = 'on' | 'fast' | 'slow'
export type LevelVerdict = 'good' | 'quiet' | 'hot'

export interface LineResult {
  wpm: number | null
  pace: PaceVerdict | null
  levelDb: number | null
  level: LevelVerdict | null
}

/** Words of drift from the pacer before the signal changes colour. */
const DRIFT_WORDS = 1.5
/** A new pace state must hold this long before it shows (stops flicker from recognition bursts). */
const PACE_SETTLE_MS = 500
/** Per-line wpm needs at least this many words to mean anything. */
const MIN_WORDS_FOR_WPM = 4
const PACE_TOLERANCE = 0.15

interface LineAcc {
  first: number | null
  last: number | null
  power: number
  frames: number
}

/**
 * Follows one take: turns recognised words (speech mode) or elapsed time (timed mode)
 * into the current word, the target-pace pacer, pause holds and per-line results.
 * No DOM — the UI calls tick() ~10×/s.
 */
export class TakeTracker {
  readonly segments: Segment[]
  readonly mode: Mode
  readonly schedule: Schedule
  readonly words: string[]
  private segLast: number[]
  private t0 = 0
  private offset = 0
  private heard: string[] = []
  private heardBase = 0
  private matched = 0
  private nudgeWords = 0
  private prevPos = 0
  private segStart: (number | null)[] = []
  private segDone: (number | null)[] = []
  private lines: LineAcc[] = []
  private pace: PaceState = 'idle'
  private paceCandidate: PaceState = 'idle'
  private paceSince = 0
  lastAdvance = 0

  constructor(segments: Segment[], mode: Mode) {
    this.segments = segments
    this.mode = mode
    this.schedule = buildSchedule(segments)
    this.words = scriptWordList(segments)
    this.segLast = segments.map((s, i) => this.schedule.segFirstWord[i] + segmentWords(s).length - 1)
  }

  /** Start (or restart) following from the top. */
  start(now: number) {
    this.t0 = now
    this.offset = 0
    this.heardBase = this.heard.length
    this.matched = 0
    this.nudgeWords = 0
    this.prevPos = 0
    this.segStart = this.segments.map(() => null)
    this.segDone = this.segments.map(() => null)
    this.lines = this.segments.map(() => ({ first: null, last: null, power: 0, frames: 0 }))
    this.pace = 'idle'
    this.paceCandidate = 'idle'
    this.lastAdvance = now
  }

  /** All words recognised so far (finals + current interim). */
  setHeard(words: string[]) {
    this.heard = words
  }

  /** ↑/↓: one word in speech mode, one second in timed mode. */
  nudge(dir: 1 | -1) {
    if (this.mode === 'speech') this.nudgeWords += dir
    else this.offset += dir * 1000
  }

  private msPerWord(seg: number): number {
    return 60000 / PACE_WPM[this.segments[seg].pace]
  }

  /**
   * When the pacer starts a line: when you said its first word — but never earlier than the
   * target timeline allows (previous line at target pace + its pause). Starting a line early
   * or cutting a pause short therefore still reads as rushing; starting late is forgiven.
   */
  private pacerStart(s: number, now: number): number {
    const spoken = now - this.msPerWord(s)
    const prev = s > 0 ? this.segStart[s - 1] : null
    if (prev === null) return spoken
    const prevSeg = this.segments[s - 1]
    const expected = prev + segmentWords(prevSeg).length * this.msPerWord(s - 1) + PAUSE_SEC[prevSeg.pauseAfter] * 1000
    return Math.max(spoken, expected)
  }

  tick(now: number, speaking = false, levelDb = -100): Live {
    const n = this.words.length
    const { wordSeg, segFirstWord } = this.schedule
    let p: number
    if (this.mode === 'speech') {
      this.matched = Math.max(this.matched, matchPosition(this.words, 0, this.heard.slice(this.heardBase)))
      p = this.matched + this.nudgeWords
    } else {
      p = wordsDoneAt(this.schedule, now - this.t0 + this.offset)
    }
    p = Math.max(0, Math.min(n, p))

    // Words newly finished since the last tick.
    for (let w = this.prevPos; w < p; w++) {
      const s = wordSeg[w]
      if (this.segStart[s] === null) this.segStart[s] = this.pacerStart(s, now)
      const line = this.lines[s]
      line.first ??= now
      line.last = now
      if (w === this.segLast[s]) this.segDone[s] = now
      this.lastAdvance = now
    }
    this.prevPos = Math.max(this.prevPos, p)

    const done = p >= n
    const cur = done ? this.segments.length - 1 : wordSeg[p]
    const first = segFirstWord[cur]
    const len = segmentWords(this.segments[cur]).length

    // Pause before this line: drains from 1 to 0 after the previous line ends.
    let hold = 0
    const prevDone = cur > 0 ? this.segDone[cur - 1] : null
    if (!done && prevDone !== null && this.segStart[cur] === null) {
      const pauseMs = PAUSE_SEC[this.segments[cur - 1].pauseAfter] * 1000
      if (pauseMs > 0) hold = Math.max(0, 1 - (now - prevDone) / pauseMs)
    }

    // Pacer: target position inside the current line, started when you said its first word.
    let pacer = 0
    let candidate: PaceState = 'idle'
    const started = this.segStart[cur]
    if (started !== null && !done) {
      pacer = Math.max(0, Math.min(len, (now - started) / this.msPerWord(cur)))
      const drift = p - first - pacer
      candidate = this.mode === 'timed' ? 'on' : drift > DRIFT_WORDS ? 'ahead' : drift < -DRIFT_WORDS ? 'behind' : 'on'
    }
    if (candidate === 'idle' || this.pace === 'idle') {
      this.pace = candidate
      this.paceCandidate = candidate
    } else if (candidate !== this.paceCandidate) {
      this.paceCandidate = candidate
      this.paceSince = now
    } else if (candidate !== this.pace && now - this.paceSince >= PACE_SETTLE_MS) {
      this.pace = candidate
    }

    // Level per line, attributed to the line of the word just spoken.
    if (speaking) {
      const line = this.lines[p > 0 ? wordSeg[Math.min(p - 1, n - 1)] : 0]
      if (line) {
        line.power += Math.pow(10, levelDb / 10)
        line.frames++
      }
    }

    return { pos: p, cur, pacer, pace: this.pace, hold, done }
  }

  /** How much of the script the tracker followed (0–1). */
  get followed(): number {
    return this.words.length ? this.prevPos / this.words.length : 0
  }

  results(): LineResult[] {
    return this.segments.map((seg, k) => {
      const L = this.lines[k]
      const words = segmentWords(seg).length
      let wpm: number | null = null
      if (L && L.first !== null && L.last !== null && L.last > L.first && words >= MIN_WORDS_FOR_WPM) {
        wpm = ((words - 1) / (L.last - L.first)) * 60000
      }
      const target = PACE_WPM[seg.pace]
      const pace: PaceVerdict | null =
        wpm === null ? null : wpm > target * (1 + PACE_TOLERANCE) ? 'fast' : wpm < target * (1 - PACE_TOLERANCE) ? 'slow' : 'on'
      const levelDb = L && L.frames ? powerToDb(L.power / L.frames) : null
      const [lo, hi] = ENERGY_BANDS[seg.energy]
      const level: LevelVerdict | null = levelDb === null ? null : levelDb < lo ? 'quiet' : levelDb > hi ? 'hot' : 'good'
      return { wpm, pace, levelDb, level }
    })
  }
}
