import { afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe } from '../media/ffmpeg.js'
import { assembleStage } from './assemble.js'
import { testChannel } from '../testing/channel.js'
import { makeCtx, seedVoiceJson } from '../testing/job.js'
import { tmpDir } from '../testing/tmp.js'
import type { JobContext } from '../jobs/types.js'

/** bgmDir is the only channel field these tests vary; empty dir -> no bgm. */
function assembleCtx(bgmDir = tmpDir('brainrot-bgm-')): JobContext {
  return makeCtx({
    channel: testChannel({
      name: 'testchan',
      bgDir: [tmpDir('brainrot-bg-')],
      bgmDir,
    }),
    topic: 'test topic',
    jobId: 'job-assemble',
    runDir: tmpDir('brainrot-run-'),
  })
}

async function codecs(file: string): Promise<{ video?: string; audio?: string }> {
  const { stdout } = await execa('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    file,
  ])
  const streams = JSON.parse(stdout).streams as { codec_type: string; codec_name: string }[]
  return {
    video: streams.find((s) => s.codec_type === 'video')?.codec_name,
    audio: streams.find((s) => s.codec_type === 'audio')?.codec_name,
  }
}

describe('assembleStage', () => {
  it('renders a 1080x1920@30 H.264+AAC final.mp4 (~1s)', async () => {
    const ctx = assembleCtx()

    // Real tiny fixtures.
    await execa('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=2:size=1080x1920:rate=30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ctx.artifactPath('visuals', 'background.mp4'),
      '-y',
    ])
    await execa('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      ctx.artifactPath('voice', 'narration.wav'),
      '-y',
    ])
    seedVoiceJson(ctx, 1000)
    writeFileSync(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify({
        words: [
          { word: 'hello', startMs: 0, endMs: 300 },
          { word: 'there', startMs: 300, endMs: 650 },
          { word: 'world', startMs: 650, endMs: 1000 },
        ],
      }),
    )

    // Snapshot pre-existing Remotion bundle dirs so the cleanup assertion below
    // only inspects the bundle created by THIS process (stale dirs from earlier
    // runs may linger in the OS tmpdir until reaped).
    const bundleDirsBefore = new Set(
      readdirSync(tmpdir()).filter((d) => d.startsWith('remotion-webpack-bundle-')),
    )

    await assembleStage.run(ctx)

    const out = ctx.artifactPath('assemble', 'final.mp4')
    expect(existsSync(out)).toBe(true)
    const p = await probe(out)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.fps).toBeGreaterThanOrEqual(29)
    expect(p.fps).toBeLessThanOrEqual(31)
    expect(p.hasAudio).toBe(true)
    expect(p.durationMs).toBeGreaterThanOrEqual(900)
    expect(p.durationMs).toBeLessThanOrEqual(1300)
    const c = await codecs(out)
    expect(c.video).toBe('h264')
    expect(c.audio).toBe('aac')

    // Per-job public assets are cleaned up after render: this process's bundle
    // dir (remotion-webpack-bundle-* in the OS tmpdir, new since the snapshot)
    // must no longer contain public/<jobId>/.
    const newBundleDirs = readdirSync(tmpdir()).filter(
      (d) => d.startsWith('remotion-webpack-bundle-') && !bundleDirsBefore.has(d),
    )
    expect(newBundleDirs.length).toBeGreaterThanOrEqual(1)
    for (const d of newBundleDirs) {
      expect(existsSync(path.join(tmpdir(), d, 'public', ctx.jobId))).toBe(false)
    }
  }, 180000)
})

// ── Bundle robustness (mocked @remotion/bundler + @remotion/renderer) ────────
// The bundle memo is module-level state, so each test dynamically imports a
// FRESH assemble.ts with its remotion deps mocked: vi.doMock (not hoisted) +
// vi.resetModules(). The static `assembleStage` import at the top of this file
// already bound the REAL modules, so the render test above is unaffected.

function seedRenderInputs(ctx: JobContext): void {
  // bundle/render are mocked below: file CONTENTS are never decoded, so junk
  // bytes stand in for real media. Only the stage's fs reads/copies must work.
  seedVoiceJson(ctx, 1000)
  writeFileSync(
    ctx.artifactPath('captions', 'words.json'),
    JSON.stringify({ words: [{ word: 'hello', startMs: 0, endMs: 400 }] }),
  )
  writeFileSync(ctx.artifactPath('visuals', 'background.mp4'), 'junk-video-bytes')
  writeFileSync(ctx.artifactPath('voice', 'narration.wav'), 'junk-wav-bytes')
}

function mockRenderer(): void {
  vi.doMock('@remotion/renderer', () => ({
    selectComposition: vi.fn().mockResolvedValue({
      id: 'ShortVideo',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 30,
    }),
    renderMedia: vi.fn().mockResolvedValue(undefined),
  }))
}

describe('assembleStage bundle robustness', () => {
  afterEach(() => {
    vi.doUnmock('@remotion/bundler')
    vi.doUnmock('@remotion/renderer')
    vi.resetModules()
  })

  it('retries bundle() after a rejection instead of memoizing the failure', async () => {
    const serveUrl = tmpDir('brainrot-serveurl-')
    const bundleMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('esbuild exploded'))
      .mockResolvedValue(serveUrl)
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = assembleCtx()
    seedRenderInputs(ctx)

    await expect(freshStage.run(ctx)).rejects.toThrow('esbuild exploded')
    // A poisoned memo replays the same rejection here without ever calling
    // bundle() again; the fix must clear the memo so this run re-bundles.
    await expect(freshStage.run(ctx)).resolves.toBeUndefined()
    expect(bundleMock).toHaveBeenCalledTimes(2)
  })

  it('passes a cwd-independent entry point to bundle()', async () => {
    const bundleMock = vi.fn().mockResolvedValue(tmpDir('brainrot-serveurl-'))
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = assembleCtx()
    seedRenderInputs(ctx)

    // Simulate the CLI being launched from anywhere but the repo root.
    const repoCwd = process.cwd()
    process.chdir(tmpDir('brainrot-elsewhere-'))
    try {
      await freshStage.run(ctx)
    } finally {
      process.chdir(repoCwd)
    }

    // This test file sits next to assemble.ts, so the same relative hop yields
    // the exact path the module must resolve regardless of process.cwd().
    const expectedEntry = fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))
    expect(existsSync(expectedEntry)).toBe(true) // guards the ../.. depth itself
    expect(bundleMock).toHaveBeenCalledWith({ entryPoint: expectedEntry })
  })
})
