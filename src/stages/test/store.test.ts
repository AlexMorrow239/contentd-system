import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classify } from '../../errors.js'
import type { JobContext, StageName } from '../../jobs/types.js'
import { fakeStore } from '../../storage/fake.js'
import type { ObjectStore } from '../../storage/types.js'
import { testChannel } from '../../testing/channel.js'
import { storeStage } from '../store.js'

const VIDEO = Buffer.from('pretend this is an mp4', 'utf8')

describe('storeStage', () => {
  let runDir: string
  let storeRoot: string
  let store: ObjectStore

  function makeCtx(): JobContext {
    return {
      jobId: 'job-123',
      db: null as never, // the stage never touches the database
      channel: testChannel({ name: 'example' }),
      topic: 'a topic',
      runDir,
      artifactPath(stage: StageName, file: string): string {
        const dir = path.join(runDir, stage)
        mkdirSync(dir, { recursive: true })
        return path.join(dir, file)
      },
      log: pino({ level: 'silent' }),
    }
  }

  function writeFinalMp4(body: Buffer = VIDEO): void {
    const dir = path.join(runDir, 'assemble')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'final.mp4'), body)
  }

  beforeEach(() => {
    runDir = mkdtempSync(path.join(tmpdir(), 'brainrot-store-run-'))
    storeRoot = mkdtempSync(path.join(tmpdir(), 'brainrot-store-obj-'))
    store = fakeStore(storeRoot)
  })

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true })
    rmSync(storeRoot, { recursive: true, force: true })
  })

  it('uploads final.mp4 under videos/<channel>/<jobId>.mp4', async () => {
    writeFinalMp4()
    await storeStage(store).run(makeCtx())
    const got = await store.get('videos/example/job-123.mp4')
    expect(got.equals(VIDEO)).toBe(true)
  })

  it('writes store.json carrying the key, byte count and etag', async () => {
    writeFinalMp4()
    await storeStage(store).run(makeCtx())
    const artifact = JSON.parse(readFileSync(path.join(runDir, 'store', 'store.json'), 'utf8')) as {
      objectKey: string
      bytes: number
      etag: string
    }
    expect(artifact.objectKey).toBe('videos/example/job-123.mp4')
    expect(artifact.bytes).toBe(VIDEO.length)
    expect(artifact.etag).toBeTruthy()
  })

  it('uploads with a video/mp4 content type', async () => {
    writeFinalMp4()
    await storeStage(store).run(makeCtx())
    const head = await store.head('videos/example/job-123.mp4')
    expect(head?.contentType).toBe('video/mp4')
  })

  it('fails when assemble produced no final.mp4', async () => {
    const err = await storeStage(store)
      .run(makeCtx())
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/no rendered video/) })
    expect(classify(err)).toMatchObject({ domain: 'job', kind: 'not-found' })
  })

  // Regression test: a permissions error reading a bind-mounted runs/ inside
  // Docker (EACCES/EIO) is a plausible first-hour failure and previously got
  // the exact same message as a genuinely missing file, sending the operator
  // hunting for a render bug instead of a filesystem/permissions issue.
  it('includes the underlying error message when the file exists but cannot be read', async () => {
    const dir = path.join(runDir, 'assemble')
    mkdirSync(dir, { recursive: true })
    const finalPath = path.join(dir, 'final.mp4')
    writeFileSync(finalPath, VIDEO)
    // Make the file unreadable to force an EACCES from readFileSync rather
    // than an ENOENT, without needing a real permissions-restricted mount.
    chmodSync(finalPath, 0o000)
    try {
      await expect(storeStage(store).run(makeCtx())).rejects.toThrow(
        /no rendered video at.+EACCES/s,
      )
    } finally {
      chmodSync(finalPath, 0o644)
    }
  })

  // Guards the truncated-upload case: without it, a short write surfaces as an
  // opaque Meta container ERROR many minutes later with no attributable cause.
  it('fails when the stored byte count does not match what was read', async () => {
    writeFinalMp4()
    const lying: ObjectStore = {
      ...store,
      async head() {
        return { bytes: 1, contentType: 'video/mp4' }
      },
    }
    const err = await storeStage(lying)
      .run(makeCtx())
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/byte count/) })
    expect(classify(err)).toMatchObject({ domain: 'storage', kind: 'transient' })
  })

  it('fails when the object is absent immediately after upload', async () => {
    writeFinalMp4()
    const vanishing: ObjectStore = {
      ...store,
      async head() {
        return null
      },
    }
    const err = await storeStage(vanishing)
      .run(makeCtx())
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/missing immediately/) })
    expect(classify(err)).toMatchObject({ domain: 'storage', kind: 'transient' })
  })

  it('is named store', () => {
    expect(storeStage(store).name).toBe('store')
  })
})
