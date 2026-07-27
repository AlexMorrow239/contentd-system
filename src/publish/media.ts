import { existsSync, readFileSync } from 'node:fs'
import { classify, errorMessage } from '../errors.js'
import type { ObjectStore } from '../storage/types.js'
import { PublishError, type PublishMedia } from './types.js'

/**
 * Builds the per-attempt media handle the publish tick hands an adapter.
 *
 * `bytes()` prefers the local file: runs/ is a disposable cache, not a deleted
 * one, so a recent job avoids paying a download. `url()` requires an object
 * key — there is no way to give Meta a local path.
 *
 * Unavailability that is genuinely about the video (no local file and no
 * stored object; a legacy row with no object key at all) is 'rejected': no
 * amount of retrying will make it appear. Unavailability that is about the
 * environment instead — no object store configured, or an unexpected
 * (non-StorageError, or non-'not-found') failure reading the store — is
 * 'transient', since fixing the environment recovers the video and
 * 'rejected' counts toward the per-platform retirement cap
 * (channelVideoCandidates, src/publish/publishes.ts) with no way to undo it.
 */
export function publishMedia(opts: {
  objectKey: string | null
  localPath: string | null
  store: ObjectStore | null
}): PublishMedia {
  return {
    localPath: opts.localPath,

    async bytes(): Promise<Buffer<ArrayBuffer>> {
      if (opts.localPath !== null && existsSync(opts.localPath)) {
        return readFileSync(opts.localPath)
      }
      if (opts.objectKey === null) {
        throw new PublishError(
          `publishMedia: no video available — local path ${opts.localPath ?? '(none)'} is missing and there is no stored object`,
          'rejected',
        )
      }
      if (opts.store === null) {
        // An object key exists — the video isn't actually missing — but there
        // is no store configured to fetch it. A misconfiguration (e.g. a
        // deploy that dropped or broke BRAINROT_S3_* keys), not a defect in
        // the video itself, so it must not count toward rejectedCount.
        throw new PublishError(
          `publishMedia: object ${opts.objectKey} is recorded but no object store is configured to fetch it`,
          'transient',
        )
      }
      try {
        return await opts.store.get(opts.objectKey)
      } catch (err) {
        const info = classify(err)
        const message = info.message
        // Only a genuinely absent object is unretryable; an outage or a bad
        // credential — including an unclassified throw, which is always
        // unexpected rather than a confirmed absence — is the next tick's
        // problem, not this video's fault.
        const kind = info.kind === 'not-found' ? 'rejected' : 'transient'
        throw new PublishError(
          `publishMedia: object ${opts.objectKey} could not be read: ${message}`,
          kind,
        )
      }
    },

    async url(ttlSeconds: number): Promise<string> {
      if (opts.objectKey === null) {
        throw new PublishError(
          'publishMedia: this video has no stored object — run `brainrot library backfill-store` or re-produce it',
          'rejected',
        )
      }
      if (opts.store === null) {
        // Same misconfiguration as the bytes() store-is-null branch above —
        // the environment's fault, not the video's, so it must stay
        // retryable rather than counting toward rejectedCount.
        throw new PublishError('publishMedia: no object store configured', 'transient')
      }
      try {
        return await opts.store.presignGet(opts.objectKey, ttlSeconds)
      } catch (err) {
        const message = errorMessage(err)
        throw new PublishError(
          `publishMedia: could not presign ${opts.objectKey}: ${message}`,
          'transient',
        )
      }
    },
  }
}
