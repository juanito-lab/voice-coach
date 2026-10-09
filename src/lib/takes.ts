/** The session's takes: picking the best one by numbers, and naming the downloads. */
import type { TakeAnalysis } from './analysis'
import type { LineResult, Mode } from './take'
import type { Segment } from './types'


export interface TakeScore {
  /** take number in this session, 1-based */
  n: number
  /** measuring while the recording is decoded; failed if the browser couldn't decode it */
  state: 'measuring' | 'measured' | 'failed'
  lufs: number | null
  noiseFloorDb: number | null
  clips: number
  /** % of speaking time in the green */
  greenPct: number
  /** share of the script the take reached (0–1) */
  followed: number
}

/** The best-take rule. Documented in the README; change both together. */
export const BEST = {
  /** Loudness the edit pipeline normalises to (ContentCreation's voice_assemble.py: loudnorm I=−16). */
  targetLufs: -16,
  /** Further than this from the target and the take needs so much gain (or cut) that it's out. */
  maxLufsOff: 6,
  /** Noisier than this and the room is audible once the voice is levelled. */
  maxNoiseFloorDb: -50,
  /** The take must reach this much of the script. */
  minFollowed: 0.9,
  /** Takes this close to the most time in green are a tie, broken by loudness. */
  greenTiePts: 5,
} as const

/** Why a take can't be the best one. Empty = it qualifies. */
export function takeIssues(t: TakeScore): string[] {
  if (t.state === 'measuring') return ['still measuring']
  if (t.state === 'failed') return ["couldn't be measured"]
  const out: string[] = []
  if (t.clips > 0) out.push(`${t.clips} clipped peak${t.clips > 1 ? 's' : ''}`)
  if (t.noiseFloorDb !== null && t.noiseFloorDb > BEST.maxNoiseFloorDb) out.push(`noisy (floor above ${String(BEST.maxNoiseFloorDb).replace('-', '−')} dBFS)`)
  if (t.lufs === null) out.push('no speech')
  else if (t.lufs < BEST.targetLufs - BEST.maxLufsOff) out.push('too quiet')
  else if (t.lufs > BEST.targetLufs + BEST.maxLufsOff) out.push('too loud')
  if (t.followed < BEST.minFollowed) out.push('script not finished')
  return out
}

/**
 * The best take, or null if none qualifies.
 * 1. Qualifies: no clipped peaks, noise floor ≤ −50 dBFS, loudness within ±6 LU of −16 LUFS, ≥ 90 % of the script.
 * 2. Of those, the most time in the green wins.
 * 3. Within 5 points of that, the loudness closest to −16 LUFS wins (then more green, then the earlier take).
 */
export function pickBest(takes: readonly TakeScore[]): number | null {
  const ok = takes.filter((t) => takeIssues(t).length === 0)
  if (!ok.length) return null
  const lead = Math.max(...ok.map((t) => t.greenPct))
  const off = (t: TakeScore) => Math.abs((t.lufs ?? -Infinity) - BEST.targetLufs)
  const near = ok.filter((t) => t.greenPct >= lead - BEST.greenTiePts)
  near.sort((a, b) => off(a) - off(b) || b.greenPct - a.greenPct || a.n - b.n)
  return near[0].n
}

const pad = (x: number) => String(x).padStart(2, '0')

/** Shared base name for every download of a take, in local time: voice-coach_2026-10-09_14-03_take2 */
export function takeFileBase(recordedAt: Date, n: number): string {
  const d = recordedAt
  return `voice-coach_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}_take${n}`
}

/** 41.3 → "0:41" */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** One recorded take, kept in memory for the session. */
export interface Take {
  n: number
  recordedAt: Date
  /** shared download name, e.g. voice-coach_2026-10-09_14-03_take2 */
  base: string
  webmUrl: string
  webmSize: number
  wavUrl: string | null
  wavSize: number
  durationSec: number
  greenPct: number
  avgDb: number
  clips: number
  wpm: number
  wpmMethod: 'speech' | 'script'
  followed: number
  lines: LineResult[]
  /** the script and direction this take was read from */
  script: string
  segments: Segment[]
  mode: Mode
  status: 'measuring' | 'ready' | 'failed'
  analysis: TakeAnalysis | null
}

export function scoreOf(t: Take): TakeScore {
  return {
    n: t.n,
    state: t.status === 'ready' ? 'measured' : t.status === 'failed' ? 'failed' : 'measuring',
    lufs: t.analysis?.lufs ?? null,
    noiseFloorDb: t.analysis?.noiseFloorDb ?? null,
    clips: t.clips,
    greenPct: t.greenPct,
    followed: t.followed,
  }
}
