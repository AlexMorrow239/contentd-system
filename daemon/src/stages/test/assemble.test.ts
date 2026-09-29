import { afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { makeCancelSignal } from '@remotion/renderer'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe } from '../../media/ffmpeg.js'
import { assembleStage } from '../assemble.js'
import { testChannel } from '../../../testing/channel.js'
import { makeCtx, seedVoiceJson } from '../../../testing/job.js'
import { tmpDir } from '../../../testing/tmp.js'
import type { JobContext } from '../../jobs/types.js'

/**
 * The jobId is unique per ctx rather than a fixed 'job-assemble'. assembleStage
 * stages per-job assets into `<serveUrl>/public/<jobId>`, and the cleanup
 * assertion below can only look for that directory by scanning the OS tmpdir —
 * so a constant id makes the test observe OTHER processes' renders. Two
 * concurrent `pnpm test` runs (or a watch run beside a manual one) would see
 * each other's in-flight public/job-assemble and fail.
 */
let ctxSeq = 0
function assembleCtx(): JobContext {
  return makeCtx({
    channel: testChannel({
      name: 'testchan',
      bgDir: [tmpDir('brainrot-bg-')],
    }),
    topic: 'test topic',
    jobId: `job-assemble-${process.pid}-${ctxSeq++}`,
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
      // 1.2s of background against 1s of narration: enough headroom for the
      // trim without paying to encode a second of frames the render discards.
      'testsrc2=duration=1.2:size=1080x1920:rate=30',
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

    // Per-job public assets are cleaned up after the render: no Remotion bundle
    // dir anywhere in the OS tmpdir may still hold public/<jobId>/.
    //
    // Scoped by the unique jobId rather than by a before/after snapshot of the
    // tmpdir. The snapshot approach classified any bundle dir that appeared
    // during this test as "ours", which is only true when nothing else is
    // rendering — under two concurrent runs it read the other run's directory
    // and failed on assets that were never this test's to clean up.
    const bundleDirs = readdirSync(tmpdir()).filter((d) => d.startsWith('remotion-webpack-bundle-'))
    expect(bundleDirs.length).toBeGreaterThanOrEqual(1)
    for (const d of bundleDirs) {
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
  it('cancels an in-flight render and cleans only its attempt assets', async () => {
    const serveUrl = tmpDir('brainrot-serveurl-')
    vi.doMock('@remotion/bundler', () => ({ bundle: vi.fn().mockResolvedValue(serveUrl) }))
    const controller = new AbortController()
    const lost = new Error('lease lost')
    const render = vi.fn(
      async (opts: {
        inputProps: { audioSrc: string }
        cancelSignal: (callback: () => void) => void
      }) => {
        expect(opts.inputProps.audioSrc).toContain('/attempt-a/narration.wav')
        expect(existsSync(path.join(serveUrl, 'public', opts.inputProps.audioSrc))).toBe(true)
        await new Promise<void>((_resolve, reject) => {
          opts.cancelSignal(() => reject(lost))
          controller.abort(lost)
        })
      },
    )
    vi.doMock('@remotion/renderer', () => ({
      makeCancelSignal,
      selectComposition: vi.fn().mockResolvedValue({ id: 'ShortVideo' }),
      renderMedia: render,
    }))
    vi.resetModules()
    const { assembleStage: freshStage } = await import('../assemble.js')
    const ctx = assembleCtx()
    ctx.signal = controller.signal
    ctx.attemptId = 'attempt-a'
    seedRenderInputs(ctx)
    await expect(freshStage.run(ctx)).rejects.toBe(lost)
    expect(render).toHaveBeenCalledTimes(1)
    expect(existsSync(path.join(serveUrl, 'public', ctx.jobId, ctx.attemptId))).toBe(false)
  })

  it('does not render when ownership is lost while selecting composition', async () => {
    const serveUrl = tmpDir('brainrot-serveurl-')
    vi.doMock('@remotion/bundler', () => ({ bundle: vi.fn().mockResolvedValue(serveUrl) }))
    let owned = true
    const lost = new Error('lease lost')
    const render = vi.fn()
    vi.doMock('@remotion/renderer', () => ({
      selectComposition: vi.fn(async () => {
        owned = false
        return { id: 'ShortVideo' }
      }),
      renderMedia: render,
    }))
    vi.resetModules()
    const { assembleStage: freshStage } = await import('../assemble.js')
    const ctx = assembleCtx()
    ctx.assertOwned = () => {
      if (!owned) throw lost
    }
    seedRenderInputs(ctx)
    await expect(freshStage.run(ctx)).rejects.toBe(lost)
    expect(render).not.toHaveBeenCalled()
    expect(existsSync(path.join(serveUrl, 'public', ctx.jobId))).toBe(false)
  })

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
    const { assembleStage: freshStage } = await import('../assemble.js')

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
    const { assembleStage: freshStage } = await import('../assemble.js')

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

    // assemble.ts computes its entry point relative to its own file, one
    // directory up from this test file — the same relative hop from here
    // yields the exact path the module must resolve regardless of process.cwd().
    const expectedEntry = fileURLToPath(
      new URL('../../../../integrations/remotion/index.ts', import.meta.url),
    )
    expect(existsSync(expectedEntry)).toBe(true) // guards the ../../.. depth itself
    expect(bundleMock).toHaveBeenCalledWith({ entryPoint: expectedEntry })
  })
})
