import { describe, expect, it } from 'vitest'
import { matchPosition, tokenize } from './matcher'
import { buildSchedule, wordAtTime } from './prompter'
import { directScript } from './direct'

const script = tokenize("Every rental car is driven by a stranger. 10% come back damaged.")

describe('matchPosition', () => {
  it('advances on exact words', () => expect(matchPosition(script, 0, ['every', 'rental', 'car'])).toBe(3))
  it('tolerates near-misses and skipped words', () => expect(matchPosition(script, 0, ['every', 'rentle', 'is'])).toBe(4))
  it('matches numbers without the % sign', () => expect(matchPosition(script, 8, ['10', 'come'])).toBe(10))
  it('ignores words beyond the look-ahead window', () => expect(matchPosition(script, 0, ['damaged'], 8)).toBe(0))
  it('never moves backward', () => expect(matchPosition(script, 5, ['every'])).toBe(5))
})

describe('timed schedule', () => {
  const segs = directScript('One two. Three four?')
  const s = buildSchedule(segs)
  it('uses segment pace and pauses', () => {
    // seg1 hook normal 150wpm = 400ms/word; seg1 is before-last → long pause 800ms; seg2 slow 500ms/word + question short pause 300ms
    expect(s.wordStart).toEqual([0, 400, 1600, 2100])
    expect(s.totalMs).toBe(2900)
  })
  it('holds on the last word through the pause', () => {
    expect(wordAtTime(s, 1000)).toBe(1)
    expect(wordAtTime(s, 1700)).toBe(2)
    expect(wordAtTime(s, 9999)).toBe(4)
  })
})
