import { describe, expect, it } from 'vitest'
import { directScript } from './direct'

const SAMPLE =
  "Every rental car is driven by a stranger. 10% come back damaged. Only 3% get billed. So who pays? You do. MantAI listens to the car so you don't have to guess."

describe('directScript — sample script', () => {
  const segs = directScript(SAMPLE)
  const pick = (i: number) => {
    const s = segs[i]
    return { text: s.text, pace: s.pace, energy: s.energy, pauseAfter: s.pauseAfter, emphasis: s.emphasis, rising: s.rising }
  }

  it('splits into 6 segments', () => expect(segs).toHaveLength(6))
  it('S1 hook: normal pace, punch', () =>
    expect(pick(0)).toEqual({ text: 'Every rental car is driven by a stranger.', pace: 'normal', energy: 'punch', pauseAfter: 'none', emphasis: [], rising: false }))
  it('S2 stat: slow, emphasis 10%', () =>
    expect(pick(1)).toMatchObject({ pace: 'slow', energy: 'normal', emphasis: ['10%'], pauseAfter: 'none' }))
  it('S3 stat: slow, emphasis 3%', () =>
    expect(pick(2)).toMatchObject({ pace: 'slow', energy: 'normal', emphasis: ['3%'], pauseAfter: 'none' }))
  it('S4 question: rising, short pause', () =>
    expect(pick(3)).toMatchObject({ text: 'So who pays?', pace: 'normal', rising: true, pauseAfter: 'short' }))
  it('S5 before CTA: long pause', () =>
    expect(pick(4)).toMatchObject({ text: 'You do.', pace: 'normal', energy: 'normal', pauseAfter: 'long' }))
  it('S6 CTA: slow + punch', () =>
    expect(pick(5)).toMatchObject({ pace: 'slow', energy: 'punch', pauseAfter: 'none' }))
})

describe('manual markup', () => {
  it('overrides pace, adds long pause and emphasis', () => {
    const segs = directScript('[fast]a, b, c[/fast] // *now*')
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ text: 'a, b, c', pace: 'fast', pauseAfter: 'long', source: 'manual' })
    expect(segs[1]).toMatchObject({ text: 'now', emphasis: ['now'], source: 'manual' })
  })

  it('loud/soft map to punch/soft and split segments at tag changes', () => {
    const segs = directScript('Hello there [soft]quiet bit[/soft] and [loud]big finish[/loud] then calm.')
    expect(segs.map((s) => [s.text, s.energy])).toEqual([
      ['Hello there', 'punch'],
      ['quiet bit', 'soft'],
      ['and', 'normal'],
      ['big finish', 'punch'],
      ['then calm.', 'punch'],
    ])
  })

  it('single slash is a short pause, multi-word emphasis works, 24/7 stays a word', () => {
    const segs = directScript('We run *24/7 support* / always. Done.')
    expect(segs[0]).toMatchObject({ text: 'We run 24/7 support', pauseAfter: 'short' })
    expect(segs[0].emphasis).toEqual(expect.arrayContaining(['24/7', 'support']))
  })

  it('splits sentences over 20 words at semicolons', () => {
    const long = 'one two three four five six seven eight nine ten eleven; twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.'
    expect(directScript(long)).toHaveLength(2)
  })
})
