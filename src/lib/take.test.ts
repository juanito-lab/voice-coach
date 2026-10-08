import { describe, expect, it } from 'vitest'
import { directScript } from './direct'
import { segmentWords } from './prompter'
import { TakeTracker, type Live } from './take'
import { PACE_WPM, PAUSE_SEC } from './types'

const SAMPLE =
  "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."
const segs = directScript(SAMPLE)

/** Simulated reader: each word's end time when reading at `speed` × target pace, honouring pauses. */
function readTimes(speed: number, start = 1000): { word: string; end: number }[] {
  const out: { word: string; end: number }[] = []
  let t = start
  for (const s of segs) {
    const per = 60000 / (PACE_WPM[s.pace] * speed)
    for (const w of segmentWords(s)) {
      t += per
      out.push({ word: w, end: t })
    }
    t += PAUSE_SEC[s.pauseAfter] * 1000
  }
  return out
}

/** Run a take with Chrome-like recognition lag; returns the live state at every 100 ms tick. */
function simulate(speed: number, lagMs = 400, drop: string[] = []) {
  const times = readTimes(speed)
  const t = new TakeTracker(segs, 'speech')
  t.start(1000)
  const ticks: (Live & { now: number })[] = []
  const endT = times[times.length - 1].end + 2000
  for (let now = 1000; now <= endT; now += 100) {
    t.setHeard(times.filter((w) => w.end + lagMs <= now && !drop.includes(w.word)).map((w) => w.word))
    ticks.push({ ...t.tick(now, true, -16), now })
  }
  return { t, ticks }
}

const share = (ticks: Live[], pred: (l: Live) => boolean) => ticks.filter(pred).length / ticks.length

describe('TakeTracker — speech mode', () => {
  it('follows every word of the script at target pace', () => {
    const { t, ticks } = simulate(1)
    expect(t.followed).toBe(1)
    expect(ticks.at(-1)!.done).toBe(true)
    // position never goes backwards
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].pos).toBeGreaterThanOrEqual(ticks[i - 1].pos)
  })

  it('at target pace the pacer signal stays green (never ahead, ~never behind)', () => {
    const { ticks } = simulate(1)
    const active = ticks.filter((l) => l.pace !== 'idle')
    expect(share(active, (l) => l.pace === 'ahead')).toBe(0)
    expect(share(active, (l) => l.pace === 'on')).toBeGreaterThan(0.9)
  })

  it('reading 1.6× too fast shows "ahead" (blue)', () => {
    const { ticks } = simulate(1.6)
    const active = ticks.filter((l) => l.pace !== 'idle')
    expect(share(active, (l) => l.pace === 'ahead')).toBeGreaterThan(0.25)
    expect(share(active, (l) => l.pace === 'behind')).toBe(0)
  })

  it('reading at 0.6× shows "behind" (amber)', () => {
    const { ticks } = simulate(0.6)
    const active = ticks.filter((l) => l.pace !== 'idle')
    expect(share(active, (l) => l.pace === 'behind')).toBeGreaterThan(0.25)
    expect(share(active, (l) => l.pace === 'ahead')).toBe(0)
  })

  it('shows each line in order and holds for the long pause before the CTA', () => {
    const { ticks } = simulate(1)
    const order = [...new Set(ticks.map((l) => l.cur))]
    expect(order).toEqual([0, 1, 2, 3, 4, 5])
    const holdsBeforeCta = ticks.filter((l) => l.cur === 5 && l.hold > 0)
    expect(holdsBeforeCta.length).toBeGreaterThanOrEqual(5) // ≥0.5 s of the 0.8 s hold visible
  })

  it('per-line wpm lands near each target', () => {
    const { t } = simulate(1)
    const r = t.results()
    expect(r[0].pace).toBe('on') // 8 words @150
    expect(r[5].pace).toBe('on') // CTA 12 words @120
    expect(r[3].wpm).toBeNull() // "So who pays?" too short to judge
  })

  it('still follows to the end when recognition drops words', () => {
    const { t } = simulate(1, 400, ['Every', 'rental', 'billed.', 'MantAI'])
    expect(t.followed).toBe(1)
  })
})

describe('TakeTracker — timed mode', () => {
  it('walks the schedule and is always "on" once a line starts', () => {
    const t = new TakeTracker(segs, 'timed')
    t.start(0)
    const lives: Live[] = []
    for (let now = 0; now < t.schedule.totalMs + 500; now += 100) lives.push(t.tick(now))
    expect(lives.at(-1)!.done).toBe(true)
    expect(lives.every((l) => l.pace === 'on' || l.pace === 'idle')).toBe(true)
  })
})
