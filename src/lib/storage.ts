import { validateSegments, type Segment } from './types'

const KEY = 'voice-coach:v2'

export interface Saved {
  script: string
  /** Claude's direction, valid only while the script is unchanged */
  claude: { script: string; segments: Segment[] } | null
  /** mic gain and noise floor from the last level check */
  micGainDb: number | null
  noiseFloor: number | null
}

export function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    const segs = j.claude ? validateSegments(j.claude.segments, 'claude') : null
    return {
      script: typeof j.script === 'string' ? j.script : '',
      claude: segs && typeof j.claude.script === 'string' ? { script: j.claude.script, segments: segs } : null,
      micGainDb: typeof j.micGainDb === 'number' ? j.micGainDb : null,
      noiseFloor: typeof j.noiseFloor === 'number' ? j.noiseFloor : null,
    }
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
