import { describe, expect, it } from 'vitest'
import { audioInputs, cleanLabel, defaultInputLabel, deviceKey, labelsVisible, matchDevice, micNeedsReopen } from './devices'

const mic = (deviceId: string, label: string) => ({ kind: 'audioinput', deviceId, label, groupId: 'g' })
const CHROME = [
  mic('default', 'Default - MacBook Pro Microphone (Built-in)'),
  mic('a1', 'MacBook Pro Microphone (Built-in)'),
  mic('b2', 'Shure MVX2U (14ed:1019)'),
  { kind: 'audiooutput', deviceId: 'o1', label: 'MacBook Pro Speakers (Built-in)', groupId: 'g' },
]
/** What Chrome returns before mic permission: one anonymous entry per kind. */
const NO_PERMISSION = [mic('', ''), { kind: 'audiooutput', deviceId: '', label: '', groupId: '' }]

describe('device list', () => {
  it('keeps real inputs only, in order', () => {
    expect(audioInputs(CHROME).map((d) => d.deviceId)).toEqual(['a1', 'b2'])
  })
  it('drops the anonymous pre-permission entry', () => {
    expect(audioInputs(NO_PERMISSION)).toEqual([])
    expect(labelsVisible(NO_PERMISSION)).toBe(false)
    expect(labelsVisible(CHROME)).toBe(true)
  })
  it('names the OS default without the "Default - " prefix', () => {
    expect(defaultInputLabel(CHROME)).toBe('MacBook Pro Microphone (Built-in)')
    expect(defaultInputLabel(NO_PERMISSION)).toBeNull()
  })
  it('one physical mic has one key, whichever entry it came from', () => {
    expect(cleanLabel('Communications - Headset Mic')).toBe('Headset Mic')
    expect(deviceKey({ deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' })).toBe(deviceKey(CHROME[1]))
    expect(deviceKey({ deviceId: 'xyz', label: '' })).toBe('xyz')
  })
})

describe('matchDevice', () => {
  const inputs = audioInputs(CHROME)
  it('null choice = system default', () => expect(matchDevice(inputs, null)).toBeNull())
  it('matches by id first', () => expect(matchDevice(inputs, { deviceId: 'b2', label: 'something else' })?.deviceId).toBe('b2'))
  it('falls back to the label when the id changed', () => {
    expect(matchDevice(inputs, { deviceId: 'old-id', label: 'Shure MVX2U (14ed:1019)' })?.deviceId).toBe('b2')
  })
  it('returns null when the mic is not plugged in', () => {
    expect(matchDevice(inputs, { deviceId: 'old-id', label: 'Rode NT-USB' })).toBeNull()
    expect(matchDevice(inputs, { deviceId: 'old-id', label: '' })).toBeNull()
  })
})

describe('micNeedsReopen', () => {
  const shure = { deviceId: 'b2', label: 'Shure MVX2U (14ed:1019)' }
  const builtIn = { deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' }
  it('reopens when the open track ended (unplugged)', () => expect(micNeedsReopen(CHROME, null, builtIn, false)).toBe(true))
  it('stays put when the open mic is the chosen one', () => expect(micNeedsReopen(CHROME, shure, shure, true)).toBe(false))
  it('switches back when the chosen mic is plugged in again', () => expect(micNeedsReopen(CHROME, shure, builtIn, true)).toBe(true))
  it('follows the OS default when no mic is chosen', () => {
    expect(micNeedsReopen(CHROME, null, builtIn, true)).toBe(false)
    expect(micNeedsReopen(CHROME, null, shure, true)).toBe(true)
  })
  it('does nothing when it cannot tell what the default is', () => {
    const noDefault = CHROME.filter((d) => d.deviceId !== 'default')
    expect(micNeedsReopen(noDefault, null, shure, true)).toBe(false)
  })
})
