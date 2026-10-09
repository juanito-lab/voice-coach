import { describe, expect, it } from 'vitest'
import { analyzeTake, frameLevels, mixDown, noiseFloorDb, speechRegions, speechThreshold } from './analysis'

const SR = 16000
/** Deterministic white-ish noise at a given RMS dBFS. */
function noise(db: number, sec: number, seed = 1): Float32Array {
  const n = Math.round(sec * SR)
  const out = new Float32Array(n)
  const amp = Math.pow(10, db / 20) * Math.sqrt(3) // uniform [-a, a] has RMS a/√3
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = amp * ((s / 2 ** 32) * 2 - 1)
  }
  return out
}
function tone(db: number, sec: number, f = 300): Float32Array {
  const n = Math.round(sec * SR)
  const out = new Float32Array(n)
  const amp = Math.pow(10, db / 20) * Math.SQRT2
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / SR)
  return out
}
/** Room noise everywhere, "speech" (a tone) in the given spans. */
function take(sec: number, speech: [number, number][], floorDb = -60, speechDb = -18): Float32Array {
  const x = noise(floorDb, sec)
  for (const [a, b] of speech) {
    const t = tone(speechDb, b - a)
    x.set(t.map((v, i) => v + x[Math.round(a * SR) + i]), Math.round(a * SR))
  }
  return x
}

describe('noiseFloorDb', () => {
  it('finds the room noise under a take with pauses', () => {
    const x = take(6, [[0.5, 2.5], [3, 5.5]], -57)
    expect(noiseFloorDb(x, SR)).toBeCloseTo(-57, 0)
  })
  it('ignores DC offset', () => {
    const x = noise(-60, 2).map((v) => v + 0.05)
    expect(noiseFloorDb(x, SR)).toBeCloseTo(-60, 0)
  })
  it('a digitally silent (gated) mic reads −100; empty input is null', () => {
    expect(noiseFloorDb(new Float32Array(SR), SR)).toBe(-100)
    expect(noiseFloorDb(new Float32Array(10), SR)).toBeNull()
  })
})

describe('speechRegions', () => {
  it('finds speech between pauses, to within a frame', () => {
    const x = take(6, [[0.5, 2.5], [3, 3.8], [4.4, 5.5]])
    const r = speechRegions(frameLevels(x, SR), 0.01)
    expect(r).toHaveLength(3)
    const want = [[0.5, 2.5], [3, 3.8], [4.4, 5.5]]
    r.forEach(([a, b], i) => {
      expect(Math.abs(a - want[i][0])).toBeLessThanOrEqual(0.011)
      expect(Math.abs(b - want[i][1])).toBeLessThanOrEqual(0.011)
    })
  })
  it('bridges pauses shorter than minPause and drops clicks', () => {
    const lv = new Float32Array(300).fill(-60)
    lv.fill(-20, 10, 50) // 0.10–0.50
    lv.fill(-20, 60, 100) // 0.60–1.00: 0.1 s gap → merged
    lv.fill(-20, 150, 153) // 30 ms click → dropped
    lv.fill(-20, 200, 260) // 2.00–2.60
    expect(speechRegions(lv, 0.01, { thresholdDb: -40 })).toEqual([
      [0.1, 1],
      [2, 2.6],
    ])
  })
  it('threshold sits between the quiet and loud frames, at least 6 dB above the quiet ones', () => {
    const lv = [...Array(50).fill(-60), ...Array(50).fill(-15)]
    expect(speechThreshold(lv)).toBeCloseTo(-45, 5)
    expect(speechThreshold(Array(100).fill(-50))).toBe(-44)
  })
})

describe('analyzeTake', () => {
  it('measures a stereo take', () => {
    const x = take(4, [[0.5, 3.5]], -58, -20)
    const a = analyzeTake([x, x], SR)
    expect(a.durationSec).toBe(4)
    expect(a.sampleRate).toBe(SR)
    expect(a.noiseFloorDb).toBeCloseTo(-58, 0)
    expect(a.lufs).not.toBeNull()
    expect(a.regions).toHaveLength(1)
  })
  it('stereo loudness: identical channels read 3 dB above the same audio as mono, true stereo is measured per channel', () => {
    const x = take(4, [[0.5, 3.5]], -58, -20)
    const mono = analyzeTake([x], SR).lufs!
    expect(analyzeTake([x, x], SR).lufs! - mono).toBeCloseTo(3.01, 1)
    const quieter = x.map((v) => v / 2)
    expect(analyzeTake([x, quieter], SR).lufs!).toBeCloseTo(mono + 10 * Math.log10(1 + 0.25), 1)
  })
  it('mixDown averages channels, and passes identical ones through', () => {
    expect(Array.from(mixDown([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5])
    const a = new Float32Array([0.1, 0.2])
    expect(mixDown([a, a.slice()])).toBe(a)
  })
})
