import { describe, expect, it } from 'vitest'
import { integratedLoudness, kWeightingFilters } from './loudness'

const SR = 48000

function sine(amp: number, sec: number, f = 997, sr = SR): Float32Array {
  const n = Math.round(sec * sr)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * f * i) / sr)
  return b
}
const concat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((a, x) => a + x.length, 0))
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const dbAmp = (db: number) => Math.pow(10, db / 20)

describe('K-weighting', () => {
  it('reproduces the 48 kHz coefficients printed in BS.1770', () => {
    const [shelf, hp] = kWeightingFilters(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10)
    expect([hp.b0, hp.b1, hp.b2]).toEqual([1, -2, 1])
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10)
  })
})

describe('integratedLoudness (BS.1770-4)', () => {
  it('a full-scale 997 Hz sine in one channel reads −3.01 LUFS (the standard calibration)', () => {
    expect(integratedLoudness([sine(1, 5)], SR)).toBeCloseTo(-3.01, 1)
  })
  it('scales 1:1 with level', () => {
    expect(integratedLoudness([sine(dbAmp(-20), 5)], SR)).toBeCloseTo(-23.01, 1)
  })
  it('two identical channels read 3 dB louder than one', () => {
    const s = sine(dbAmp(-20), 5)
    expect(integratedLoudness([s, s], SR)! - integratedLoudness([s], SR)!).toBeCloseTo(3.01, 1)
  })
  it('works at 44.1 kHz too', () => {
    expect(integratedLoudness([sine(dbAmp(-20), 5, 997, 44100)], 44100)).toBeCloseTo(-23.01, 1)
  })
  it('absolute gate: silence between phrases does not lower the reading', () => {
    const tone = sine(dbAmp(-20), 5)
    const l = integratedLoudness([concat(tone, new Float32Array(SR * 5), tone)], SR)!
    // Ungated it would be −24.77 (a third is silence). Only the few blocks straddling the edges pull it down.
    expect(Math.abs(l - -23.01)).toBeLessThan(0.2)
  })
  it('relative gate: a part 20 dB quieter is ignored', () => {
    const l = integratedLoudness([concat(sine(dbAmp(-20), 10), sine(dbAmp(-40), 10))], SR)!
    expect(Math.abs(l - -23.01)).toBeLessThan(0.15)
  })
  it('null for silence and for audio shorter than one 400 ms block', () => {
    expect(integratedLoudness([new Float32Array(SR * 2)], SR)).toBeNull()
    expect(integratedLoudness([sine(1, 0.3)], SR)).toBeNull()
    expect(integratedLoudness([], SR)).toBeNull()
  })
})
