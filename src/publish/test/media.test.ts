import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeStore } from '../../storage/fake.js'
import { StorageError, type ObjectStore } from '../../storage/types.js'
import { publishMedia } from '../media.js'
import { tmpDir } from '../../testing/tmp.js'

const BODY = Buffer.from('local bytes', 'utf8')
const REMOTE = Buffer.from('remote bytes', 'utf8')

// Every method rejects with `err`, regardless of arguments — used to prove
// publishMedia's construction does no I/O, and to drive store.get()/
// presignGet() through their catch branches without a real backend.
function throwingStore(err: unknown): ObjectStore {
  return {
    async put() {
      throw err
    },
    async get() {
      throw err
    },
    async head() {
      throw err
    },
    async presignGet() {
      throw err
    },
    async delete() {
      throw err
    },
  }
}

describe('publishMedia', () => {
  let dir: string
  let storeRoot: string
  let store: ObjectStore
  let localPath: string

  beforeEach(async () => {
    dir = tmpDir('brainrot-media-')
    storeRoot = tmpDir('brainrot-media-store-')
    store = fakeStore(storeRoot)
    localPath = path.join(dir, 'final.mp4')
    await store.put('videos/example/job-1.mp4', REMOTE, 'video/mp4')
  })

  it('prefers the local file when it exists', async () => {
    writeFileSync(localPath, BODY)
    const media = publishMedia({ objectKey: 'videos/example/job-1.mp4', localPath, store })
    expect((await media.bytes()).equals(BODY)).toBe(true)
  })

  it('falls back to the store when the local file is gone', async () => {
    const media = publishMedia({ objectKey: 'videos/example/job-1.mp4', localPath, store })
    expect((await media.bytes()).equals(REMOTE)).toBe(true)
  })

  it('throws a rejected PublishError when neither source is available', async () => {
    const media = publishMedia({ objectKey: null, localPath, store })
    await expect(media.bytes()).rejects.toMatchObject({ name: 'PublishError', kind: 'rejected' })
  })

  it('presigns a URL from the object key with the ttl threaded through', async () => {
    const media = publishMedia({ objectKey: 'videos/example/job-1.mp4', localPath: null, store })
    expect(await media.url(7200)).toMatch(/[?&]ttl=7200(&|$)/)
  })

  // A library row predating library_objects: still publishable to YouTube via
  // its local file, but Instagram has nothing to hand Meta.
  it('throws a rejected PublishError from url() when there is no object key', async () => {
    writeFileSync(localPath, BODY)
    const media = publishMedia({ objectKey: null, localPath, store })
    await expect(media.url(7200)).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'rejected',
      message: expect.stringMatching(/backfill-store/),
    })
  })

  it('throws a rejected PublishError when store.get() reports the object as not-found', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: throwingStore(
        new StorageError('fakeStore: no object at videos/example/job-1.mp4', 'not-found'),
      ),
    })
    await expect(media.bytes()).rejects.toMatchObject({ name: 'PublishError', kind: 'rejected' })
  })

  // Regression test for the store.get() catch flattening every StorageError
  // kind to 'rejected': a transient outage or a bad credential must stay
  // 'transient' so the failed publish attempt doesn't count toward
  // the retirement cap (src/publish/publishes.ts channelVideoCandidates,
  // MAX_PUBLISH_ATTEMPTS) and
  // permanently retire an otherwise-fine video.
  it('throws a transient PublishError when store.get() reports a transient storage error', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: throwingStore(new StorageError('r2: 503 service unavailable', 'transient')),
    })
    await expect(media.bytes()).rejects.toMatchObject({ name: 'PublishError', kind: 'transient' })
  })

  it('throws a transient PublishError when presignGet() throws', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: throwingStore(new Error('network blip')),
    })
    await expect(media.url(7200)).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'transient',
    })
  })

  // Regression test: resolveStore() (src/loop/publish-next.ts) memoizes null
  // when s3ConfigFromEnv()/s3Store() fails — e.g. a deploy dropping or
  // breaking BRAINROT_S3_* keys. That is a misconfiguration of the
  // environment, not a defect in the video, so it must stay 'transient' and
  // not count toward rejectedCount's 3-attempt retirement cap, which has no
  // undo.
  it('throws a transient PublishError from bytes() when an object key is recorded but no store is configured', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: null,
    })
    await expect(media.bytes()).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'transient',
    })
  })

  it('throws a transient PublishError from url() when there is no store', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: null,
    })
    await expect(media.url(7200)).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'transient',
    })
  })

  // Regression test for the store.get() catch's inverted polarity: any
  // non-StorageError throw (a bug, a driver-level exception) was previously
  // treated as a confirmed absence ('rejected') rather than an unexpected
  // failure ('transient').
  it('throws a transient PublishError when store.get() throws a plain non-StorageError', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: throwingStore(new Error('driver exploded')),
    })
    await expect(media.bytes()).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'transient',
    })
  })

  it('performs no I/O when merely constructed (laziness)', () => {
    const throwing = throwingStore(new Error('should never be called during construction'))
    expect(() =>
      publishMedia({
        objectKey: 'videos/example/job-1.mp4',
        localPath: '/does/not/exist/final.mp4',
        store: throwing,
      }),
    ).not.toThrow()
  })
})
