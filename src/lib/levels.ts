import type { Energy } from './types'

/** Target RMS bands (dBFS) per energy level. "normal" is the standard voiceover target. */
export const ENERGY_BANDS: Record<Energy, [number, number]> = {
  soft: [-26, -18],
  normal: [-20, -12],
  punch: [-16, -9],
}
/** RMS within this many dB below the band's floor counts as "approaching". */
export const APPROACH_DB = 4
/**
 * Sample peaks above this turn the signal red. Unprocessed speech peaks sit ~12–18 dB
 * above its RMS, so −6 would flash on every good take; −3 keeps red meaning "near clipping".
 */
export const PEAK_RED_DB = -3
/** Sample peaks at or above this count as clipped. */
export const CLIP_DB = -1
export const FLOOR_DB = -100

export function meanSquare(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return buf.length ? sum / buf.length : 0
}

export function peakAbs(buf: Float32Array): number {
  let p = 0
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i])
    if (a > p) p = a
  }
  return p
}

/** Amplitude (linear, 1.0 = full scale) to dBFS. */
export function ampToDb(amp: number): number {
  return amp > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(amp)) : FLOOR_DB
}

/** Mean-square power to dBFS RMS. */
export function powerToDb(ms: number): number {
  return ms > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(ms)) : FLOOR_DB
}

/** Exponential-moving-average coefficient for a frame of dtMs with time constant tauMs. */
export function emaAlpha(dtMs: number, tauMs: number): number {
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

/** Sine amplitude that produces the given RMS level in dBFS. */
export function sineAmpForRmsDb(db: number): number {
  return Math.pow(10, db / 20) * Math.SQRT2
}

export type Zone = 'quiet' | 'approach' | 'good' | 'hot' | 'clip'
export type StatusWord = 'LOUDER' | 'GOOD' | 'BACK OFF'

export function classify(rmsDb: number, peakDb: number, band: [number, number]): Zone {
  if (peakDb > PEAK_RED_DB) return 'clip'
  const [lo, hi] = band
  if (rmsDb < lo - APPROACH_DB) return 'quiet'
  if (rmsDb < lo) return 'approach'
  if (rmsDb <= hi) return 'good'
  return 'hot'
}

export function statusWord(zone: Zone): StatusWord {
  if (zone === 'quiet' || zone === 'approach') return 'LOUDER'
  if (zone === 'good') return 'GOOD'
  return 'BACK OFF'
}
