import { execa } from 'execa'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { tmpDir } from '../../../testing/tmp.js'
import { cropAndLoopToDuration, cropToVertical, loopToDuration, probe } from './ffmpeg.js'

let dir: string
let fixture: string

beforeAll(async () => {
  dir = tmpDir('brainrot-ffmpeg-')
  fixture = path.join(dir, 'fixture.mp4')
  // 2s 640x360 testsrc2 video + 440Hz sine audio, H.264 + AAC.
  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=duration=2:size=640x360:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    fixture,
    '-y',
  ])
}, 60000)

describe('probe', () => {
  it('rejects a pre-cancelled operation before launching ffprobe', async () => {
    const lost = new Error('lease lost')
    await expect(probe('does-not-exist.mp4', AbortSignal.abort(lost))).rejects.toBe(lost)
  })

  it('terminates a running encode when cancelled', async () => {
    const controller = new AbortController()
    const encoding = loopToDuration(
      fixture,
      path.join(dir, 'cancelled.mp4'),
      3_600_000,
      controller.signal,
    )
    const timer = setTimeout(() => controller.abort(new Error('lease lost')), 40)
    try {
      await expect(encoding).rejects.toMatchObject({ isCanceled: true })
    } finally {
      clearTimeout(timer)
    }
  })

  it('reports duration, dimensions, audio presence, and fps', async () => {
    const p = await probe(fixture)
    expect(p.width).toBe(640)
    expect(p.height).toBe(360)
    expect(p.hasAudio).toBe(true)
    expect(p.fps).toBe(30)
    expect(Number.isInteger(p.durationMs)).toBe(true)
    expect(p.durationMs).toBeGreaterThanOrEqual(1900)
    expect(p.durationMs).toBeLessThanOrEqual(2100)
  })
})

describe('cropToVertical', () => {
  it('produces a 1080x1920 clip', async () => {
    const out = path.join(dir, 'cropped.mp4')
    await cropToVertical(fixture, out)
    const p = await probe(out)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
  })
})

describe('loopToDuration', () => {
  it('loops the source to at least the requested duration', async () => {
    const out = path.join(dir, 'looped.mp4')
    await loopToDuration(fixture, out, 5000)
    const p = await probe(out)
    expect(p.durationMs).toBeGreaterThan(2000) // longer than the 2s source
    expect(p.durationMs).toBeGreaterThanOrEqual(4900) // reached ~5s target (ffmpeg -t trims to <= requested; one-frame tolerance)
  })
})

describe('cropAndLoopToDuration', () => {
  it('matches crop-then-loop in one encode: 1080x1920 at the requested duration', async () => {
    const out = path.join(dir, 'cropped-looped.mp4')
    await cropAndLoopToDuration(fixture, out, 5000)
    const p = await probe(out)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.durationMs).toBeGreaterThan(2000) // longer than the 2s source
    expect(p.durationMs).toBeGreaterThanOrEqual(4900)
  })
})
