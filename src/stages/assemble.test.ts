import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
