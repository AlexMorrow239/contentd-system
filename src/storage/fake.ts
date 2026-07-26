import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { StorageError, type ObjectStore } from './types.js'

// Keys contain slashes (videos/<channel>/<jobId>.mp4). Percent-encoding the
// whole key into ONE filename keeps the fake's root flat, so no key can
// escape it via '..' and no directory tree has to be created or pruned.
function encodeKey(key: string): string {
  return encodeURIComponent(key)
}

/**
 * Filesystem-backed ObjectStore for the default (hermetic) test run. Never
 * opens a socket. Its contract is defined by src/storage/conformance.ts, which
 * runs unchanged against s3Store — that shared suite is the only thing keeping
 * this from drifting into a shape R2 does not have.
 */
export function fakeStore(rootDir: string): ObjectStore {
  const blobPath = (key: string): string => path.join(rootDir, encodeKey(key))
  // Content type lives in a sidecar rather than being inferred from the key:
  // head() must report what was actually written, or the conformance suite's
  // content-type assertion would pass vacuously here and fail against R2.
  const metaPath = (key: string): string => `${blobPath(key)}.meta.json`

  // Every method below is genuinely synchronous (plain node:fs calls), but
  // each stays `async` so that a thrown error becomes a rejected Promise
  // rather than a synchronous throw — matching the real S3 client's
  // behavior, which callers rely on (`await store.get(...)` inside a
  // try/catch, `.catch()` chaining, etc). require-await doesn't know that
  // distinction, hence the per-method disable.
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async put(key, body, contentType) {
      mkdirSync(rootDir, { recursive: true })
      writeFileSync(blobPath(key), body)
      writeFileSync(metaPath(key), JSON.stringify({ contentType }))
      return { etag: createHash('md5').update(body).digest('hex'), bytes: body.length }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async get(key) {
      try {
        return readFileSync(blobPath(key))
      } catch {
        throw new StorageError(`fakeStore: no object at ${key}`, 'not-found')
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async head(key) {
      if (!existsSync(blobPath(key))) return null
      const { contentType } = JSON.parse(readFileSync(metaPath(key), 'utf8')) as {
        contentType: string
      }
      return { bytes: statSync(blobPath(key)).size, contentType }
    },

    // Deliberately does NOT check existence: S3 presigning is local signing
    // that never contacts the bucket, so it succeeds for missing keys and the
    // GET is what 404s. Diverging here would make the fake reject URLs the
    // real store signs.
    // eslint-disable-next-line @typescript-eslint/require-await
    async presignGet(key, ttlSeconds) {
      return `fake-store://${encodeKey(key)}?ttl=${ttlSeconds}`
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async delete(key) {
      rmSync(blobPath(key), { force: true })
      rmSync(metaPath(key), { force: true })
    },
  }
}
