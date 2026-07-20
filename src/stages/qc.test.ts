import { afterAll, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import type Anthropic from '@anthropic-ai/sdk'
import { openDb } from '../db/index.js'
import { qcStage } from './qc.js'
import { testChannel, testScript } from './_testkit.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext, Tier } from '../jobs/types.js'
import type { QcResult } from './qc.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

// Local ctx builder (not _testkit's makeCtx): qc tests control the tier, the
// runDir, and budget overrides, and seed artifacts directly instead of running
// earlier stages. The channel comes from testChannel() so new required
// ChannelConfig fields stay centralized in the testkit.
function makeCtx(
  runDir: string,
  tier: Tier = 'volume',
  channelOverrides: Partial<ChannelConfig> = {},
): JobContext {
  return {
    jobId: 'job-qc',
    db: openDb(':memory:'),
    channel: testChannel(channelOverrides),
    tier,
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

// Premium fixtures -----------------------------------------------------------

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
}

// 12 narration words total (hook 3 + 5 + 4) -> narration-complete floor 2400ms.
function seedScenesScript(ctx: JobContext): void {
  writeFileSync(
    ctx.artifactPath('script', 'script.json'),
    JSON.stringify({
      format: 'scenes',
      hook: 'Venus spins backwards',
      styleBlock: 'Muted retro-futurist palette, soft film grain, warm dusk lighting.',
      scenes: [
        {
          narration: 'Venus rotates the wrong way.',
          visualPrompt: 'Venus rotating against a dense starfield',
          motionPrompt: 'slow orbital drift',
        },
        {
          narration: 'Nobody knows exactly why.',
          visualPrompt: 'A glowing question mark nebula over a planet silhouette',
          motionPrompt: 'gentle zoom in',
        },
      ],
      platformMeta: PLATFORM_META,
    }),
  )
}

function seedManifest(ctx: JobContext, windows: [number, number][]): void {
  writeFileSync(
    ctx.artifactPath('visuals', 'scenes.json'),
    JSON.stringify({
      method: 'aligned',
      scenes: windows.map(([startMs, endMs], i) => ({
        index: i + 1,
        startMs,
        endMs,
        keyframe: `scene-${String(i + 1).padStart(2, '0')}.png`,
        clip: `scene-${String(i + 1).padStart(2, '0')}.mp4`,
        clipDurationSec: 5,
        imageAttempts: 1,
        videoAttempts: 1,
        costUsdMicros: 100_000,
      })),
    }),
  )
}

// Scene clip fixture: scene-coverage only probes duration ([3000,15000]ms), so a
// small, fast-encoding frame size keeps the fixture cheap. Video-only is fine —
// the check does not require clip audio (narration owns the audio track).
async function sceneClip(file: string, seconds = 5): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=180x320:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    file, '-y',
  ])
}

// A full premium artifact set that passes every check: 4s final.mp4, 3900ms
// voice (safely under the probed video duration so duration-bounds holds), two
// windows tiling [0, 3900] exactly, and two 5s clips on disk.
async function seedPremiumHappyPath(ctx: JobContext): Promise<void> {
  await goodClip(ctx.artifactPath('assemble', 'final.mp4'), 4)
  seedVoice(ctx, 3900)
  seedWords(ctx)
  seedScenesScript(ctx)
  seedManifest(ctx, [[0, 2000], [2000, 3900]])
  await sceneClip(ctx.artifactPath('visuals', 'scene-01.mp4'))
  await sceneClip(ctx.artifactPath('visuals', 'scene-02.mp4'))
}

// Same shape as anthropic.test.ts's fakeClient: visionJudgment is real, only the
// SDK client underneath it is faked.
function fakeVisionClient(emitInput: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'emit', id: 't1', input: emitInput }],
    usage: { input_tokens: 3000, output_tokens: 50 },
  })
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

const VOLUME_CHECKS = [
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

  it('volume tier: runs exactly the Plan 1 checks, in order — no premium checks', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual(VOLUME_CHECKS)
  }, 120000)
})

