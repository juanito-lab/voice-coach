import { describe, expect, it } from 'vitest'
import { computeLevelCheck } from './levelcheck'

const frame = (db: number, crestDb = 12) => ({ ms: Math.pow(10, db / 10), peak: Math.pow(10, (db + crestDb) / 20) })
const many = (db: number, n = 100, crest = 12) => Array.from({ length: n }, () => frame(db, crest))

describe('computeLevelCheck', () => {
  it('quiet Mac mic (−42 dBFS speech) gets +24 dB to land at −18', () => {
    const r = computeLevelCheck(many(-70), many(-42))
    expect(r.ok).toBe(true)
    expect(r.gainDb).toBe(24)
    expect(r.floorDb).toBeCloseTo(-46, 0)
  })
  it('limits gain so speech peaks stay under −3 dBFS', () => {
    const r = computeLevelCheck(many(-80), many(-40, 100, 30)) // very peaky speech
    expect(r.gainDb).toBe(7) // peaks at −10 → −3 − (−10)
  })
  it('never cuts level and caps at +36', () => {
    expect(computeLevelCheck(many(-80), many(-10)).gainDb).toBe(0)
    expect(computeLevelCheck(many(-100), many(-70, 100, 6)).gainDb).toBe(36)
  })
  it('fails when no speech was heard', () => {
    expect(computeLevelCheck(many(-60), many(-58)).ok).toBe(false)
  })
})
