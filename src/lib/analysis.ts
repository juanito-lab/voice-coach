import { integratedLoudness, kWeight } from './loudness'

/** A stretch of the take in seconds: [start, end]. */
export type Span = [number, number]

export interface TakeAnalysis {
  durationSec: number
  sampleRate: number
  /** BS.1770 integrated loudness of the file as recorded (all channels); null = silent */
  lufs: number | null
  /** quietest-10 % level of 50 ms windows, dBFS RMS; null = too short to tell */
  noiseFloorDb: number | null
  /** where you were speaking, in take seconds */
  regions: Span[]
}

const DB_FLOOR = -100

/** Average the channels into one. */
export function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const n = channels[0]?.length ?? 0
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length
  return out
}

/** p-quantile (0–1) of already sorted values, nearest-rank. */
function quantile(sorted: ArrayLike<number>, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))]
}

/**
 * Noise floor: RMS (DC removed) of 50 ms windows, take the quietest 10 %. Robust to a few
 * dropouts at the start of a recording, and needs no separate silence measurement —
 * the pauses between lines are enough. Digital silence reads −100.
 */
export function noiseFloorDb(mono: Float32Array, sampleRate: number, winSec = 0.05, pct = 0.1): number | null {
  const win = Math.max(1, Math.round(sampleRate * winSec))
  const levels: number[] = []
  for (let i = 0; i + win <= mono.length; i += win) {
    let sum = 0
    let sq = 0
    for (let k = i; k < i + win; k++) {
      sum += mono[k]
      sq += mono[k] * mono[k]
    }
    const mean = sum / win
    const v = Math.max(0, sq / win - mean * mean)
    levels.push(v > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(v)) : DB_FLOOR)
  }
  if (!levels.length) return null
  levels.sort((a, b) => a - b)
  return quantile(levels, pct)
}

/** Level in dB of consecutive `hopSec` frames of a (K-weighted) signal. */
export function frameLevels(x: Float32Array, sampleRate: number, hopSec = 0.01): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopSec))
  const n = Math.floor(x.length / hop)
  const out = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sq = 0
    for (let i = f * hop, end = i + hop; i < end; i++) sq += x[i] * x[i]
    const ms = sq / hop
    out[f] = ms > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(ms)) : DB_FLOOR
  }
  return out
}

/**
 * Speech/silence threshold from the take itself: a third of the way from the quiet frames
 * (10th percentile) to the loud ones (95th), but at least 6 and at most 18 dB above the quiet ones.
 */
export function speechThreshold(levelsDb: ArrayLike<number>): number {
  const sorted = Float32Array.from(levelsDb).sort()
  if (!sorted.length) return 0
  const quiet = quantile(sorted, 0.1)
  const loud = quantile(sorted, 0.95)
  return quiet + Math.min(18, Math.max(6, (loud - quiet) / 3))
}

export interface RegionOptions {
  /** silences shorter than this don't split speech (s); same default as voice_chunks.py --min-pause */
  minPause?: number
  /** speech shorter than this is a click or a breath, not a word (s) */
  minSpeech?: number
  /** override the automatic threshold (dB) */
  thresholdDb?: number
}

/** Turn frame levels into speech regions [start, end] in seconds. */
export function speechRegions(levelsDb: ArrayLike<number>, hopSec: number, opts: RegionOptions = {}): Span[] {
  const minPause = opts.minPause ?? 0.18
  const minSpeech = opts.minSpeech ?? 0.08
  const thr = opts.thresholdDb ?? speechThreshold(levelsDb)
  const runs: Span[] = []
  let start = -1
  for (let i = 0; i <= levelsDb.length; i++) {
    const on = i < levelsDb.length && levelsDb[i] > thr
    if (on && start < 0) start = i
    else if (!on && start >= 0) {
      runs.push([start * hopSec, i * hopSec])
      start = -1
    }
  }
  const merged: Span[] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < minPause) last[1] = r[1]
    else merged.push([r[0], r[1]])
  }
  return merged.filter(([a, b]) => b - a >= minSpeech).map(([a, b]) => [round3(a), round3(b)])
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Everything the takes list and the timing export need, from the decoded recording. */
export function analyzeTake(channels: Float32Array[], sampleRate: number): TakeAnalysis {
  const mono = mixDown(channels)
  const hop = 0.01
  return {
    durationSec: mono.length / sampleRate,
    sampleRate,
    lufs: integratedLoudness(channels, sampleRate),
    noiseFloorDb: noiseFloorDb(mono, sampleRate),
    // K-weighting removes rumble and lifts sibilants, so word edges like "s" and "f" count as speech.
    regions: speechRegions(frameLevels(kWeight(mono, sampleRate), sampleRate, hop), hop),
  }
}

/**
 * MediaRecorder starts capturing a moment after start() is called. The wall-clock length of
 * the take minus the decoded length is that delay (clamped to 0–250 ms): audio time 0 is
 * `startedAt + offset` on the performance clock.
 */
export function recorderOffsetSec(wallSec: number, decodedSec: number): number {
  return Math.min(0.25, Math.max(0, wallSec - decodedSec))
}
