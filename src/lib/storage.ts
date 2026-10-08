import { validateSegments, type Segment } from './types'

const KEY = 'voice-coach:v1'

export interface Saved {
  script: string
  segments: Segment[] | null
  useClaude: boolean
}

export function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    return {
      script: typeof j.script === 'string' ? j.script : '',
      segments: validateSegments(j.segments),
      useClaude: j.useClaude === true,
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
