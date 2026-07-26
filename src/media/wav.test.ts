import { describe, expect, it } from 'vitest'
import {
  encodePcmWav,
  parseWavDurationMs,
  pcmFromFloat32,
  silencePcm,
  trimTrailingSilence,
} from './wav.js'

const RATE = 24000 // kokoro's native sample rate

// Mono 16-bit PCM buffer from int16 sample values (small hand-built fixtures).
function pcm16(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2))
  return buf
}

// `loudMs` of a 440Hz sine at 0.5 amplitude followed by `silentMs` of zeros.
function sineThenSilence(loudMs: number, silentMs: number): Buffer {
  const loud = Math.round((loudMs / 1000) * RATE)
  const silent = Math.round((silentMs / 1000) * RATE)
  const samples = new Float32Array(loud + silent)
  for (let i = 0; i < loud; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE)
  return pcmFromFloat32(samples)
}

describe('trimTrailingSilence', () => {
  it('cuts a long silent tail down to keepMs past the last loud sample', () => {
    const pcm = sineThenSilence(1000, 3000) // 4s total, audible content ends at 1s
    const trimmed = trimTrailingSilence(pcm, RATE, 1)
    const frames = trimmed.length / 2
    // The last above-threshold sine sample sits within one 440Hz cycle
    // (~55 samples) of the 1s mark; default keepMs=250 leaves 6000 more frames.
    const expectedMax = Math.round(1.25 * RATE)
    expect(frames).toBeLessThanOrEqual(expectedMax)
    expect(frames).toBeGreaterThanOrEqual(expectedMax - 60)
    // Re-encoded, the chunk reads back as ~1250ms instead of 4000ms.
    const roundTripMs = parseWavDurationMs(encodePcmWav([trimmed], RATE, 1))
    expect(roundTripMs).toBeGreaterThanOrEqual(1245)
    expect(roundTripMs).toBeLessThanOrEqual(1250)
  })

  it('returns an all-silence buffer intact (never trims a chunk to zero)', () => {
    const pcm = pcm16(new Array(500).fill(0))
    const trimmed = trimTrailingSilence(pcm, RATE, 1)
    expect(trimmed.equals(pcm)).toBe(true)
    expect(trimmed.length).toBe(1000)
  })

  it('treats sub-threshold hiss as silence, but keeps it under a lower threshold', () => {
    // rate 100 keeps fixtures tiny: default keepMs 250 -> 25 frames kept.
    const rate = 100
    const values = [...new Array<number>(10).fill(5000), ...new Array<number>(100).fill(200)]
    // 200 < default threshold 330 -> the hiss is silence; cut to 10 loud + 25 kept.
    expect(trimTrailingSilence(pcm16(values), rate, 1).length / 2).toBe(35)
    // thresholdAmp 100 -> the hiss counts as signal; nothing follows it to trim.
    expect(trimTrailingSilence(pcm16(values), rate, 1, { thresholdAmp: 100 }).length / 2).toBe(110)
  })

  it('honours a custom keepMs', () => {
    const rate = 100
    const values = [...new Array<number>(10).fill(5000), ...new Array<number>(100).fill(0)]
    expect(trimTrailingSilence(pcm16(values), rate, 1, { keepMs: 500 }).length / 2).toBe(60)
  })

  it('never cuts past the end when the tail is shorter than keepMs', () => {
    const rate = 100
    // 50ms of tail < 250ms keep window: buffer comes back whole.
    const values = [...new Array<number>(10).fill(5000), ...new Array<number>(5).fill(0)]
    expect(trimTrailingSilence(pcm16(values), rate, 1).length / 2).toBe(15)
  })

  it('respects stereo interleaving: any-channel loudness, frame-aligned cut', () => {
    const rate = 100
    // 10 frames where only the RIGHT channel is loud, then 100 silent frames.
    const interleaved: number[] = []
    for (let i = 0; i < 10; i++) interleaved.push(0, 5000)
    for (let i = 0; i < 100; i++) interleaved.push(0, 0)
    const trimmed = trimTrailingSilence(pcm16(interleaved), rate, 2)
    expect(trimmed.length % 4).toBe(0) // whole L/R frames only
    expect(trimmed.length / 4).toBe(35) // 10 loud + 25 kept frames
    // Loud right-channel samples survive at their interleaved positions.
    expect(trimmed.readInt16LE(0)).toBe(0)
    expect(trimmed.readInt16LE(2)).toBe(5000)
  })
})

describe('silencePcm', () => {
  it('produces exactly durationMs of zeroed 16-bit PCM at the given rate/channels', () => {
    const pcm = silencePcm(500, RATE, 1)
    expect(pcm.length).toBe(Math.round((500 / 1000) * RATE) * 2) // 2 bytes/sample, mono
    expect(pcm.every((byte) => byte === 0)).toBe(true)
    expect(parseWavDurationMs(encodePcmWav([pcm], RATE, 1))).toBe(500)
  })

  it('accounts for channel count in the byte length', () => {
    const pcm = silencePcm(250, RATE, 2)
    expect(pcm.length).toBe(Math.round((250 / 1000) * RATE) * 2 * 2) // 2 channels
  })
})
