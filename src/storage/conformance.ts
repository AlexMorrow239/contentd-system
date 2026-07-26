import { describe, expect, it } from 'vitest'
import type { ObjectStore } from './types.js'

export interface StoreHarness {
  store: ObjectStore
  cleanup: () => Promise<void>
}

// Each test needs keys nobody else touches: the MinIO run shares one bucket
// across the whole file, so a fixed key would let tests clobber each other.
let counter = 0
function uniqueKey(): string {
  counter += 1
  return `conformance/${process.pid}-${counter}/video.mp4`
}

const BODY = Buffer.from('fake mp4 bytes, long enough to have a length', 'utf8')

/**
 * One suite, invoked by fake.test.ts and s3.storage.test.ts alike. Anything
 * asserted here is part of the ObjectStore contract; anything an
 * implementation does beyond it is its own business.
 */
export function describeObjectStore(name: string, makeStore: () => Promise<StoreHarness>): void {
  describe(`ObjectStore conformance: ${name}`, () => {
    async function withStore(fn: (store: ObjectStore) => Promise<void>): Promise<void> {
      const harness = await makeStore()
      try {
        await fn(harness.store)
      } finally {
        await harness.cleanup()
      }
    }

    it('round-trips a body through put and get', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        await store.put(key, BODY, 'video/mp4')
        const got = await store.get(key)
        expect(got.equals(BODY)).toBe(true)
      })
    })

    it('reports the written byte count from put', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        const res = await store.put(key, BODY, 'video/mp4')
        expect(res.bytes).toBe(BODY.length)
        expect(res.etag).toBeTruthy()
      })
    })

    it('head reports the byte count and content type', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        await store.put(key, BODY, 'video/mp4')
        const head = await store.head(key)
        expect(head).not.toBeNull()
        expect(head?.bytes).toBe(BODY.length)
        expect(head?.contentType).toBe('video/mp4')
      })
    })

    it('head returns null for a missing key', async () => {
      await withStore(async (store) => {
        expect(await store.head(uniqueKey())).toBeNull()
      })
    })

    it('get on a missing key throws StorageError with kind not-found', async () => {
      await withStore(async (store) => {
        await expect(store.get(uniqueKey())).rejects.toMatchObject({
          name: 'StorageError',
          kind: 'not-found',
        })
      })
    })

    it('presignGet returns a URL for an existing key', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        await store.put(key, BODY, 'video/mp4')
        const url = await store.presignGet(key, 3600)
        expect(typeof url).toBe('string')
        expect(url.length).toBeGreaterThan(0)
      })
    })

    // S3 presigning is a purely local signing operation — it never contacts
    // the bucket, so it succeeds for keys that do not exist and the eventual
    // GET is what 404s. The fake MUST match, or it would reject URLs the real
    // store happily signs and the two would disagree on a live code path.
    it('presignGet succeeds for a missing key', async () => {
      await withStore(async (store) => {
        const url = await store.presignGet(uniqueKey(), 3600)
        expect(typeof url).toBe('string')
        expect(url.length).toBeGreaterThan(0)
      })
    })

    it('put overwrites an existing key', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        const second = Buffer.from('a completely different body', 'utf8')
        await store.put(key, BODY, 'video/mp4')
        await store.put(key, second, 'video/mp4')
        expect((await store.get(key)).equals(second)).toBe(true)
      })
    })

    it('delete removes the object', async () => {
      await withStore(async (store) => {
        const key = uniqueKey()
        await store.put(key, BODY, 'video/mp4')
        await store.delete(key)
        expect(await store.head(key)).toBeNull()
      })
    })

    // library reject deletes best-effort and may run twice (a retried reject,
    // a re-run sweep). A second delete must be a no-op, not a throw.
    it('delete is idempotent for a missing key', async () => {
      await withStore(async (store) => {
        await expect(store.delete(uniqueKey())).resolves.toBeUndefined()
      })
    })

    // The production key scheme is videos/<channel>/<jobId>.mp4 — slashes are
    // structural, not incidental.
    it('handles keys containing slashes', async () => {
      await withStore(async (store) => {
        const key = `videos/example-channel/${process.pid}-abc123.mp4`
        await store.put(key, BODY, 'video/mp4')
        expect((await store.get(key)).equals(BODY)).toBe(true)
        await store.delete(key)
      })
    })
  })
}
