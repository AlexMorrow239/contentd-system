import type { Database } from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { classify, errorMessage } from '../../errors.js'
import { fakeStore } from '../../storage/fake.js'
import { preflight } from '../preflight.js'
import { tmpDir } from '../../testing/tmp.js'
import { memDb } from '../../testing/db.js'

const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom', 'utf8'),
  Buffer.alloc(64),
])

function seed(db: Database): void {
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1','example','volume','a topic','done')",
  ).run()
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('job-1','runs/job-1/assemble/final.mp4','{}','ready')",
  ).run()
  db.prepare(
    "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1','videos/example/job-1.mp4',?,'e')",
  ).run(VIDEO.length)
}

// The fake's presignGet returns a sentinel URL, so preflight is driven with an
// injected fetch that serves from the same store — exactly the shape the real
// HTTP fetch has against R2.
function servingFetch(body: Buffer, contentType = 'video/mp4', status = 200): typeof fetch {
  const payload = new Uint8Array(body)
  return async () =>
    new Response(status === 200 ? payload : null, {
      status,
      headers: { 'content-type': contentType },
    })
}

describe('preflight', () => {
  it('passes every check for a well-formed stored object', async () => {
    const db = memDb()
    seed(db)
    const store = fakeStore(tmpDir('pf-ok-'))
    await store.put('videos/example/job-1.mp4', VIDEO, 'video/mp4')
    const res = await preflight({
      db,
      jobId: 'job-1',
      platform: 'instagram',
      store,
      fetchImpl: servingFetch(VIDEO),
    })
    expect(res.ok).toBe(true)
    expect(res.checks.every((c) => c.passed)).toBe(true)
  })

  it('fails when the URL returns a non-200', async () => {
    const db = memDb()
    seed(db)
    const store = fakeStore(tmpDir('pf-403-'))
    await store.put('videos/example/job-1.mp4', VIDEO, 'video/mp4')
    const res = await preflight({
      db,
      jobId: 'job-1',
      platform: 'instagram',
      store,
      fetchImpl: servingFetch(VIDEO, 'video/mp4', 403),
    })
    expect(res.ok).toBe(false)
    expect(res.checks.find((c) => c.name === 'http-status')?.passed).toBe(false)
  })

  it('fails on a wrong content type', async () => {
    const db = memDb()
    seed(db)
    const store = fakeStore(tmpDir('pf-ct-'))
    await store.put('videos/example/job-1.mp4', VIDEO, 'video/mp4')
    const res = await preflight({
      db,
      jobId: 'job-1',
      platform: 'instagram',
      store,
      fetchImpl: servingFetch(VIDEO, 'application/octet-stream'),
    })
    expect(res.ok).toBe(false)
    expect(res.checks.find((c) => c.name === 'content-type')?.passed).toBe(false)
  })

  it('fails on a byte-length mismatch against library_objects', async () => {
    const db = memDb()
    seed(db)
    const store = fakeStore(tmpDir('pf-len-'))
    await store.put('videos/example/job-1.mp4', VIDEO, 'video/mp4')
    const res = await preflight({
      db,
      jobId: 'job-1',
      platform: 'instagram',
      store,
      fetchImpl: servingFetch(Buffer.alloc(3)),
    })
    expect(res.ok).toBe(false)
    expect(res.checks.find((c) => c.name === 'byte-length')?.passed).toBe(false)
  })

  it('fails when the body is not an MP4', async () => {
    const db = memDb()
    seed(db)
    const store = fakeStore(tmpDir('pf-magic-'))
    const notMp4 = Buffer.alloc(VIDEO.length, 1)
    await store.put('videos/example/job-1.mp4', notMp4, 'video/mp4')
    const res = await preflight({
      db,
      jobId: 'job-1',
      platform: 'instagram',
      store,
      fetchImpl: servingFetch(notMp4),
    })
    expect(res.ok).toBe(false)
    expect(res.checks.find((c) => c.name === 'mp4-header')?.passed).toBe(false)
  })

  it('throws a legible error when the job has no stored object', async () => {
    const db = memDb()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-2','example','volume','t','done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('job-2','p','{}','ready')",
    ).run()
    const err = await preflight({
      db,
      jobId: 'job-2',
      platform: 'instagram',
      store: fakeStore(tmpDir('pf-none-')),
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toMatch(/backfill-store/)
    expect(classify(err)).toMatchObject({ domain: 'publish', kind: 'not-found' })
  })

  describe('preflight error classification', () => {
    it('classifies a missing library row as publish/not-found', async () => {
      const db = memDb()
      const err = await preflight({
        db,
        jobId: 'no-such-job',
        platform: 'instagram',
        store: fakeStore(tmpDir('pf-missing-')),
      }).catch((e: unknown) => e)
      expect(classify(err)).toMatchObject({ domain: 'publish', kind: 'not-found' })
      expect(errorMessage(err)).toBe('preflight: no library row for job no-such-job')
    })
  })
})
