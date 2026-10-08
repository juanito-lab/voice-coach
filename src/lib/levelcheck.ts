import { ampToDb, powerToDb } from './levels'

export interface Frame {
  ms: number
  peak: number
}

/** Where the level check aims your average speaking level (dBFS RMS), inside the normal band. */
export const TARGET_SPEECH_DB = -18
/** Keep 95% of speech peaks at or below this after gain. */
export const PEAK_CEILING_DB = -3
export const MAX_GAIN_DB = 36

export interface LevelCheck {
  ok: boolean
  /** room noise with the new gain applied */
  floorDb: number
  /** your speaking level before gain */
  speechDb: number
  gainDb: number
  message: string
}

function meanPower(frames: Frame[]): number {
  return frames.reduce((a, f) => a + f.ms, 0) / Math.max(1, frames.length)
}

/**
 * Pick a digital input gain from two measurements taken at 0 dB gain:
 * 3 s of silence (noise floor) and ~5 s of reading a line (speech level).
 */
export function computeLevelCheck(quiet: Frame[], speech: Frame[]): LevelCheck {
  const rawFloor = powerToDb(meanPower(quiet))
  const voiced = speech.filter((f) => powerToDb(f.ms) > rawFloor + 10)
  if (voiced.length < speech.length * 0.25) {
    return { ok: false, floorDb: rawFloor, speechDb: -100, gainDb: 0, message: "Didn't hear you clearly — move closer to the mic and try again." }
  }
  const speechDb = powerToDb(meanPower(voiced))
  const peaks = voiced.map((f) => ampToDb(f.peak)).sort((a, b) => a - b)
  const p95 = peaks[Math.floor(peaks.length * 0.95)] ?? peaks[peaks.length - 1]
  const gainDb = Math.round(Math.max(0, Math.min(MAX_GAIN_DB, TARGET_SPEECH_DB - speechDb, PEAK_CEILING_DB - p95)))
  const floorDb = rawFloor + gainDb
  const noisy = floorDb > -50
  return {
    ok: true,
    floorDb,
    speechDb,
    gainDb,
    message: noisy
      ? `Room noise is high (${floorDb.toFixed(0)} dBFS after gain). Quieter room or closer mic.`
      : `Set. Speak like that and you'll land in the green.`,
  }
}
