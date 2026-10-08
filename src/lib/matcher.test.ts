import { describe, expect, it } from 'vitest'
import { matchPosition, normalizeWord, tokenize } from './matcher'
import { buildSchedule, scriptWordList, wordAtTime, wordsDoneAt } from './prompter'
import { directScript } from './direct'

const SAMPLE =
  "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."
const script = scriptWordList(directScript(SAMPLE))

describe('matchPosition', () => {
  it('advances on exact words', () => expect(matchPosition(script, 0, ['every', 'rental', 'car'])).toBe(3))
  it('tolerates near-misses and skipped words', () => expect(matchPosition(script, 0, ['every', 'rentle', 'is'])).toBe(4))
  it('matches numbers without the % sign, and number words', () => {
    expect(matchPosition(script, 8, ['10', 'come'])).toBe(10)
    expect(matchPosition(script, 8, ['ten', 'percent', 'come'])).toBe(10)
  })
  it('never moves backward', () => expect(matchPosition(script, 5, ['every'])).toBe(5))
  it('a lone far word does not jump', () => expect(matchPosition(script, 0, ['guess'])).toBe(0))
  it('short words only match nearby', () => expect(matchPosition(script, 0, ['so'])).toBe(0))

  // Real Chrome transcript from a take where recognition missed the first line.
  it('recovers when the first line was not heard (real take)', () => {
    const heard = '10% come back damage only 3% build so who pays you do multidiscence to carve so you don\'t have to guess'.split(' ')
    expect(matchPosition(script, 0, heard)).toBe(script.length)
  })
  it('tracks word by word through the real take', () => {
    const heard = '10% come back damage only 3% build so who pays'.split(' ')
    const positions = heard.map((_, i) => matchPosition(script, 0, heard.slice(0, i + 1)))
    // "10%" alone can't re-anchor; with "come" both land; "build" ≈ "billed" skips the unheard "get"
    expect(positions).toEqual([0, 10, 11, 12, 13, 14, 16, 17, 18, 19])
  })
  it('a garbled brand name is skipped and the next phrase re-anchors', () => {
    expect(matchPosition(script, 22, ['multidiscence', 'to', 'the', 'car'])).toBe(26)
  })
  it('normalizes', () => {
    expect(normalizeWord('Ten')).toBe('10')
    expect(tokenize("Don't stop.")).toEqual(['dont', 'stop'])
  })
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
  it('wordsDoneAt counts finished words', () => {
    expect(wordsDoneAt(s, 0)).toBe(0)
    expect(wordsDoneAt(s, 400)).toBe(1)
    expect(wordsDoneAt(s, 1000)).toBe(2)
    expect(wordsDoneAt(s, 2600)).toBe(4)
  })
})
