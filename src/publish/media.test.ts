import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeStore } from '../storage/fake.js'
import type { ObjectStore } from '../storage/types.js'
import { publishMedia } from './media.js'

const BODY = Buffer.from('local bytes', 'utf8')
const REMOTE = Buffer.from('remote bytes', 'utf8')

describe('publishMedia', () => {
  let dir: string
  let storeRoot: string
  let store: ObjectStore
  let localPath: string

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'brainrot-media-'))
    storeRoot = mkdtempSync(path.join(tmpdir(), 'brainrot-media-store-'))
    store = fakeStore(storeRoot)
    localPath = path.join(dir, 'final.mp4')
    await store.put('videos/example/job-1.mp4', REMOTE, 'video/mp4')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(storeRoot, { recursive: true, force: true })
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

  it('presigns a URL from the object key', async () => {
    const media = publishMedia({ objectKey: 'videos/example/job-1.mp4', localPath: null, store })
    expect(await media.url(7200)).toContain('videos')
  })

  // A library row predating library_objects: still publishable to YouTube via
  // its local file, but Instagram has nothing to hand Meta.
  it('throws a rejected PublishError from url() when there is no object key', async () => {
    writeFileSync(localPath, BODY)
    const media = publishMedia({ objectKey: null, localPath, store })
    await expect(media.url(7200)).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'rejected',
    })
  })

  it('throws a rejected PublishError from url() when there is no store', async () => {
    const media = publishMedia({
      objectKey: 'videos/example/job-1.mp4',
      localPath: null,
      store: null,
    })
    await expect(media.url(7200)).rejects.toMatchObject({
      name: 'PublishError',
      kind: 'rejected',
    })
  })
})
