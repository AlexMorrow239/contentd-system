import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { probe } from '../media/ffmpeg.js'
import { assembleStage, fitClipToWindow } from './assemble.js'
import { testChannel } from './_testkit.js'
import type { ScenesManifest } from './visuals-premium.js'
import type { ShortVideoProps } from '../remotion-types.js'
import { DEFAULT_SCOUT } from '../config/channel.js'
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
    premium: { imageModel: 'fal-ai/flux/dev', videoModel: 'fal-ai/kling-video/v3/standard/image-to-video', sceneConcurrency: 3 },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir: [tmp('brainrot-bg-')],
    bgmDir,
    budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    scout: { ...DEFAULT_SCOUT },
    publish: null,
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

// ── fitClipToWindow (pure duration-fitting rule) ─────────────────────────────

describe('fitClipToWindow', () => {
  it('trims at 1x when the window is shorter than the clip', () => {
    expect(fitClipToWindow(5000, 3000)).toEqual({ playbackRate: 1, durationMs: 3000 })
  })

  it('plays at 1x when the window exactly equals the clip', () => {
    expect(fitClipToWindow(5000, 5000)).toEqual({ playbackRate: 1, durationMs: 5000 })
  })

  it('slows playback proportionally when the window slightly exceeds the clip', () => {
    const fit = fitClipToWindow(5000, 5500)
    expect(fit.durationMs).toBe(5500)
    expect(fit.playbackRate).toBeCloseTo(5000 / 5500, 10)
  })

  it('clamps the slowdown at 0.75x (clip freezes on its last frame beyond that)', () => {
    expect(fitClipToWindow(5000, 10000)).toEqual({ playbackRate: 0.75, durationMs: 10000 })
  })
})

// ── Premium multi-clip assembly ──────────────────────────────────────────────
// Two layers: a fast test that mocks @remotion/{bundler,renderer} (same
// vi.doMock + vi.resetModules + dynamic-import pattern as the bundle-robustness
// block above — the static `assembleStage` import stays bound to the REAL
// modules) and asserts the exact props handed to renderMedia; and a real-render
// integration test that produces an actual final.mp4 from lavfi fixture clips.

function makePremiumCtx(runDir: string, channel: ChannelConfig): JobContext {
  return {
    jobId: 'job-assemble-premium',
    db: openDb(':memory:'),
    channel,
    tier: 'premium',
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

async function lavfiClip(outPath: string, durationSec: number): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${durationSec}:size=1080x1920:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    outPath, '-y',
  ])
}

