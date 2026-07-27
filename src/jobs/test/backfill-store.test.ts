import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeStore } from '../../storage/fake.js'
import { backfillStore } from '../backfill-store.js'
import { memDb } from '../../testing/db.js'

describe('backfillStore', () => {
  it('uploads library rows that have a local file but no object row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brainrot-backfill-'))
    const videoPath = path.join(dir, 'final.mp4')
    writeFileSync(videoPath, Buffer.from('mp4 bytes'))
    const db = memDb()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1','example','volume','t','done')",
    ).run()
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?,?,?,?)',
    ).run('job-1', videoPath, '{}', 'ready')

    const store = fakeStore(path.join(dir, 'objects'))
    const res = await backfillStore({ db, store })

    expect(res.uploaded).toEqual(['job-1'])
    expect((await store.get('videos/example/job-1.mp4')).toString()).toBe('mp4 bytes')
    expect(
      db.prepare("SELECT object_key AS k FROM library_objects WHERE job_id = 'job-1'").get(),
    ).toEqual({ k: 'videos/example/job-1.mp4' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips rows whose local file is gone', async () => {
    const db = memDb()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1','example','volume','t','done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('job-1','/nonexistent/final.mp4','{}','ready')",
    ).run()
    const res = await backfillStore({
      db,
      store: fakeStore(mkdtempSync(path.join(tmpdir(), 'b-'))),
    })
    expect(res.uploaded).toEqual([])
    expect(res.skipped).toEqual(['job-1'])
  })

  // Regression test: `library reject` deletes both the R2 object and the
  // library_objects row, leaving a 'blocked' row that looks identical to a
  // pre-storage row missing its upload — matching this command's query
  // exactly unless the state is excluded. Without the guard this re-uploads
  // a video the operator deliberately deleted.
  it('does not touch a blocked (rejected) row even with a local file and no object row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'brainrot-backfill-'))
    const videoPath = path.join(dir, 'final.mp4')
    writeFileSync(videoPath, Buffer.from('mp4 bytes'))
    const db = memDb()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1','example','volume','t','done')",
    ).run()
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?,?,?,?)',
    ).run('job-1', videoPath, '{}', 'blocked')

    const store = fakeStore(path.join(dir, 'objects'))
    const res = await backfillStore({ db, store })

    expect(res.uploaded).toEqual([])
    expect(res.skipped).toEqual([])
    expect(
      db.prepare("SELECT object_key AS k FROM library_objects WHERE job_id = 'job-1'").get(),
    ).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves rows that already have an object row alone', async () => {
    const db = memDb()
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-1','example','volume','t','done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('job-1','p','{}','ready')",
    ).run()
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1','k',1,'e')",
    ).run()
    const res = await backfillStore({
      db,
      store: fakeStore(mkdtempSync(path.join(tmpdir(), 'b-'))),
    })
    expect(res.uploaded).toEqual([])
    expect(res.skipped).toEqual([])
  })
})
