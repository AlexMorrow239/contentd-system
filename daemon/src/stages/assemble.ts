import { checkpoint } from './ownership.js'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer'
import type { JobContext, StageDef } from '../jobs/types.js'
import { CAPTION_STYLE, type ShortVideoProps } from '../remotion-types.js'
import type { CaptionsArtifact } from './captions.js'
import type { VoiceMeta } from './voice.js'

// Resolved relative to THIS module, not process.cwd(): the CLI may be invoked
// from any directory (pnpm -C, cron, a wrapper script), and a cwd-relative
// path.resolve('integrations/remotion/index.ts') would point bundling at a
// nonexistent tree.
const REMOTION_ENTRY = fileURLToPath(
  new URL('../../../integrations/remotion/index.ts', import.meta.url),
)

/**
 * Where this stage puts the finished video, given a run directory. Exported so
 * the runner's final gate does not have to know assemble's own file layout —
 * every stage owns the name of what it writes.
 */
export function finalVideoPath(runDir: string): string {
  return path.join(runDir, 'assemble', 'final.mp4')
}

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

export const assembleStage: StageDef = {
  name: 'assemble',
  async run(ctx: JobContext): Promise<void> {
    checkpoint(ctx)
    const voice = JSON.parse(
      readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as VoiceMeta
    const captions = JSON.parse(
      readFileSync(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    ) as CaptionsArtifact

    checkpoint(ctx)
    const serveUrl = await getBundle()
    checkpoint(ctx)

    // Remotion SSR dynamic-asset mechanism (verified against remotion.dev):
    // absolute paths are NOT allowed in <Video>/<Audio>. Copy the
    // per-job files into the bundle's public/ folder, then reference them with
    // staticFile(). Isolate retries as well as jobs inside the reused bundle.
    const assetNamespace = ctx.attemptId ? `${ctx.jobId}/${ctx.attemptId}` : ctx.jobId
    const publicJobDir = path.join(serveUrl, 'public', assetNamespace)
    mkdirSync(publicJobDir, { recursive: true })
    const outPath = ctx.artifactPath('assemble', 'final.mp4')
    const cancellation = ctx.signal ? makeCancelSignal() : undefined
    if (cancellation) ctx.signal?.addEventListener('abort', cancellation.cancel, { once: true })
    try {
      checkpoint(ctx)
      copyFileSync(
        ctx.artifactPath('voice', 'narration.wav'),
        path.join(publicJobDir, 'narration.wav'),
      )
      const base = {
        audioSrc: `${assetNamespace}/narration.wav`,
        words: captions.words,
        style: CAPTION_STYLE,
        durationMs: voice.durationMs,
      }

      copyFileSync(
        ctx.artifactPath('visuals', 'background.mp4'),
        path.join(publicJobDir, 'background.mp4'),
      )
      const props: ShortVideoProps = { ...base, backgroundSrc: `${assetNamespace}/background.mp4` }

      checkpoint(ctx)
      const composition = await selectComposition({
        serveUrl,
        id: 'ShortVideo',
        inputProps: props,
      })
      checkpoint(ctx)
      await renderMedia({
        cancelSignal: cancellation?.cancelSignal,
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outPath,
        inputProps: props,
      })
      checkpoint(ctx)
    } finally {
      if (cancellation) ctx.signal?.removeEventListener('abort', cancellation.cancel)
      // The bundle is memoized for the whole process, so per-job assets would
      // otherwise accumulate under public/ for the process lifetime. Distinct
      // jobId subdirs keep concurrent jobs isolated; removing only ours is safe.
      rmSync(publicJobDir, { recursive: true, force: true })
    }
    ctx.log.info({ outPath }, 'assemble: rendered final.mp4')
  },
}
