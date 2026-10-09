/**
 * Timing export: where each script line sits in a take, as chunks the ContentCreation pipeline
 * (tools/voice_assemble.py) takes as lines.json.
 *
 * Two inputs, both in seconds from the start of the recorded audio:
 *  - when the prompter reached each script word (speech recognition, which trails the voice), and
 *  - speech regions measured in the audio itself (see analysis.ts).
 * Line boundaries are snapped to the pauses in the audio that best fit the recognition times.
 */
import type { Span } from './analysis'
import type { Mode } from './take'

export interface AlignOptions {
  /** recognition reaches a word at least this long after it was said (s) */
  lagMin: number
  /** …usually about this long (s) */
  lagTypical: number
  /** …and at most this long (s) */
  lagMax: number
  /** the last line keeps speech that starts before its last word was reached + this (s) */
  tail: number
  /** score lost per second between a pause and where recognition says the boundary is */
  distWeight?: number
}

/** Chrome's recognition delivers words ~0.3–1 s after they're said, in bursts. */
export const SPEECH_ALIGN: AlignOptions = { lagMin: 0.1, lagTypical: 0.6, lagMax: 2, tail: -0.1 }
/** Timed mode: the prompter's schedule, which you may lead or trail by a second or two. */
export const TIMED_ALIGN: AlignOptions = { lagMin: -2, lagTypical: 0, lagMax: 2, tail: Infinity }

/** When the tracker reached a line: its first and last word, and how many words arrived together with the first. */
export interface LineReach {
  first: number
  last: number
  burst: number
}

/** How long one word may take when several were reached in the same instant (a recognition burst or a re-anchor). */
const BURST_WORD_SEC = 0.5
/** A word has to be said (≥ this long) before recognition can deliver it. */
const MIN_WORD_SEC = 0.15
/** Score of a pause: its length (capped), minus distance from where recognition says the boundary is, minus being outside the plausible window. */
const GAP_LEN_CAP = 1.5
const DIST_WEIGHT = 0.25
/** Once the lag is measured, distance is trusted more (best compromise in simulated takes with bursty recognition). */
const DIST_WEIGHT_MEASURED = 0.5
const OUTSIDE_WEIGHT = 3
/** Cost of splitting two lines where there is no pause. */
const NO_PAUSE_COST = 0.5
const MIN_LINE_SEC = 0.05
/** Pauses shorter than this inside a line stay inside one chunk (voice_assemble.py caps pauses at 0.3 s anyway). */
export const JOIN_GAP_SEC = 0.3

/** Words of a line, split exactly like the prompter does so indices line up with the tracker. */
export const lineWords = (text: string) => text.split(/\s+/).filter(Boolean)

/** Per-line reach from per-word reach times (words in script order). */
export function lineReaches(wordsPerLine: number[], wordReach: (number | null)[]): (LineReach | null)[] {
  let w = 0
  return wordsPerLine.map((count) => {
    const times = wordReach.slice(w, w + count)
    w += count
    const first = times[0]
    if (first === null || first === undefined) return null
    let last = first
    let burst = 0
    let inBurst = true
    for (const t of times) {
      if (t === null) break
      last = Math.max(last, t)
      if (inBurst && t === first) burst++
      else inBurst = false
    }
    return { first, last, burst }
  })
}

export interface LineSpan {
  start: number
  end: number
  /** no pause separated this line from a neighbour: the split is a guess */
  estimated: boolean
}

/**
 * Place each reached line in the take. The first line starts at the first speech that can belong to it,
 * the last line ends with the last speech that started before its last word was reached, and every boundary
 * in between is a pause in the audio, chosen jointly (in order) by dynamic programming.
 * Recognition lag varies between sessions, so a second pass re-runs with the median lag the first pass saw.
 * In simulated takes (lag 0.3–1.4 s, bursty delivery, comma pauses up to 0.9 s, pauses between lines from
 * 0.25 s) about 97–99 % of lines get exactly the right chunks.
 */
