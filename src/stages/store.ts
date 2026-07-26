import { readFileSync, writeFileSync } from 'node:fs'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { ObjectStore } from '../storage/types.js'

export interface StoreArtifact {
  objectKey: string
  bytes: number
  etag: string
}

export function objectKeyFor(channel: string, jobId: string): string {
  return `videos/${channel}/${jobId}.mp4`
}

/**
 * Uploads the finished video to object storage (design spec §4). Last stage in
 * the pipeline, so `runJob`'s skip-if-done rule gives it resume semantics for
 * free: a transient R2 outage fails the job, and `brainrot resume` re-runs ONLY
 * this stage rather than re-rendering the video.
 *
 * A factory taking an optional store, following qcStage()'s shape. The default
 * store is constructed inside run(), NOT here — building it in the factory
 * would make pipelineStages() throw for every caller without S3 credentials,
 * breaking resume on old jobs, the dashboard parity test, and every unit test
 * that only wants the stage list. The import is dynamic for the same reason it
 * is deferred in publish-next: pipelineStages() reaches this module from every
 * CLI command, and the AWS SDK costs ~35ms and ~10MB of startup that `jobs`,
 * `costs`, and `topics` have no use for.
 */
export function storeStage(store?: ObjectStore): StageDef {
  return {
    name: 'store',
    async run(ctx: JobContext): Promise<void> {
      const active = store ?? (await import('../storage/s3.js')).storeFromEnv()
      const finalPath = ctx.artifactPath('assemble', 'final.mp4')

      let bytes: Buffer
      try {
        bytes = readFileSync(finalPath)
      } catch (err) {
        // assemble did not produce what it claimed. Uploading nothing is not a
        // recoverable interpretation of that — but the underlying error still
        // matters: an EACCES/EIO reading a bind-mounted runs/ inside Docker is
        // a different first-hour failure than a genuinely missing file, and
        // should not send the operator hunting for a render bug.
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`store: no rendered video at ${finalPath}: ${message}`)
      }

      const objectKey = objectKeyFor(ctx.channel.name, ctx.jobId)
      const put = await active.put(objectKey, bytes, 'video/mp4')

      // Read-back verification. One extra round trip converts a silently
      // truncated upload from an opaque Meta container ERROR into a local
      // stage failure that names the mismatch.
      const head = await active.head(objectKey)
      if (head === null) {
        throw new Error(`store: object ${objectKey} missing immediately after upload`)
      }
      if (head.bytes !== bytes.length) {
        throw new Error(
          `store: byte count mismatch for ${objectKey} — uploaded ${bytes.length}, store reports ${head.bytes}`,
        )
      }

      const artifact: StoreArtifact = { objectKey, bytes: put.bytes, etag: put.etag }
      writeFileSync(ctx.artifactPath('store', 'store.json'), JSON.stringify(artifact, null, 2))
      ctx.log.info({ objectKey, bytes: put.bytes }, 'store: uploaded final.mp4')
    },
  }
}