describe('qcStage premium: scene-coverage', () => {
  it('passes when windows tile [0, voice.durationMs] and all clips probe sane', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(true)
    expect(check?.detail).toMatch(/2 scenes/)
  }, 120000)

  it('fails and names the gap when windows do not tile', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    seedManifest(ctx, [[0, 2000], [2500, 3900]]) // 500ms hole between the scenes

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/ends at 2000ms/)
    expect(check?.detail).toMatch(/starts at 2500ms/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails when the manifest is missing', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    rmSync(ctx.artifactPath('visuals', 'scenes.json'))

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/scenes\.json/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails and names the missing clip file', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    rmSync(ctx.artifactPath('visuals', 'scene-02.mp4'))

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/clip missing: scene-02\.mp4/)
  }, 120000)

  it('fails when a clip probes outside the sane duration bounds', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    await sceneClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1) // 1s clip, under the 3000ms floor

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/scene-02\.mp4 probes \d+ms, outside/)
  }, 120000)
})

describe('qcStage premium: vision-spot-check', () => {
  it('extracts three frames, calls visionJudgment with scene intents, records cost, passes', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client, create } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual([...VOLUME_CHECKS, 'scene-coverage', 'vision-spot-check'])
    expect(result.checks.find((c) => c.name === 'vision-spot-check')?.passed).toBe(true)
    expect(result.passed).toBe(true)

    // One vision call: three PNG frame blocks, then a text prompt listing every
    // scene's visualPrompt (visionJudgment's binding block layout).
    expect(create).toHaveBeenCalledTimes(1)
    const request = create.mock.calls[0][0]
    expect(request.model).toBe('claude-sonnet-5') // channel.scriptModel from testChannel()
    const content = request.messages[0].content as { type: string; text?: string }[]
    expect(content.filter((b) => b.type === 'image')).toHaveLength(3)
    const last = content[content.length - 1]
    expect(last.type).toBe('text')
    expect(last.text).toContain('Scene 1: Venus rotating against a dense starfield')
    expect(last.text).toContain('Scene 2: A glowing question mark nebula over a planet silhouette')

    // The paid call is ledgered: 3000 in x $3/MTok + 50 out x $15/MTok = 9750 usd-micros.
    const costs = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId) as { provider: string; operation: string; usd_micros: number }[]
    expect(costs).toEqual([{ provider: 'anthropic', operation: 'qc-vision', usd_micros: 9750 }])
  }, 120000)

  it('fails with the model issues in detail when the model rejects the frames', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client } = fakeVisionClient({
      pass: false,
      issues: ['scenes appear out of order', 'captions obscure the subject'],
    })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toBe('scenes appear out of order; captions obscure the subject')
    // The premium checks are independent: coverage still passed on the same run.
    expect(result.checks.find((c) => c.name === 'scene-coverage')?.passed).toBe(true)
    expect(result.passed).toBe(false)
  }, 120000)

  it('degrades a provider error to a failed check instead of crashing the stage', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const create = vi.fn().mockRejectedValue(new Error('anthropic 529 overloaded'))
    const client = { messages: { create } } as unknown as Anthropic

    // Must resolve — a flaky provider parks the job needs-review, never failed.
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toContain('anthropic 529 overloaded')
    expect(result.checks.find((c) => c.name === 'scene-coverage')?.passed).toBe(true)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails closed at zero spend when the premium per-video budget is exhausted', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium', {
      // Premium per-video cap (1000 micros) below the 15_000-micro vision estimate:
      // assertBudget(..., 'premium') must throw before the client is touched.
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 1_000, perDayUsdMicros: 20_000_000 },
    })
    await seedPremiumHappyPath(ctx)
    const { client, create } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/premium/) // Task 6: the message names the tripped cap
    expect(create).not.toHaveBeenCalled()
    // Nothing ledgered: the breach happened before the paid call.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
  }, 120000)
})