export function alignLines(reach: (LineReach | null)[], regions: Span[], opts: AlignOptions = SPEECH_ALIGN): (LineSpan | null)[] {
  const first = alignOnce(reach, regions, opts)
  const lags = first.flatMap((s, i) => (s && !s.estimated && reach[i] ? [reach[i]!.last - s.end] : [])).sort((a, b) => a - b)
  if (lags.length < 2) return first
  const mid = lags.length >> 1
  const median = lags.length % 2 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2
  const lag = Math.min(opts.lagMax, Math.max(opts.lagMin, median))
  return alignOnce(reach, regions, { ...opts, lagTypical: lag, distWeight: opts.distWeight ?? DIST_WEIGHT_MEASURED })
}

function alignOnce(reach: (LineReach | null)[], regions: Span[], opts: AlignOptions): (LineSpan | null)[] {
  const out: (LineSpan | null)[] = reach.map(() => null)
  const idx = reach.flatMap((r, i) => (r ? [i] : []))
  if (!idx.length || !regions.length) return out
  const R = regions
  const head = reach[idx[0]]!
  const tail = reach[idx[idx.length - 1]]!
  const startBound = head.first - opts.lagMax - head.burst * BURST_WORD_SEC
  let sIdx = R.findIndex(([, e]) => e > startBound)
  if (sIdx < 0) sIdx = R.length - 1
  let eIdx = sIdx
  for (let k = R.length - 1; k > sIdx; k--) {
    if (R[k][0] < tail.last + opts.tail) {
      eIdx = k
      break
    }
  }
  const gaps: Span[] = []
  for (let k = sIdx; k < eIdx; k++) gaps.push([R[k][1], R[k + 1][0]])

  // One boundary between each pair of consecutive reached lines.
  const bounds = idx.slice(1).map((b, k) => {
    const A = reach[idx[k]]!
    const B = reach[b]!
    return {
      lo: A.last - opts.lagMax,
      hiStart: A.last - opts.lagMin,
      hiEnd: B.first - opts.lagMin - MIN_WORD_SEC,
      expected: (A.last + B.first) / 2 - opts.lagTypical,
    }
  })
  const distWeight = opts.distWeight ?? DIST_WEIGHT
  const score = (b: number, g: number) => {
    const [gs, ge] = gaps[g]
    const w = bounds[b]
    const outside = Math.max(0, w.lo - gs) + Math.max(0, gs - w.hiStart) + Math.max(0, ge - w.hiEnd)
    return Math.min(ge - gs, GAP_LEN_CAP) - distWeight * Math.abs((gs + ge) / 2 - w.expected) - OUTSIDE_WEIGHT * outside
  }

  // DP over boundaries. State s = index of the last pause used + 1 (0 = none yet). Each boundary either
  // takes a later pause or is split without one (keeps the state, pays NO_PAUSE_COST).
  const G = gaps.length
  let best = new Float64Array(G + 1).fill(-Infinity)
  best[0] = 0
  const pick: Int32Array[] = []
  const from: Int32Array[] = []
  for (let b = 0; b < bounds.length; b++) {
    const next = new Float64Array(G + 1).fill(-Infinity)
    const pk = new Int32Array(G + 1).fill(-1)
    const fr = new Int32Array(G + 1).fill(-1)
    for (let s = 0; s <= G; s++) {
      if (best[s] - NO_PAUSE_COST > next[s]) {
        next[s] = best[s] - NO_PAUSE_COST
        pk[s] = -1
        fr[s] = s
      }
    }
    let run = -Infinity
    let runState = -1
    for (let g = 0; g < G; g++) {
      if (best[g] > run) {
        run = best[g]
        runState = g
      }
      if (run === -Infinity) continue
      const v = run + score(b, g)
      if (v > next[g + 1]) {
        next[g + 1] = v
        pk[g + 1] = g
        fr[g + 1] = runState
      }
    }
    best = next
    pick.push(pk)
    from.push(fr)
  }
  let s = 0
  for (let k = 1; k <= G; k++) if (best[k] > best[s]) s = k
  const used = new Array<number>(bounds.length)
  for (let b = bounds.length - 1; b >= 0; b--) {
    used[b] = pick[b][s]
    s = from[b][s]
  }

  const start = new Map<number, number>([[idx[0], R[sIdx][0]]])
  const end = new Map<number, number>([[idx[idx.length - 1], R[eIdx][1]]])
  const estimated = new Set<number>()
  used.forEach((g, b) => {
    if (g < 0) return
    end.set(idx[b], gaps[g][0])
    start.set(idx[b + 1], gaps[g][1])
  })
  used.forEach((g, b) => {
    if (g >= 0) return
    const A = idx[b]
    const B = idx[b + 1]
    let hi = end.get(idx[idx.length - 1])!
    for (let c = b + 1; c < used.length; c++) {
      if (used[c] >= 0) {
        hi = gaps[used[c]][0]
        break
      }
    }
    const lo = start.get(A)! + MIN_LINE_SEC
    hi -= MIN_LINE_SEC
    const t = lo <= hi ? Math.min(hi, Math.max(lo, bounds[b].expected)) : (lo + hi) / 2
    end.set(A, t)
    start.set(B, t)
    estimated.add(A).add(B)
  })
  for (const i of idx) out[i] = { start: start.get(i)!, end: Math.max(start.get(i)!, end.get(i)!), estimated: estimated.has(i) }
  return out
}

