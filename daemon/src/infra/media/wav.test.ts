import { describe, expect, it } from 'vitest'
import { encodePcmWav, parseWavDurationMs } from './wav.js'

describe('parseWavDurationMs', () => {
  it('computes duration from PCM size and sample rate', () => {
    expect(parseWavDurationMs(encodePcmWav([Buffer.alloc(32_000)], 16_000, 1))).toBe(1000)
    expect(parseWavDurationMs(encodePcmWav([Buffer.alloc(16_000)], 16_000, 1))).toBe(500)
  })

  it('rejects non-RIFF buffers', () => {
    expect(() => parseWavDurationMs(Buffer.from('not a wav file at all'))).toThrow(/RIFF/)
  })
})
