import { describe, expect, it } from 'vitest'
import type { Span } from './analysis'
import { directScript } from './direct'
import { scriptWordList } from './prompter'
import {
  alignLines,
  buildTiming,
  chunksIn,
  lineReaches,
  lineWords,
  linesJson,
  prettyJson,
  TIMED_ALIGN,
  wordStarts,
  type TimingInput,
} from './timing'

/**
 * A simulated read. Each line is a list of speech pieces [start, end, words]; words are spread evenly.
 * Recognition reaches each word at its end + a lag, on the tracker's 100 ms ticks.
 */
function read(lines: [number, number, number][][], lags = [0.4, 0.7, 0.9, 0.5]) {
  const regions: Span[] = []
  const reach: number[] = []
  const words: number[] = []
  let k = 0
  for (const pieces of lines) {
    let n = 0
    for (const [a, b, w] of pieces) {
      regions.push([a, b])
      for (let i = 1; i <= w; i++) reach.push(Math.ceil((a + ((b - a) * i) / w + lags[k++ % lags.length]) * 10) / 10)
      n += w
    }
    words.push(n)
  }
  // Recognition only ever moves forward.
  for (let i = 1; i < reach.length; i++) reach[i] = Math.max(reach[i], reach[i - 1])
  return { regions, reach: reach as (number | null)[], words }
}

const LINES: [number, number, number][][] = [
  [[0.5, 3.7, 8]],
  [
    [4.2, 5.0, 2],
    [5.35, 6.95, 4],
  ],
  [[7.75, 10.25, 5]],
]

const chunksOf = (words: number[], reach: (number | null)[], regions: Span[], opts = undefined) =>
  alignLines(lineReaches(words, reach), regions, opts).map((s) => (s ? chunksIn([s.start, s.end], regions) : []))

describe('alignLines + chunksIn', () => {
  it('snaps every line to its own speech, keeping a real pause inside a line as two chunks', () => {
    const { regions, reach, words } = read(LINES)
    expect(chunksOf(words, reach, regions)).toEqual([[[0.5, 3.7]], [[4.2, 5.0], [5.35, 6.95]], [[7.75, 10.25]]])
  })

  it('works across lags from 0.2 to 1.5 s', () => {
    for (const lag of [0.2, 0.6, 1.0, 1.5]) {
      const { regions, reach, words } = read(LINES, [lag])
      expect(chunksOf(words, reach, regions)).toEqual([[[0.5, 3.7]], [[4.2, 5.0], [5.35, 6.95]], [[7.75, 10.25]]])
    }
  })

  it('a line comma pause longer than the pause between lines does not steal the boundary', () => {
    // "So, // who pays?" – a 0.9 s pause inside line 1, only 0.35 s between line 0 and line 1.
    const { regions, reach, words } = read([[[0.5, 2.5, 6]], [[2.85, 3.2, 1], [4.1, 5.0, 2]], [[5.6, 7.0, 4]]])
    expect(chunksOf(words, reach, regions)).toEqual([[[0.5, 2.5]], [[2.85, 3.2], [4.1, 5.0]], [[5.6, 7.0]]])
  })

  it('leaves out chatter long before the first word and after the last one', () => {
    const { regions, reach, words } = read(LINES)
    const withChatter: Span[] = [[-3, -2.6], ...regions, [11.8, 12.4]].map(([a, b]) => [a + 3, b + 3])
    const shifted = reach.map((t) => t! + 3)
    expect(chunksOf(words, shifted, withChatter)).toEqual([[[3.5, 6.7]], [[7.2, 8.0], [8.35, 9.95]], [[10.75, 13.25]]])
  })

  it('a first line recognition missed (all its words reached at once, late) still starts at its speech', () => {
    const { regions, reach, words } = read(LINES)
    const late = reach.map((t, i) => (i < 8 ? 4.9 : t))
    late[8] = 4.9 // re-anchored on line 1's first words
    expect(chunksOf(words, late, regions)[0]).toEqual([[0.5, 3.7]])
    expect(chunksOf(words, late, regions)[1]).toEqual([[4.2, 5.0], [5.35, 6.95]])
  })

  it('two lines read without a pause are split at an estimate and marked', () => {
    const regions: Span[] = [[0.5, 6.0]]
    const reach = [1.4, 2.0, 2.6, 3.2, 3.9, 4.5, 5.2, 6.4]
    const spans = alignLines(lineReaches([4, 4], reach), regions)
    expect(spans[0]!.estimated).toBe(true)
    expect(spans[0]!.end).toBeCloseTo((3.2 + 3.9) / 2 - 0.6, 5)
    expect(spans[1]!.start).toBe(spans[0]!.end)
    expect(spans[1]!.end).toBe(6.0)
  })

  it('timed mode: the reader trails the prompter by a second, boundaries still land in the pauses', () => {
    const { regions, words } = read(LINES)
    // Schedule ends ~1 s before the voice.
    const sched = read(LINES, [-1]).reach
    expect(chunksOf(words, sched, regions, TIMED_ALIGN as never)).toEqual([[[0.5, 3.7]], [[4.2, 5.0], [5.35, 6.95]], [[7.75, 10.25]]])
  })

  it('no reached lines or no speech → nothing placed', () => {
    expect(alignLines([null, null], [[0, 1]])).toEqual([null, null])
    expect(alignLines([{ first: 1, last: 2, burst: 1 }], [])).toEqual([null])
  })
})

