import { describe, expect, it } from 'vitest'
import { fmtDuration, pickBest, scoreOf, takeFileBase, takeIssues, type Take, type TakeScore } from './takes'

const t = (n: number, o: Partial<TakeScore> = {}): TakeScore => ({
  n,
  state: 'measured',
  lufs: -16.5,
  noiseFloorDb: -57,
  clips: 0,
  greenPct: 80,
  followed: 1,
  ...o,
})

describe('takeIssues', () => {
  it('a clean take qualifies', () => expect(takeIssues(t(1))).toEqual([]))
  it('names every problem', () => {
    expect(takeIssues(t(1, { clips: 2, noiseFloorDb: -45, lufs: -25, followed: 0.5 }))).toEqual([
      '2 clipped peaks',
      'noisy (floor above −50 dBFS)',
      'too quiet',
      'script not finished',
    ])
    expect(takeIssues(t(1, { lufs: -9 }))).toEqual(['too loud'])
    expect(takeIssues(t(1, { lufs: null }))).toEqual(['no speech'])
    expect(takeIssues(t(1, { state: 'measuring' }))).toEqual(['still measuring'])
    expect(takeIssues(t(1, { state: 'failed' }))).toEqual(["couldn't be measured"])
  })
  it('gate edges: −50 dBFS floor and ±6 LU pass', () => {
    expect(takeIssues(t(1, { noiseFloorDb: -50, lufs: -22 }))).toEqual([])
    expect(takeIssues(t(1, { lufs: -10 }))).toEqual([])
  })
})

describe('pickBest', () => {
  it('most time in the green wins', () => {
    expect(pickBest([t(1, { greenPct: 60 }), t(2, { greenPct: 85 }), t(3, { greenPct: 70 })])).toBe(2)
  })
  it('within 5 points, loudness closest to −16 LUFS wins', () => {
    expect(pickBest([t(1, { greenPct: 84, lufs: -19 }), t(2, { greenPct: 80, lufs: -16.2 })])).toBe(2)
  })
  it('more than 5 points behind, loudness does not save a take', () => {
    expect(pickBest([t(1, { greenPct: 86, lufs: -19 }), t(2, { greenPct: 80, lufs: -16 })])).toBe(1)
  })
  it('a clipped, noisy, quiet or unfinished take is never best', () => {
    const good = t(5, { greenPct: 50 })
    expect(pickBest([t(1, { greenPct: 95, clips: 1 }), good])).toBe(5)
    expect(pickBest([t(2, { greenPct: 95, noiseFloorDb: -44 }), good])).toBe(5)
    expect(pickBest([t(3, { greenPct: 95, lufs: -25 }), good])).toBe(5)
    expect(pickBest([t(4, { greenPct: 95, followed: 0.6 }), good])).toBe(5)
  })
  it('null when nothing qualifies or there are no takes', () => {
    expect(pickBest([t(1, { clips: 3 })])).toBeNull()
    expect(pickBest([])).toBeNull()
  })
  it('full tie → the earlier take', () => expect(pickBest([t(1), t(2)])).toBe(1))
})

describe('scoreOf', () => {
  it('maps a take record onto the rule inputs', () => {
    const take = { n: 3, status: 'ready', clips: 1, greenPct: 72, followed: 0.95, analysis: { lufs: -17.2, noiseFloorDb: -55 } } as unknown as Take
    expect(scoreOf(take)).toEqual({ n: 3, state: 'measured', lufs: -17.2, noiseFloorDb: -55, clips: 1, greenPct: 72, followed: 0.95 })
    expect(scoreOf({ ...take, status: 'measuring', analysis: null }).state).toBe('measuring')
    expect(scoreOf({ ...take, status: 'failed', analysis: null }).state).toBe('failed')
  })
})

describe('file names', () => {
  it('local date, time and take number', () => {
    expect(takeFileBase(new Date(2026, 9, 9, 14, 3, 59), 2)).toBe('voice-coach_2026-10-09_14-03_take2')
    expect(takeFileBase(new Date(2026, 0, 5, 9, 7), 11)).toBe('voice-coach_2026-01-05_09-07_take11')
  })
  it('durations', () => {
    expect(fmtDuration(41.3)).toBe('0:41')
    expect(fmtDuration(65)).toBe('1:05')
  })
})