/** The speech regions inside a line's span, as voice_assemble.py chunks. */
export function chunksIn(span: Span, regions: Span[], joinGap = JOIN_GAP_SEC, minChunk = MIN_LINE_SEC): Span[] {
  const [a, b] = span
  const out: Span[] = []
  for (const [s, e] of regions) {
    const lo = Math.max(a, s)
    const hi = Math.min(b, e)
    if (hi - lo < minChunk) continue
    const last = out[out.length - 1]
    if (last && lo - last[1] < joinGap) last[1] = hi
    else out.push([lo, hi])
  }
  return out
}

/**
 * Word start times: the line's words spread over its voiced time (pauses skipped) in proportion to
 * their length. An estimate for captions and text pops, not a forced alignment.
 */
export function wordStarts(words: string[], chunks: Span[]): number[] {
  if (!chunks.length) return words.map(() => NaN)
  const weight = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 1)
  const total = weight.reduce((x, y) => x + y, 0)
  const voiced = chunks.reduce((x, [s, e]) => x + e - s, 0)
  const at = (v: number) => {
    for (let k = 0; k < chunks.length; k++) {
      const [s, e] = chunks[k]
      if (v < e - s || k === chunks.length - 1) return Math.min(e, s + v)
      v -= e - s
    }
    return chunks[chunks.length - 1][1]
  }
  let acc = 0
  return weight.map((w) => {
    const t = at((voiced * acc) / total)
    acc += w
    return t
  })
}

export interface TimingStats {
  integratedLufs: number | null
  noiseFloorDb: number | null
  greenPct: number
  avgDb: number
  clippedPeaks: number
  wpm: number
  followedPct: number
}

export interface TimingLine {
  index: number
  text: string
  start: number | null
  end: number | null
  words: { w: string; t: number | null }[]
  note?: string
}

export interface TimingFile {
  app: 'voice-coach'
  version: 1
  take: number
  recordedAt: string
  durationSec: number
  sampleRate: number | null
  script: string
  /** how line times were found: speech recognition, or the timed prompter's schedule */
  tracking: Mode
  lines: TimingLine[]
  /** ContentCreation lines.json: one entry per script line, each a list of [start, end] in take seconds */
  chunks: Span[][]
  stats: TimingStats
  notes: string[]
}

export interface TimingInput {
  take: number
  recordedAt: Date
  durationSec: number
  sampleRate: number | null
  script: string
  /** the directed lines (segment texts) */
  lines: string[]
  tracking: Mode
  /** per script word, seconds from the start of the recorded audio when it was reached; null = never */
  wordReach: (number | null)[]
  /** speech regions of the audio; null if it couldn't be decoded */
  regions: Span[] | null
  stats: TimingStats
}

const r2 = (x: number) => Math.round(x * 100) / 100
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)
const quote = (text: string) => {
  const w = lineWords(text)
  return `"${w.slice(0, 6).join(' ')}${w.length > 6 ? '…' : ''}"`
}