describe('alignLines on simulated takes', () => {
  it('places ≥ 98 % of lines exactly (lag 0.3–0.8 s, bursty recognition, comma pauses, pauses from 0.25 s)', () => {
    let s = 7
    const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
    let bad = 0
    let all = 0
    for (let take = 0; take < 200; take++) {
      const regions: Span[] = []
      const raw: number[] = []
      const words: number[] = []
      const truth: Span[][] = []
      let t = 0.3 + r() * 0.7
      for (let L = 4 + Math.floor(r() * 5); L > 0; L--) {
        const nw = 2 + Math.floor(r() * 10)
        const wordSec = 0.3 + r() * 0.2
        const comma = nw >= 4 && r() < 0.4 ? 1 + Math.floor(r() * (nw - 2)) : -1
        const pieces: Span[] = []
        let a = t
        for (let w = 0; w < nw; w++) {
          t += wordSec
          raw.push(t + 0.3 + r() * 0.5)
          if (w === comma) {
            pieces.push([a, t])
            t += 0.3 + r() * 0.6
            a = t
          }
        }
        pieces.push([a, t])
        regions.push(...pieces)
        words.push(nw)
        truth.push(chunksIn([pieces[0][0], pieces[pieces.length - 1][1]], pieces))
        t += 0.25 + r() * 0.75
      }
      const deliveries: number[] = []
      for (let d = 0; d < t + 5; ) deliveries.push((d += 0.3 + r() * 0.5))
      const reach = raw.map((x) => Math.ceil(deliveries.find((y) => y >= x)! * 10) / 10)
      const got = chunksOf(words, reach, regions)
      truth.forEach((c, i) => {
        all++
        if (JSON.stringify(got[i]) !== JSON.stringify(c)) bad++
      })
    }
    expect(bad / all).toBeLessThan(0.02)
  })
})

describe('lineReaches', () => {
  it('first, last and the burst that arrived with the first word', () => {
    expect(lineReaches([3, 2, 2], [1.0, 1.0, 1.4, 2.0, 2.2, null, null])).toEqual([
      { first: 1.0, last: 1.4, burst: 2 },
      { first: 2.0, last: 2.2, burst: 1 },
      null,
    ])
  })
})

describe('chunksIn', () => {
  it('clips to the span, joins pauses under 0.3 s, drops slivers', () => {
    const regions: Span[] = [[0, 1], [1.2, 2], [2.5, 3], [3.98, 5]]
    expect(chunksIn([0.5, 4], regions)).toEqual([[0.5, 2], [2.5, 3]])
  })
})

describe('wordStarts', () => {
  it('spreads words over voiced time by length, first word at the start', () => {
    const t = wordStarts(['a', 'bb', 'ccc'], [[1, 3]])
    expect(t[0]).toBe(1)
    expect(t[1]).toBeCloseTo(1 + (2 * 2) / 9, 5)
    expect(t[2]).toBeCloseTo(1 + (2 * 5) / 9, 5)
  })
  it('skips the pause between chunks', () => {
    const t = wordStarts(['one', 'two'], [[0, 1], [3, 4]])
    expect(t).toEqual([0, 3])
  })
})