describe('assembleStage premium (mocked renderer)', () => {
  afterEach(() => {
    vi.doUnmock('@remotion/bundler')
    vi.doUnmock('@remotion/renderer')
    vi.resetModules()
  })

  it('derives sceneClips props from scenes.json and passes them to renderMedia', async () => {
    const bundleDir = tmp('brainrot-fake-bundle-')
    const captured: { select?: ShortVideoProps; render?: ShortVideoProps } = {}
    vi.doMock('@remotion/bundler', () => ({
      bundle: async () => bundleDir,
    }))
    vi.doMock('@remotion/renderer', () => ({
      selectComposition: async (opts: { inputProps: ShortVideoProps }) => {
        captured.select = opts.inputProps
        return { id: 'ShortVideo', width: 1080, height: 1920, fps: 30, durationInFrames: 105 }
      },
      renderMedia: async (opts: { inputProps: ShortVideoProps; outputLocation: string }) => {
        captured.render = opts.inputProps
        writeFileSync(opts.outputLocation, 'stub-video')
      },
    }))
    vi.resetModules()
    const { assembleStage: mockedStage } = await import('./assemble.js')

    const channel = testChannel({ bgmDir: tmp('brainrot-bgm-') }) // empty bgm dir -> no bgm
    const ctx = makePremiumCtx(tmp('brainrot-run-'), channel)

    // Clips must be REAL video files: the premium branch ffprobes each one.
    await lavfiClip(ctx.artifactPath('visuals', 'scene-01.mp4'), 2)
    await lavfiClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1)
    // narration.wav is only copied (never decoded) on the mocked path.
    writeFileSync(ctx.artifactPath('voice', 'narration.wav'), 'junk-wav-bytes')
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs: 3500 }),
    )
    writeFileSync(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify({ words: [{ word: 'hello', startMs: 0, endMs: 400 }] }),
    )
    const manifest: ScenesManifest = {
      method: 'aligned',
      scenes: [
        // Scene 1: 1500ms window vs ~2000ms clip -> trim at 1x.
        // Scene 2: 2000ms window vs ~1000ms clip -> raw rate ~0.5 clamps to
        // exactly 0.75 regardless of ffprobe's container rounding (+-25ms).
        { index: 1, startMs: 0, endMs: 1500, keyframe: 'scene-01.png', clip: 'scene-01.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
        { index: 2, startMs: 1500, endMs: 3500, keyframe: 'scene-02.png', clip: 'scene-02.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
      ],
    }
    writeFileSync(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest))

    await mockedStage.run(ctx)

    expect(captured.render).toBeDefined()
    expect(captured.render).toEqual(captured.select) // same props to select + render
    expect(captured.render?.backgroundSrc).toBeUndefined()
    expect(captured.render?.audioSrc).toBe('job-assemble-premium/narration.wav')
    expect(captured.render?.bgmSrc).toBeUndefined()
    expect(captured.render?.durationMs).toBe(3500)
    expect(captured.render?.sceneClips).toEqual([
      { src: 'job-assemble-premium/scene-01.mp4', durationMs: 1500, playbackRate: 1 },
      { src: 'job-assemble-premium/scene-02.mp4', durationMs: 2000, playbackRate: 0.75 },
    ])
    // final.mp4 landed and the per-job public assets were cleaned up after.
    expect(existsSync(ctx.artifactPath('assemble', 'final.mp4'))).toBe(true)
    expect(existsSync(path.join(bundleDir, 'public', ctx.jobId))).toBe(false)
  }, 60000)
})

describe('assembleStage premium (real render)', () => {
  it('renders sequenced scene clips into a final.mp4 matching narration duration', async () => {
    const channel = testChannel({ bgmDir: tmp('brainrot-bgm-') }) // empty bgm dir -> no bgm
    const ctx = makePremiumCtx(tmp('brainrot-run-'), channel)

    await lavfiClip(ctx.artifactPath('visuals', 'scene-01.mp4'), 2)
    await lavfiClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1)
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4',
      ctx.artifactPath('voice', 'narration.wav'), '-y',
    ])
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs: 2400 }),
    )
    writeFileSync(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify({
        words: [
          { word: 'scene', startMs: 0, endMs: 500 },
          { word: 'one', startMs: 500, endMs: 1100 },
          { word: 'two', startMs: 1300, endMs: 2200 },
        ],
      }),
    )
    const manifest: ScenesManifest = {
      method: 'aligned',
      scenes: [
        // Scene 2's 1200ms window against a ~1000ms clip exercises the real
        // slow-down path (rate ~0.83) inside an actual Remotion render.
        { index: 1, startMs: 0, endMs: 1200, keyframe: 'scene-01.png', clip: 'scene-01.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
        { index: 2, startMs: 1200, endMs: 2400, keyframe: 'scene-02.png', clip: 'scene-02.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
      ],
    }
    writeFileSync(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest))

    await assembleStage.run(ctx)

    const out = ctx.artifactPath('assemble', 'final.mp4')
    expect(existsSync(out)).toBe(true)
    const p = await probe(out)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.fps).toBeGreaterThanOrEqual(29)
    expect(p.fps).toBeLessThanOrEqual(31)
    expect(p.hasAudio).toBe(true)
    // Composition length derives from voice.durationMs (2400ms), +-200ms slack.
    expect(p.durationMs).toBeGreaterThanOrEqual(2200)
    expect(p.durationMs).toBeLessThanOrEqual(2600)
    const c = await codecs(out)
    expect(c.video).toBe('h264')
    expect(c.audio).toBe('aac')
  }, 240000)
})