export function buildTiming(inp: TimingInput): TimingFile {
  const notes: string[] = []
  const words = inp.lines.map(lineWords)
  let regions = inp.regions
  if (inp.tracking === 'timed') notes.push("Timed mode (no speech recognition): line times follow the prompter's schedule, snapped to pauses in the audio. Check them.")
  if (regions === null) {
    notes.push("The audio couldn't be decoded, so line times come from recognition alone and may be off by half a second.")
    regions = [[0, inp.durationSec]]
  } else if (!regions.length) {
    notes.push('No speech was detected in the audio.')
  }
  const reach = lineReaches(
    words.map((w) => w.length),
    inp.wordReach,
  )
  const spans = alignLines(reach, regions, inp.tracking === 'timed' ? TIMED_ALIGN : SPEECH_ALIGN)
  const firstWord = words.map((_, i) => words.slice(0, i).reduce((n, w) => n + w.length, 0))
  const partly = (i: number) => {
    const times = inp.wordReach.slice(firstWord[i], firstWord[i] + words[i].length)
    return times.length < words[i].length || times.some((t) => t === null)
  }
  const chunks: Span[][] = []
  const lines: TimingLine[] = inp.lines.map((text, i) => {
    const span = spans[i]
    const c = span ? chunksIn([span.start, span.end], regions).map(([a, b]) => [r2(a), r2(b)] as Span) : []
    // A line with no speech inside its span (e.g. recognition only) still gets its span as one chunk.
    if (span && !c.length && span.end - span.start >= MIN_LINE_SEC && inp.regions === null) c.push([r2(span.start), r2(span.end)])
    chunks.push(c)
    let note: string | undefined
    const n = i + 1
    if (!reach[i]) {
      note = 'not reached'
      notes.push(`Line ${n} ${quote(text)} was not reached: its chunks entry is empty. Record a pickup or delete the entry.`)
    } else if (!c.length) {
      note = 'not found in audio'
      notes.push(`Line ${n} ${quote(text)} could not be found in the audio: its chunks entry is empty.`)
    } else if (partly(i)) {
      note = 'partly reached'
      notes.push(`Line ${n} was only partly reached; its end may be early.`)
    } else if (span?.estimated) {
      note = 'no pause at a boundary'
      notes.push(`Line ${n} runs into a neighbour without a pause; the split is estimated.`)
    }
    const starts = c.length ? wordStarts(words[i], c) : []
    return {
      index: i,
      text,
      start: c.length ? c[0][0] : null,
      end: c.length ? c[c.length - 1][1] : null,
      words: words[i].map((w, k) => ({ w, t: c.length ? r2(starts[k]) : null })),
      ...(note ? { note } : {}),
    }
  })
  return {
    app: 'voice-coach',
    version: 1,
    take: inp.take,
    recordedAt: inp.recordedAt.toISOString(),
    durationSec: r2(inp.durationSec),
    sampleRate: inp.sampleRate,
    script: inp.script,
    tracking: inp.tracking,
    lines,
    chunks,
    stats: {
      integratedLufs: r1(inp.stats.integratedLufs),
      noiseFloorDb: r1(inp.stats.noiseFloorDb),
      greenPct: Math.round(inp.stats.greenPct),
      avgDb: r1(inp.stats.avgDb)!,
      clippedPeaks: inp.stats.clippedPeaks,
      wpm: Math.round(inp.stats.wpm),
      followedPct: Math.round(inp.stats.followedPct),
    },
    notes,
  }
}

const depth = (v: unknown): number => (Array.isArray(v) ? 1 + v.reduce((m: number, x) => Math.max(m, depth(x)), 0) : 0)

/**
 * JSON that stays readable: anything that fits on one line (one line's chunks, a word) is written inline,
 * everything else is indented, and a list of chunk lists always gets one row per script line. Still plain JSON.
 */
export function prettyJson(v: unknown, indent = '', width = 72): string {
  const flat = JSON.stringify(v)
  if (flat === undefined) return 'null'
  if (typeof v !== 'object' || v === null || (flat.length + indent.length <= width && depth(v) <= 2)) return flat
  const inner = indent + '  '
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return `[\n${v.map((x) => inner + prettyJson(x, inner, width)).join(',\n')}\n${indent}]`
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (!entries.length) return '{}'
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${prettyJson(x, inner, width)}`).join(',\n')}\n${indent}}`
}

/** The bare chunks list, which voice_assemble.py reads as lines.json. */
export function linesJson(t: TimingFile): string {
  return prettyJson(t.chunks) + '\n'
}