describe('buildTiming', () => {
  const SAMPLE =
    "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."
  const segs = directScript(SAMPLE)
  const base = (o: Partial<TimingInput> = {}): TimingInput => {
    const { regions, reach } = read([[[0.5, 3.7, 8]], [[4.2, 6.0, 4]], [[6.5, 8.0, 4]], [[8.6, 9.5, 3]], [[10.0, 10.6, 2]], [[11.6, 15.0, 12]]])
    return {
      take: 2,
      recordedAt: new Date('2026-10-09T12:03:00Z'),
      durationSec: 17.25,
      sampleRate: 48000,
      script: SAMPLE,
      lines: segs.map((s) => s.text),
      tracking: 'speech',
      wordReach: reach,
      regions,
      stats: { integratedLufs: -16.73, noiseFloorDb: -57.24, greenPct: 83.6, avgDb: -17.31, clippedPeaks: 0, wpm: 151.4, followedPct: 100 },
      ...o,
    }
  }

  it('word indices line up with the tracker', () => {
    expect(segs.flatMap((s) => lineWords(s.text)).length).toBe(scriptWordList(segs).length)
  })

  it('has the documented shape; chunks is the lines.json list', () => {
    const t = buildTiming(base())
    expect(t).toMatchObject({ app: 'voice-coach', version: 1, take: 2, recordedAt: '2026-10-09T12:03:00.000Z', durationSec: 17.25, sampleRate: 48000 })
    expect(t.lines).toHaveLength(6)
    expect(t.chunks).toEqual([[[0.5, 3.7]], [[4.2, 6]], [[6.5, 8]], [[8.6, 9.5]], [[10, 10.6]], [[11.6, 15]]])
    expect(t.lines[0]).toMatchObject({ index: 0, text: 'Every rental car is driven by a stranger.', start: 0.5, end: 3.7 })
    expect(t.lines[0].words[0]).toEqual({ w: 'Every', t: 0.5 })
    expect(t.lines[0].words).toHaveLength(8)
    expect(t.stats).toEqual({ integratedLufs: -16.7, noiseFloorDb: -57.2, greenPct: 84, avgDb: -17.3, clippedPeaks: 0, wpm: 151, followedPct: 100 })
    expect(t.notes).toEqual([])
  })

  it('an unreached line gets an empty chunks entry and a note', () => {
    const inp = base()
    const words = segs.map((s) => lineWords(s.text).length)
    const cut = words.slice(0, 5).reduce((a, b) => a + b, 0)
    const t = buildTiming({ ...inp, wordReach: inp.wordReach.map((x, i) => (i < cut ? x : null)) })
    expect(t.chunks[5]).toEqual([])
    expect(t.chunks).toHaveLength(6)
    expect(t.lines[5]).toMatchObject({ start: null, end: null, note: 'not reached' })
    expect(t.lines[5].words.every((w) => w.t === null)).toBe(true)
    expect(t.notes[0]).toMatch(/^Line 6 "MantAI listens to the car so…" was not reached/)
  })

  it('a partly reached line is noted', () => {
    const inp = base()
    const t = buildTiming({ ...inp, wordReach: inp.wordReach.map((x, i) => (i < inp.wordReach.length - 3 ? x : null)) })
    expect(t.lines[5].note).toBe('partly reached')
  })

  it('timed mode and undecodable audio are flagged', () => {
    expect(buildTiming(base({ tracking: 'timed' })).notes[0]).toMatch(/^Timed mode/)
    const t = buildTiming(base({ regions: null }))
    expect(t.notes[0]).toMatch(/couldn't be decoded/)
    expect(t.chunks.every((c) => c.length === 1)).toBe(true)
  })

  it('no speech in the audio: every entry empty', () => {
    const t = buildTiming(base({ regions: [] }))
    expect(t.chunks).toEqual([[], [], [], [], [], []])
    expect(t.notes[0]).toBe('No speech was detected in the audio.')
  })

  it('pretty JSON parses back to the same object; lines.json is the bare list', () => {
    const t = buildTiming(base())
    expect(JSON.parse(prettyJson(t))).toEqual(t)
    expect(JSON.parse(linesJson(t))).toEqual(t.chunks)
    // one script line per row, so the file is easy to edit by hand
    expect(linesJson(t).split('\n')[1]).toBe('  [[0.5,3.7]],')
  })
})
