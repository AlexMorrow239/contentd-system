import { existsSync, readFileSync } from 'node:fs'
import type { ObjectStore } from '../storage/types.js'
import { PublishError, type PublishMedia } from './types.js'

/**
 * Builds the per-attempt media handle the publish tick hands an adapter.
 *
 * `bytes()` prefers the local file: runs/ is a disposable cache, not a deleted
 * one, so a recent job avoids paying a download. `url()` requires an object
 * key — there is no way to give Meta a local path.
 *
 * Every unavailability here is 'rejected', not 'transient': no amount of
 * retrying will make a video that exists in neither place appear.
 */
export function publishMedia(opts: {
  objectKey: string | null
  localPath: string | null
  store: ObjectStore | null
}): PublishMedia {
  return {
    objectKey: opts.objectKey,
    localPath: opts.localPath,

    async bytes(): Promise<Buffer> {
      if (opts.localPath !== null && existsSync(opts.localPath)) {
        return readFileSync(opts.localPath)
      }
      if (opts.objectKey !== null && opts.store !== null) {
        try {
          return await opts.store.get(opts.objectKey)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new PublishError(
            `publishMedia: object ${opts.objectKey} could not be read: ${message}`,
            'rejected',
          )
        }
      }
      throw new PublishError(
        `publishMedia: no video available — local path ${opts.localPath ?? '(none)'} is missing and there is no stored object`,
        'rejected',
      )
    },

    async url(ttlSeconds: number): Promise<string> {
      if (opts.objectKey === null) {
        throw new PublishError(
          'publishMedia: this video has no stored object — run `brainrot library backfill-store` or re-produce it',
          'rejected',
        )
      }
      if (opts.store === null) {
        throw new PublishError('publishMedia: no object store configured', 'rejected')
      }
      try {
        return await opts.store.presignGet(opts.objectKey, ttlSeconds)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new PublishError(
          `publishMedia: could not presign ${opts.objectKey}: ${message}`,
          'transient',
        )
      }
    },
  }
}
