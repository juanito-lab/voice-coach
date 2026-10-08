import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM header and samples', () => {
    const buf = encodeWav([new Float32Array([0, 1, -1, 0.5])], 48000)
    const v = new DataView(buf)
    const s = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4))
    expect(buf.byteLength).toBe(44 + 8)
    expect(s(0)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 8)
    expect(s(8)).toBe('WAVE')
    expect(s(12)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(96000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(s(36)).toBe('data')
    expect(v.getUint32(40, true)).toBe(8)
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383])
  })
  it('interleaves stereo', () => {
    const buf = encodeWav([new Float32Array([1]), new Float32Array([-1])], 44100)
    const v = new DataView(buf)
    expect(v.getUint16(22, true)).toBe(2)
    expect(v.getInt16(44, true)).toBe(32767)
    expect(v.getInt16(46, true)).toBe(-32768)
  })
})
