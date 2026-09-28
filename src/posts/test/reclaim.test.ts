import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPost } from '../../testing/db.js'
import { reclaimableObjects } from '../reclaim.js'

describe('reclaimableObjects', () => {
  function seedStored(db: ReturnType<typeof memDb>, jobId: string): void {
    seedJob(db, jobId, { channel: 'alpha' })
    seedLibrary(db, jobId, { state: 'ready' })
    seedLibraryObject(db, jobId, { objectKey: `videos/alpha/${jobId}.mp4`, bytes: 10 })
  }

  it('returns nothing while a declared platform is unposted', () => {
    const db = memDb()
    seedStored(db, 'j1')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    expect(
      reclaimableObjects(db, { channel: 'alpha', declared: ['youtube', 'tiktok'], limit: 10 }),
    ).toEqual([])
  })

  it('returns the object once every declared platform is posted', () => {
    const db = memDb()
    seedStored(db, 'j1')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    const out = reclaimableObjects(db, { channel: 'alpha', declared: ['youtube'], limit: 10 })
    expect(out).toEqual([{ jobId: 'j1', objectKey: 'videos/alpha/j1.mp4', bytes: 10 }])
  })

  // A channel with no checklist has no definition of "done", so freeing its
  // bytes would be a guess. Discarding the video is the explicit path.
  it('returns nothing when no platforms are declared', () => {
    const db = memDb()
    seedStored(db, 'j1')
    expect(reclaimableObjects(db, { channel: 'alpha', declared: [], limit: 10 })).toEqual([])
  })

  it('skips an already-reclaimed object', () => {
    const db = memDb()
    seedStored(db, 'j1')
    seedPost(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    db.prepare("UPDATE library_objects SET reclaimed_at = '2026-01-01T00:00:00.000Z'").run()
    expect(reclaimableObjects(db, { channel: 'alpha', declared: ['youtube'], limit: 10 })).toEqual(
      [],
    )
  })

  it('honours the batch limit, oldest first', () => {
    const db = memDb()
    for (const id of ['j1', 'j2', 'j3']) {
      seedStored(db, id)
      seedPost(db, { jobId: id, channel: 'alpha', platform: 'youtube' })
    }
    db.prepare(
      "UPDATE library SET created_at = '2020-01-0' || substr(job_id, 2) || 'T00:00:00.000Z'",
    ).run()
    const out = reclaimableObjects(db, { channel: 'alpha', declared: ['youtube'], limit: 2 })
    expect(out.map((o) => o.jobId)).toEqual(['j1', 'j2'])
  })
})
