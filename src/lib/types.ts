export type Pace = 'slow' | 'normal' | 'fast'
export type Energy = 'soft' | 'normal' | 'punch'
export type Pause = 'none' | 'short' | 'long'

export interface Segment {
  text: string
  pace: Pace
  energy: Energy
  pauseAfter: Pause
  emphasis: string[]
  rising?: boolean
  source: 'auto' | 'manual' | 'claude'
}

export const PACE_WPM: Record<Pace, number> = { slow: 120, normal: 150, fast: 180 }
export const PAUSE_SEC: Record<Pause, number> = { none: 0, short: 0.3, long: 0.8 }

const PACES: Pace[] = ['slow', 'normal', 'fast']
const ENERGIES: Energy[] = ['soft', 'normal', 'punch']
const PAUSES: Pause[] = ['none', 'short', 'long']

/** Runtime check for segments coming from storage or the Claude API. */
export function validateSegments(input: unknown, source?: Segment['source']): Segment[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const out: Segment[] = []
  for (const s of input) {
    if (typeof s !== 'object' || s === null) return null
    const r = s as Record<string, unknown>
    if (typeof r.text !== 'string' || !r.text.trim()) return null
    if (!PACES.includes(r.pace as Pace)) return null
    if (!ENERGIES.includes(r.energy as Energy)) return null
    if (!PAUSES.includes(r.pauseAfter as Pause)) return null
    if (!Array.isArray(r.emphasis) || !r.emphasis.every((e) => typeof e === 'string')) return null
    out.push({
      text: r.text.trim(),
      pace: r.pace as Pace,
      energy: r.energy as Energy,
      pauseAfter: r.pauseAfter as Pause,
      emphasis: r.emphasis as string[],
      rising: r.rising === true,
      source: source ?? (['auto', 'manual', 'claude'].includes(r.source as string) ? (r.source as Segment['source']) : 'auto'),
    })
  }
  return out
}
