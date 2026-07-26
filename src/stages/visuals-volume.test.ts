import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { probe } from '../media/ffmpeg.js'
import { visualsVolumeStage } from './visuals-volume.js'
import { DEFAULT_SCOUT } from '../config/channel.js'
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
    file,
    '-y',
  ])
}

function makeChannel(bgDir: string | string[]): ChannelConfig {
  return {
    name: 'testchan',
    niche: ['space'],
    videosPerDay: 2,
    voice: { volume: 'af_heart' },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: Array.isArray(bgDir) ? bgDir : [bgDir],
    bgmDir: tmp('brainrot-bgm-'),
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    scout: { ...DEFAULT_SCOUT },
    publish: null,
  }
}

function makeCtx(runDir: string, channel: ChannelConfig): JobContext {
  return {
    jobId: 'job-visuals',
    db: openDb(':memory:'),
    channel,
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

    const rows = ctx.db.prepare('SELECT file FROM bg_usage WHERE channel = ?').all('testchan') as {
      file: string
    }[]
    expect(rows.length).toBe(1)
    expect([path.resolve(bgDir, 'clip1.mp4'), path.resolve(bgDir, 'clip2.mp4')]).toContain(
      rows[0].file,
    )
  }, 60000)

  it('excludes recently used clips (chooses the unused one)', async () => {
    const bgDir = tmp('brainrot-bg-')
    const clip1 = path.join(bgDir, 'clip1.mp4')
    const clip2 = path.join(bgDir, 'clip2.mp4')
    await makeClip(clip1)
    await makeClip(clip2)
    const channel = makeChannel(bgDir)
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)
    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run('testchan', path.resolve(clip1), new Date().toISOString())

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db
      .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 1')
      .all('testchan') as { file: string }[]
    expect(rows[0].file).toBe(path.resolve(clip2)) // clip1 excluded as recently used
  }, 60000)

  it('throws when bgDir has no mp4 clips', async () => {
    const channel = makeChannel(tmp('brainrot-bg-empty-'))
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)
    await expect(visualsVolumeStage.run(ctx)).rejects.toThrow(/no .mp4 background clips/)
  })

  it('discovers clips nested in subfolders', async () => {
    const bgDir = tmp('brainrot-bg-')
    const sub = path.join(bgDir, 'minecraft-parkour')
    mkdirSync(sub, { recursive: true })
    const nestedClip = path.join(sub, 'clip1.mp4')
    await makeClip(nestedClip)
    const channel = makeChannel(bgDir)
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db.prepare('SELECT file FROM bg_usage WHERE channel = ?').all('testchan') as {
      file: string
    }[]
    expect(rows[0].file).toBe(path.resolve(nestedClip))
  }, 60000)

  it('ignores non-mp4 files in subfolders', async () => {
    const bgDir = tmp('brainrot-bg-')
    const sub = path.join(bgDir, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'notes.txt'), 'not a clip')
    const clip = path.join(sub, 'clip1.mp4')
    await makeClip(clip)
    const channel = makeChannel(bgDir)
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db.prepare('SELECT file FROM bg_usage WHERE channel = ?').all('testchan') as {
      file: string
    }[]
    expect(rows[0].file).toBe(path.resolve(clip))
  }, 60000)

  it('pools clips from multiple configured roots', async () => {
    const rootA = tmp('brainrot-bg-a-')
    const rootB = tmp('brainrot-bg-b-')
    const clipA = path.join(rootA, 'clipA.mp4')
    const clipB = path.join(rootB, 'clipB.mp4')
    await makeClip(clipA)
    await makeClip(clipB)
    const channel = makeChannel([rootA, rootB])
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db.prepare('SELECT file FROM bg_usage WHERE channel = ?').all('testchan') as {
      file: string
    }[]
    expect([path.resolve(clipA), path.resolve(clipB)]).toContain(rows[0].file)
  }, 60000)

  it('treats same-basename clips in different roots as distinct pool entries', async () => {
    const rootA = tmp('brainrot-bg-a-')
    const rootB = tmp('brainrot-bg-b-')
    const clipA = path.join(rootA, 'clip.mp4') // same basename, different roots
    const clipB = path.join(rootB, 'clip.mp4')
    await makeClip(clipA)
    await makeClip(clipB)
    const channel = makeChannel([rootA, rootB])
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)
    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run('testchan', path.resolve(clipA), new Date().toISOString())

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db
      .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 1')
      .all('testchan') as { file: string }[]
    // clipA was recently used, so despite sharing a basename with clipB the
    // resolved-path key correctly excludes only clipA, not both.
    expect(rows[0].file).toBe(path.resolve(clipB))
  }, 60000)

  it('tolerates a missing root as long as another configured root has clips', async () => {
    const goodRoot = tmp('brainrot-bg-good-')
    const missingRoot = path.join(tmpdir(), 'brainrot-bg-does-not-exist')
    const clip = path.join(goodRoot, 'clip1.mp4')
    await makeClip(clip)
    const channel = makeChannel([missingRoot, goodRoot])
    const ctx = makeCtx(tmp('brainrot-run-'), channel)
    seedVoice(ctx, 2000)

    await visualsVolumeStage.run(ctx)

    const rows = ctx.db.prepare('SELECT file FROM bg_usage WHERE channel = ?').all('testchan') as {
      file: string
    }[]
    expect(rows[0].file).toBe(path.resolve(clip))
  }, 60000)
})
