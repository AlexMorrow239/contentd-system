import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { WordTiming } from '../providers/whisperx.js'
import type { ShortVideoProps } from '../remotion-types.js'

// Resolved relative to THIS module, not process.cwd(): the CLI may be invoked
// from any directory (pnpm -C, cron, a wrapper script), and a cwd-relative
// path.resolve('remotion/index.ts') would point bundling at a nonexistent tree.
const REMOTION_ENTRY = fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))

let bundlePromise: Promise<string> | undefined
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    const inFlight = bundle({ entryPoint: REMOTION_ENTRY })
    // A rejected bundle() must not poison the memo for the process lifetime:
    // clear it so the next caller retries. Callers still observe the original
    // rejection through the returned promise — this .catch only manages the
    // memo (and marks the rejection handled on this side branch). The identity
    // guard keeps a newer in-flight bundle from being wiped by an older failure.
    inFlight.catch(() => {
      if (bundlePromise === inFlight) bundlePromise = undefined
    })
    bundlePromise = inFlight
  }
  return bundlePromise
}

/**
 * Fit a probed clip into its scene window (both integer ms).
 * - Window shorter than (or equal to) the clip: play at 1x and trim — the
 *   Series.Sequence simply ends at windowMs.
 * - Window longer than the clip: slow playback to cover it, but never below
 *   0.75x. A clip exhausted at 0.75x freezes on its last frame for the
 *   remainder of the window; QC's freeze check bounds how bad that can get.
 *   Windows needing < 0.75x violate script-stage pacing constraints and are
 *   caught by QC's duration/coverage checks, not silently stretched further.
 */
export function fitClipToWindow(
  clipMs: number,
  windowMs: number,
): { playbackRate: number; durationMs: number } {
  if (windowMs <= clipMs) return { playbackRate: 1, durationMs: windowMs }
  return { playbackRate: Math.max(0.75, clipMs / windowMs), durationMs: windowMs }
}

export const assembleStage: StageDef = {
  name: 'assemble',
  async run(ctx: JobContext): Promise<void> {
    const voice = JSON.parse(
      readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as { durationMs: number }
    const captions = JSON.parse(
      readFileSync(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    ) as { words: WordTiming[] }

    // Optional BGM: first *.mp3 in channel.bgmDir (deterministic: sorted).
    let bgmFile: string | undefined
    try {
      bgmFile = readdirSync(ctx.channel.bgmDir)
        .filter((f) => f.toLowerCase().endsWith('.mp3'))
        .sort()[0]
    } catch {
      bgmFile = undefined
    }

    const serveUrl = await getBundle()

    // Remotion SSR dynamic-asset mechanism (verified against remotion.dev):
    // absolute paths are NOT allowed in <OffthreadVideo>/<Audio>. Copy the
    // per-job files into the bundle's public/ folder, then reference them with
    // staticFile(). Namespace by jobId so a reused bundle never collides.
    const publicJobDir = path.join(serveUrl, 'public', ctx.jobId)
    mkdirSync(publicJobDir, { recursive: true })
    const outPath = ctx.artifactPath('assemble', 'final.mp4')
    try {
      copyFileSync(
        ctx.artifactPath('visuals', 'background.mp4'),
        path.join(publicJobDir, 'background.mp4'),
      )
      copyFileSync(
        ctx.artifactPath('voice', 'narration.wav'),
        path.join(publicJobDir, 'narration.wav'),
      )
      if (bgmFile) {
        copyFileSync(path.join(ctx.channel.bgmDir, bgmFile), path.join(publicJobDir, 'bgm.mp3'))
      }

      const props: ShortVideoProps = {
        audioSrc: `${ctx.jobId}/narration.wav`,
        backgroundSrc: `${ctx.jobId}/background.mp4`,
        bgmSrc: bgmFile ? `${ctx.jobId}/bgm.mp3` : undefined,
        words: captions.words,
        style: ctx.channel.captionStyle,
        durationMs: voice.durationMs,
      }

      const composition = await selectComposition({
        serveUrl,
        id: 'ShortVideo',
        inputProps: props,
      })
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outPath,
        inputProps: props,
      })
    } finally {
      // The bundle is memoized for the whole process, so per-job assets would
      // otherwise accumulate under public/ for the process lifetime. Distinct
      // jobId subdirs keep concurrent jobs isolated; removing only ours is safe.
      rmSync(publicJobDir, { recursive: true, force: true })
    }
    ctx.log.info({ outPath }, 'assemble: rendered final.mp4')
  },
}
