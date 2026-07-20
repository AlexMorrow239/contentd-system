import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { probe } from '../media/ffmpeg.js'
import { assembleStage } from './assemble.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

function makeChannel(bgmDir: string): ChannelConfig {
  return {
    name: 'testchan',
    niche: ['space'],
    tierMix: { volume: 2, premium: 1 },
    voice: { volume: 'af_heart' },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir: tmp('brainrot-bg-'),
    bgmDir,
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
  }
}

function makeCtx(runDir: string, channel: ChannelConfig): JobContext {
  return {
    jobId: 'job-assemble',
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

async function codecs(file: string): Promise<{ video?: string; audio?: string }> {
  const { stdout } = await execa('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file])
  const streams = (JSON.parse(stdout).streams as { codec_type: string; codec_name: string }[])
  return {
    video: streams.find((s) => s.codec_type === 'video')?.codec_name,
    audio: streams.find((s) => s.codec_type === 'audio')?.codec_name,
  }
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('assembleStage', () => {
  it('renders a 1080x1920@30 H.264+AAC final.mp4 (~1s)', async () => {
    const channel = makeChannel(tmp('brainrot-bgm-')) // empty bgm dir -> no bgm
    const ctx = makeCtx(tmp('brainrot-run-'), channel)

    // Real tiny fixtures.
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=1080x1920:rate=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ctx.artifactPath('visuals', 'background.mp4'), '-y',
    ])
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      ctx.artifactPath('voice', 'narration.wav'), '-y',
    ])
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 }),
    )
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
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 }),
  )
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
    const serveUrl = tmp('brainrot-serveurl-')
    const bundleMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('esbuild exploded'))
      .mockResolvedValue(serveUrl)
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = makeCtx(tmp('brainrot-run-'), makeChannel(tmp('brainrot-bgm-')))
    seedRenderInputs(ctx)

    await expect(freshStage.run(ctx)).rejects.toThrow('esbuild exploded')
    // A poisoned memo replays the same rejection here without ever calling
    // bundle() again; the fix must clear the memo so this run re-bundles.
    await expect(freshStage.run(ctx)).resolves.toBeUndefined()
    expect(bundleMock).toHaveBeenCalledTimes(2)
  })

  it('passes a cwd-independent entry point to bundle()', async () => {
    const bundleMock = vi.fn().mockResolvedValue(tmp('brainrot-serveurl-'))
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = makeCtx(tmp('brainrot-run-'), makeChannel(tmp('brainrot-bgm-')))
    seedRenderInputs(ctx)

    // Simulate the CLI being launched from anywhere but the repo root.
    const repoCwd = process.cwd()
    process.chdir(tmp('brainrot-elsewhere-'))
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
