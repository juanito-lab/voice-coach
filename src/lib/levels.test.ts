import { describe, expect, it } from 'vitest'
import { ampToDb, classify, emaAlpha, meanSquare, peakAbs, powerToDb, sineAmpForRmsDb, statusWord, ENERGY_BANDS } from './levels'

function sine(amp: number, n = 48000, f = 440, sr = 48000) {
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * f * i) / sr)
  return b
}

describe('dBFS maths', () => {
  it('full-scale sine is -3.01 dBFS RMS and 0 dBFS peak', () => {
    const b = sine(1)
    expect(powerToDb(meanSquare(b))).toBeCloseTo(-3.01, 1)
    expect(ampToDb(peakAbs(b))).toBeCloseTo(0, 2)
  })
  it.each([-30, -16, -3])('sineAmpForRmsDb(%i) round-trips', (db) => {
    expect(powerToDb(meanSquare(sine(sineAmpForRmsDb(db))))).toBeCloseTo(db, 1)
  })
  it('silence floors at -100', () => expect(powerToDb(0)).toBe(-100))
  it('ema alpha: one time-constant ≈ 63%', () => expect(emaAlpha(300, 300)).toBeCloseTo(0.632, 3))
})

describe('zones (normal band)', () => {
  const b = ENERGY_BANDS.normal
  it.each([
    [-30, -20, 'quiet', 'LOUDER'],
    [-22, -15, 'approach', 'LOUDER'],
    [-16, -10, 'good', 'GOOD'],
    [-10, -7, 'hot', 'BACK OFF'],
    [-16, -3, 'clip', 'BACK OFF'],
  ] as const)('rms %i / peak %i → %s', (rms, peak, zone, word) => {
    const z = classify(rms, peak, b)
    expect(z).toBe(zone)
    expect(statusWord(z)).toBe(word)
  })
})
