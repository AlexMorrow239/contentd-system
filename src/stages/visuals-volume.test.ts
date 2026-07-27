import { beforeAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { probe } from '../media/ffmpeg.js'
import { visualsVolumeStage } from './visuals-volume.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'
import { testChannel } from '../testing/channel.js'
import { makeCtx, seedVoiceJson } from '../testing/job.js'
import { tmpDir } from '../testing/tmp.js'

/**
 * Two cost profiles, because these tests ask two different questions.
 *
 * The stage always crops the WHOLE source clip to 1080x1920 and then loops it
 * to narration+PAD_MS, so runtime scales with source duration and target
 * duration, not with the assertion. Only `crops+loops ...` actually inspects
 * the encoded output; every other test asserts which clip landed in bg_usage
 * and would pass against a one-frame video. Giving the selection tests a
 * 0.2s 320x180 source and a 100ms narration cuts them from ~3-13s each to
 * well under a second, and took this file off the suite's critical path
 * (45.9s -> see the note in CLAUDE.md).
 */
const OUTPUT_CLIP = { seconds: 2, size: '640x360' }
const SELECTION_CLIP = { seconds: 0.2, size: '320x180' }

async function encodeClip(file: string, spec: { seconds: number; size: string }): Promise<void> {
  // Non-1080x1920 on purpose: forces the stage's crop path.
  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=duration=${spec.seconds}:size=${spec.size}:rate=30`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${spec.seconds}`,
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

// Encoded once per worker instead of once per call — makeClip ran 11 times.
let outputSource: string
let selectionSource: string

beforeAll(async () => {
  const dir = tmpDir('brainrot-clip-src-')
  outputSource = path.join(dir, 'output.mp4')
  selectionSource = path.join(dir, 'selection.mp4')
  await Promise.all([
    encodeClip(outputSource, OUTPUT_CLIP),
    encodeClip(selectionSource, SELECTION_CLIP),
  ])
}, 60000)

/**
 * Copies a prebuilt clip to `file`. Content is shared; the path is not —
 * several tests assert on resolved paths, and one deliberately puts the same
 * basename in two different roots.
 */
function placeClip(file: string, source = selectionSource): void {
  mkdirSync(path.dirname(file), { recursive: true })
  copyFileSync(source, file)
}

function channelFor(bgDir: string | string[]): ChannelConfig {
  return testChannel({
    name: 'testchan',
    bgDir: Array.isArray(bgDir) ? bgDir : [bgDir],
    bgmDir: tmpDir('brainrot-bgm-'),
  })
}

/** A ctx whose narration is short enough that the loop step is near-free. */
function selectionCtx(channel: ChannelConfig): JobContext {
  const ctx = makeCtx({ channel, jobId: 'job-visuals', runDir: tmpDir('brainrot-run-') })
  seedVoiceJson(ctx, 100)
  return ctx
}

/** Reads back the single clip the stage recorded as used. */
function usedFile(ctx: JobContext): string {
  const rows = ctx.db
    .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 1')
    .all('testchan') as { file: string }[]
  return rows[0].file
}

describe('visualsVolumeStage', () => {
  it('crops+loops a chosen clip to background.mp4 and records bg_usage', async () => {
    const bgDir = tmpDir('brainrot-bg-')
    placeClip(path.join(bgDir, 'clip1.mp4'), outputSource)
    placeClip(path.join(bgDir, 'clip2.mp4'), outputSource)
    const ctx = makeCtx({
      channel: channelFor(bgDir),
      jobId: 'job-visuals',
      runDir: tmpDir('brainrot-run-'),
    })
    seedVoiceJson(ctx, 2000)

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
    const bgDir = tmpDir('brainrot-bg-')
    const clip1 = path.join(bgDir, 'clip1.mp4')
    const clip2 = path.join(bgDir, 'clip2.mp4')
    placeClip(clip1)
    placeClip(clip2)
    const ctx = selectionCtx(channelFor(bgDir))
    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run('testchan', path.resolve(clip1), new Date().toISOString())

    await visualsVolumeStage.run(ctx)

    expect(usedFile(ctx)).toBe(path.resolve(clip2)) // clip1 excluded as recently used
  }, 60000)

  it('throws when bgDir has no mp4 clips', async () => {
    const ctx = selectionCtx(channelFor(tmpDir('brainrot-bg-empty-')))
    await expect(visualsVolumeStage.run(ctx)).rejects.toThrow(/no .mp4 background clips/)
  })

  it('discovers clips nested in subfolders', async () => {
    const bgDir = tmpDir('brainrot-bg-')
    const nestedClip = path.join(bgDir, 'minecraft-parkour', 'clip1.mp4')
    placeClip(nestedClip)
    const ctx = selectionCtx(channelFor(bgDir))

    await visualsVolumeStage.run(ctx)

    expect(usedFile(ctx)).toBe(path.resolve(nestedClip))
  }, 60000)

  it('ignores non-mp4 files in subfolders', async () => {
    const bgDir = tmpDir('brainrot-bg-')
    const sub = path.join(bgDir, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'notes.txt'), 'not a clip')
    const clip = path.join(sub, 'clip1.mp4')
    placeClip(clip)
    const ctx = selectionCtx(channelFor(bgDir))

    await visualsVolumeStage.run(ctx)

    expect(usedFile(ctx)).toBe(path.resolve(clip))
  }, 60000)

  it('pools clips from multiple configured roots', async () => {
    const rootA = tmpDir('brainrot-bg-a-')
    const rootB = tmpDir('brainrot-bg-b-')
    const clipA = path.join(rootA, 'clipA.mp4')
    const clipB = path.join(rootB, 'clipB.mp4')
    placeClip(clipA)
    placeClip(clipB)
    const ctx = selectionCtx(channelFor([rootA, rootB]))

    await visualsVolumeStage.run(ctx)

    expect([path.resolve(clipA), path.resolve(clipB)]).toContain(usedFile(ctx))
  }, 60000)

  it('treats same-basename clips in different roots as distinct pool entries', async () => {
    const rootA = tmpDir('brainrot-bg-a-')
    const rootB = tmpDir('brainrot-bg-b-')
    const clipA = path.join(rootA, 'clip.mp4') // same basename, different roots
    const clipB = path.join(rootB, 'clip.mp4')
    placeClip(clipA)
    placeClip(clipB)
    const ctx = selectionCtx(channelFor([rootA, rootB]))
    ctx.db
      .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
      .run('testchan', path.resolve(clipA), new Date().toISOString())

    await visualsVolumeStage.run(ctx)

    // clipA was recently used, so despite sharing a basename with clipB the
    // resolved-path key correctly excludes only clipA, not both.
    expect(usedFile(ctx)).toBe(path.resolve(clipB))
  }, 60000)

  it('tolerates a missing root as long as another configured root has clips', async () => {
    const goodRoot = tmpDir('brainrot-bg-good-')
    const missingRoot = path.join(tmpdir(), 'brainrot-bg-does-not-exist')
    const clip = path.join(goodRoot, 'clip1.mp4')
    placeClip(clip)
    const ctx = selectionCtx(channelFor([missingRoot, goodRoot]))

    await visualsVolumeStage.run(ctx)

    expect(usedFile(ctx)).toBe(path.resolve(clip))
  }, 60000)
})
