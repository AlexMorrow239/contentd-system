import { beforeAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { copyFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { qcStage } from './qc.js'
import { testChannel } from '../testing/channel.js'
import { makeCtx, seedScriptJson, seedVoiceJson, seedWordsJson } from '../testing/job.js'
import { tmpDir } from '../testing/tmp.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'
import type { QcResult } from './qc.js'

/**
 * qc seeds stage artifacts directly rather than running earlier stages, so it
 * pins its own jobId and runDir through makeCtx's options bag.
 */
function qcCtx(channelOverrides: Partial<ChannelConfig> = {}): JobContext {
  return makeCtx({
    channel: testChannel(channelOverrides),
    topic: 'test topic',
    jobId: 'job-qc',
    runDir: tmpDir('brainrot-run-'),
  })
}

/**
 * goodClip was re-encoded by five of the seven tests. Encoding a 1080x1920
 * H.264 clip is the single most expensive fixture in the suite, so it is built
 * once per worker and copied into place. blackClip and silentFrozenClip are
 * used once each and stay inline.
 *
 * The five tests share content but not the file, and none of them mutates it
 * — qcStage only reads final.mp4 (three ffprobe/ffmpeg analysis passes).
 */
let goodSource: string

beforeAll(async () => {
  goodSource = path.join(tmpDir('brainrot-qc-fixtures-'), 'good.mp4')
  await goodClip(goodSource)
}, 120000)

function placeGoodClip(ctx: JobContext): void {
  copyFileSync(goodSource, ctx.artifactPath('assemble', 'final.mp4'))
}

async function goodClip(file: string, seconds = 2): Promise<void> {
  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${seconds}:size=1080x1920:rate=30`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file,
    '-y',
  ])
}
async function blackClip(file: string): Promise<void> {
  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'color=black:size=1080x1920:duration=2:rate=30',
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
    file,
    '-y',
  ])
}
async function silentFrozenClip(file: string): Promise<void> {
  // Static black video (frozen) + digital silence (anullsrc): trips both
  // frozen-frames (>= 2s freeze) and audio-level (mean_volume well below -50 dB).
  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'color=black:size=1080x1920:duration=3:rate=30',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=mono:sample_rate=44100',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file,
    '-y',
  ])
}

const CHECKS = [
  'duration-bounds',
  'resolution',
  'has-audio',
  'audio-level',
  'fps',
  'captions-present',
  'narration-complete',
  'black-frames',
  'frozen-frames',
  'file-size',
]

describe('qcStage', () => {
  it('passes a good clip (injectable minMs keeps the fixture short)', async () => {
    const ctx = qcCtx()
    placeGoodClip(ctx)
    seedVoiceJson(ctx)
    seedWordsJson(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(true)
    for (const c of result.checks) expect(c.passed).toBe(true)
  }, 120000)

  it('fails black-frames on an all-black clip', async () => {
    const ctx = qcCtx()
    await blackClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoiceJson(ctx)
    seedWordsJson(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'black-frames')?.passed).toBe(false)
  }, 120000)

  it('fails captions-present when words.json is missing', async () => {
    const ctx = qcCtx()
    placeGoodClip(ctx)
    seedVoiceJson(ctx)
    // no words.json

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'captions-present')?.passed).toBe(false)
  }, 120000)

  it('fails narration-complete when the voice track is too short for the script', async () => {
    const ctx = qcCtx()
    placeGoodClip(ctx)
    seedVoiceJson(ctx) // 1000ms
    seedWordsJson(ctx)
    seedScriptJson(ctx, 10) // 160 narration words -> needs >= 32000ms

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'narration-complete')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/160 words/)
    expect(check?.detail).toMatch(/1000/)
    expect(check?.detail).toMatch(/32000/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('passes narration-complete when the voice track is long enough', async () => {
    const ctx = qcCtx()
    placeGoodClip(ctx)
    seedVoiceJson(ctx) // 1000ms
    seedWordsJson(ctx)
    seedScriptJson(ctx, 1, 'Venus spins backwards.') // 3 words -> needs >= 600ms

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.find((c) => c.name === 'narration-complete')?.passed).toBe(true)
    expect(result.passed).toBe(true)
  }, 120000)

  it('fails audio-level and frozen-frames on a silent, static clip', async () => {
    const ctx = qcCtx()
    await silentFrozenClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoiceJson(ctx)
    seedWordsJson(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'audio-level')?.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'frozen-frames')?.passed).toBe(false)
  }, 120000)

  it('runs exactly the fixed check list, in order', async () => {
    const ctx = qcCtx()
    placeGoodClip(ctx)
    seedVoiceJson(ctx)
    seedWordsJson(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual(CHECKS)
  }, 120000)
})
