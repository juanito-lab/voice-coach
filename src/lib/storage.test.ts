import { describe, expect, it } from 'vitest'
import { parseSaved } from './storage'

describe('parseSaved', () => {
  it('reads the mic choice and per-mic gain', () => {
    const s = parseSaved({
      script: 'Hi.',
      claude: null,
      mic: { deviceId: 'b2', label: 'Shure MVX2U' },
      micCal: { 'Shure MVX2U': { gainDb: 14, noiseFloor: -58 }, 'Built-in': { gainDb: 22 } },
    })
    expect(s).toEqual({
      script: 'Hi.',
      claude: null,
      mic: { deviceId: 'b2', label: 'Shure MVX2U' },
      micCal: { 'Shure MVX2U': { gainDb: 14, noiseFloor: -58 }, 'Built-in': { gainDb: 22, noiseFloor: null } },
    })
  })
  it('ignores the old global gain (it belonged to an unknown mic) and junk entries', () => {
    const s = parseSaved({ script: 'Hi.', micGainDb: 18, noiseFloor: -55, mic: { deviceId: 3 }, micCal: { x: { gainDb: 'loud' }, y: null } })
    expect(s?.mic).toBeNull()
    expect(s?.micCal).toEqual({})
  })
  it('rejects non-objects', () => {
    expect(parseSaved(null)).toBeNull()
    expect(parseSaved('x')).toBeNull()
  })
})
