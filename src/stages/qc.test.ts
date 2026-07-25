import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { qcStage } from './qc.js'
import { testChannel, testScript } from './_testkit.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'
import type { QcResult } from './qc.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

// Local ctx builder (not _testkit's makeCtx): qc tests control the runDir and
// budget overrides, and seed artifacts directly instead of running earlier
// stages. The channel comes from testChannel() so new required ChannelConfig
// fields stay centralized in the testkit.
function makeCtx(runDir: string, channelOverrides: Partial<ChannelConfig> = {}): JobContext {
  return {
    jobId: 'job-qc',
    db: openDb(':memory:'),
    channel: testChannel(channelOverrides),
    topic: 'test topic',
    runDir,
    artifactPath(stage, file) {
      const p = path.join(runDir, stage, file)
      mkdirSync(path.dirname(p), { recursive: true })
      return p
    },
    log: pino({ level: 'silent' }),
  }
}

function seedVoice(ctx: JobContext, durationMs = 1000): void {
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs }),
  )
}
function seedWords(ctx: JobContext): void {
  writeFileSync(
    ctx.artifactPath('captions', 'words.json'),
    JSON.stringify({
      words: [
        { word: 'a', startMs: 0, endMs: 300 },
        { word: 'b', startMs: 300, endMs: 650 },
        { word: 'c', startMs: 650, endMs: 1000 },
      ],
    }),
  )
}
const SENTENCE =
  'Venus spins backwards compared to every other planet orbiting our star and nobody really knows why.'
// `sentences` counts the hook plus the segments, matching how narrationText joins them.
function seedScript(ctx: JobContext, sentences: number, text = SENTENCE): void {
  writeFileSync(
    ctx.artifactPath('script', 'script.json'),
    JSON.stringify(testScript({ hook: text, segments: Array.from({ length: sentences - 1 }, () => text) })),
  )
}

async function goodClip(file: string, seconds = 2): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=1080x1920:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file, '-y',
  ])
}
async function blackClip(file: string): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=black:size=1080x1920:duration=2:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file, '-y',
  ])
}
async function silentFrozenClip(file: string): Promise<void> {
  // Static black video (frozen) + digital silence (anullsrc): trips both
  // frozen-frames (>= 2s freeze) and audio-level (mean_volume well below -50 dB).
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=black:size=1080x1920:duration=3:rate=30',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file, '-y',
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

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('qcStage', () => {
  it('passes a good clip (injectable minMs keeps the fixture short)', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(true)
    for (const c of result.checks) expect(c.passed).toBe(true)
  }, 120000)

  it('fails black-frames on an all-black clip', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await blackClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'black-frames')?.passed).toBe(false)
  }, 120000)

  it('fails captions-present when words.json is missing', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    // no words.json

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'captions-present')?.passed).toBe(false)
  }, 120000)

  it('fails narration-complete when the voice track is too short for the script', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx) // 1000ms
    seedWords(ctx)
    seedScript(ctx, 10) // 160 narration words -> needs >= 32000ms

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
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx) // 1000ms
    seedWords(ctx)
    seedScript(ctx, 1, 'Venus spins backwards.') // 3 words -> needs >= 600ms

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.find((c) => c.name === 'narration-complete')?.passed).toBe(true)
    expect(result.passed).toBe(true)
  }, 120000)

  it('fails audio-level and frozen-frames on a silent, static clip', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await silentFrozenClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'audio-level')?.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'frozen-frames')?.passed).toBe(false)
  }, 120000)

  it('runs exactly the fixed check list, in order', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual(CHECKS)
  }, 120000)
})
