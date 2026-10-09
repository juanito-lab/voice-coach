import type { MicChoice } from './devices'
import { validateSegments, type Segment } from './types'

const KEY = 'voice-coach:v2'

/** Result of a level check for one mic. Gain only makes sense for the mic it was measured on. */
export interface MicCal {
  gainDb: number
  /** noise floor in dBFS, measured after gain */
  noiseFloor: number | null
}

export interface Saved {
  script: string
  /** Claude's direction, valid only while the script is unchanged */
  claude: { script: string; segments: Segment[] } | null
  /** the mic picked in Setup; null = system default */
  mic: MicChoice | null
  /** level-check results per mic, keyed by deviceKey() */
  micCal: Record<string, MicCal>
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Validate whatever was stored. Unknown or broken fields fall back to defaults. */
export function parseSaved(j: unknown): Saved | null {
  if (typeof j !== 'object' || j === null) return null
  const r = j as Record<string, unknown>
  const c = r.claude as Record<string, unknown> | null | undefined
  const segs = c ? validateSegments(c.segments, 'claude') : null
  const m = r.mic as Record<string, unknown> | null | undefined
  const mic = m && typeof m.deviceId === 'string' && typeof m.label === 'string' ? { deviceId: m.deviceId, label: m.label } : null
  const micCal: Record<string, MicCal> = {}
  if (typeof r.micCal === 'object' && r.micCal !== null) {
    for (const [k, v] of Object.entries(r.micCal as Record<string, unknown>)) {
      const cal = v as Record<string, unknown> | null
      if (cal && isNum(cal.gainDb)) micCal[k] = { gainDb: cal.gainDb, noiseFloor: isNum(cal.noiseFloor) ? cal.noiseFloor : null }
    }
  }
  // Older versions stored one global micGainDb; it is ignored because we can't tell which mic it was for.
  return {
    script: typeof r.script === 'string' ? r.script : '',
    claude: segs && c && typeof c.script === 'string' ? { script: c.script, segments: segs } : null,
    mic,
    micCal,
  }
}

export function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parseSaved(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable: ignore */
  }
}
