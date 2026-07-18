import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { probe } from '../media/ffmpeg.js'
import { visualsVolumeStage } from './visuals-volume.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'

const cleanup: string[] = []

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

async function makeClip(file: string): Promise<void> {
  // 2s 640x360 testsrc2 + sine (same command as Task 10 fixture) — forces the crop path.
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file, '-y',
  ])
}

function makeChannel(bgDir: string): ChannelConfig {
  return {
    name: 'testchan',
    niche: ['space'],
    tierMix: { volume: 2, premium: 1 },
    voice: { volume: 'af_heart' },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir,
    bgmDir: tmp('brainrot-bgm-'),
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
  }
}

function makeCtx(runDir: string, channel: ChannelConfig): JobContext {
  return {
    jobId: 'job-visuals',
    db: openDb(':memory:'),
    channel,
    tier: 'volume',
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

function seedVoice(ctx: JobContext, durationMs: number): void {
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs }),
  )
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('visualsVolumeStage', () => {
  it('crops+loops a chosen clip to background.mp4 and records bg_usage', async () => {
    const bgDir = tmp('brainrot-bg-')
    await makeClip(path.join(bgDir, 'clip1.mp4'))
    await makeClip(path.join(bgDir, 'clip2.mp4'))
    const channel = makeChannel(bgDir)
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)

    await visualsVolumeStage.run(ctx)

    const p = await probe(ctx.artifactPath('visuals', 'background.mp4'))
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.durationMs).toBeGreaterThanOrEqual(2000) // >= narration durationMs

    const rows = ctx.db
      .prepare('SELECT file FROM bg_usage WHERE channel = ?')
      .all('testchan') as { file: string }[]
    expect(rows.length).toBe(1)
    expect(['clip1.mp4', 'clip2.mp4']).toContain(rows[0].file)
  }, 60000)

  it('excludes recently used clips (chooses the unused one)', async () => {
    const bgDir = tmp('brainrot-bg-')
    await makeClip(path.join(bgDir, 'clip1.mp4'))
    await makeClip(path.join(bgDir, 'clip2.mp4'))
    const channel = makeChannel(bgDir)
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)
    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run('testchan', 'clip1.mp4', new Date().toISOString())

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db
      .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 1')
      .all('testchan') as { file: string }[]
    expect(rows[0].file).toBe('clip2.mp4') // clip1 excluded as recently used
  }, 60000)

  it('throws when bgDir has no mp4 clips', async () => {
    const channel = makeChannel(tmp('brainrot-bg-empty-'))
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)
    await expect(visualsVolumeStage.run(ctx)).rejects.toThrow(/no .mp4 background clips/)
  })
})
