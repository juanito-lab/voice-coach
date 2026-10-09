/**
 * Integrated loudness after ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms blocks with 75 % overlap,
 * an absolute gate at −70 LUFS and a relative gate 10 LU below the absolute-gated level.
 * Runs offline over the recorded PCM. All channels are weighted 1.0 (mono and stereo; no surround).
 */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * The two K-weighting stages for any sample rate (same derivation as libebur128):
 * a high-shelf "head" filter (+4 dB above ~1.7 kHz) and the RLB high-pass (~38 Hz).
 * At 48 kHz these reproduce the coefficients printed in BS.1770.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / sampleRate)
  a0 = 1 + K / Q + K * K
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  return [shelf, highpass]
}

/** Run a biquad over `x` (direct form I). Writes into `out`, which may be `x` itself. */
export function applyBiquad(x: Float32Array, f: Biquad, out: Float32Array = new Float32Array(x.length)): Float32Array {
  const { b0, b1, b2, a1, a2 } = f
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    out[i] = yi
  }
  return out
}

/** K-weighted copy of one channel. */
export function kWeight(x: Float32Array, sampleRate: number): Float32Array {
  const [shelf, hp] = kWeightingFilters(sampleRate)
  const y = applyBiquad(x, shelf)
  return applyBiquad(y, hp, y)
}

/** True when two channels hold the same samples (browsers record a mono mic as identical L/R). */
export function sameSamples(a: Float32Array, b: Float32Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10
const loudnessOf = (power: number) => -0.691 + 10 * Math.log10(power)

/**
 * Integrated loudness in LUFS, or null when nothing is above the absolute gate
 * (silence, or shorter than one 400 ms block).
 */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number | null {
  // Identical channels are filtered once and counted twice (same result, half the work).
  const unique: { ch: Float32Array; weight: number }[] = []
  for (const ch of channels) {
    const twin = unique.find((u) => sameSamples(u.ch, ch))
    if (twin) twin.weight++
    else unique.push({ ch, weight: 1 })
  }
  return gatedLoudness(
    unique.map(({ ch, weight }) => ({ y: kWeight(ch, sampleRate), weight })),
    sampleRate,
  )
}

/** The gating part of BS.1770, over channels that are already K-weighted. */
export function gatedLoudness(kChannels: { y: Float32Array; weight: number }[], sampleRate: number): number | null {
  const n = kChannels[0]?.y.length ?? 0
  // 100 ms steps; a 400 ms block is 4 steps, so stepping one step gives the 75 % overlap.
  const step = Math.round(sampleRate * 0.1)
  const steps = step > 0 ? Math.floor(n / step) : 0
  if (steps < 4) return null
  const stepEnergy = new Float64Array(steps)
  for (const { y, weight } of kChannels) {
    for (let s = 0; s < steps; s++) {
      let acc = 0
      for (let i = s * step, end = i + step; i < end; i++) acc += y[i] * y[i]
      stepEnergy[s] += weight * acc
    }
  }
  const blocks: number[] = []
  for (let j = 0; j + 4 <= steps; j++) blocks.push((stepEnergy[j] + stepEnergy[j + 1] + stepEnergy[j + 2] + stepEnergy[j + 3]) / (4 * step))
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const audible = blocks.filter((p) => p > 0 && loudnessOf(p) > ABSOLUTE_GATE_LUFS)
  if (!audible.length) return null
  const relGate = loudnessOf(mean(audible)) + RELATIVE_GATE_LU
  const kept = audible.filter((p) => loudnessOf(p) > relGate)
  return kept.length ? loudnessOf(mean(kept)) : null
}
