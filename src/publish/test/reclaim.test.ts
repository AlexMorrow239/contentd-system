import { describe, expect, it, vi } from 'vitest'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../testing/db.js'
import { tmpDir } from '../../testing/tmp.js'
import { fakeStore } from '../../storage/fake.js'
import { reclaimableObjects, reclaimObjects } from '../reclaim.js'

const YEAR_AGO = '2025-07-27T00:00:00.000Z'
const CUTOFF = '2026-07-25T00:00:00.000Z'
const FRESH = '2026-07-26T00:00:00.000Z'
const AGED = '2026-07-20T00:00:00.000Z'

function seedVideo(
  db: ReturnType<typeof memDb>,
  jobId: string,
  opts: { createdAt: string; state?: string; object?: boolean; reclaimedAt?: string },
): void {
  seedJob(db, jobId, { channel: 'chan-a' })
  seedLibrary(db, jobId, { state: opts.state ?? 'published', createdAt: opts.createdAt })
  if (opts.object !== false) {
    seedLibraryObject(db, jobId, {
      objectKey: `videos/chan-a/${jobId}.mp4`,
      bytes: 2048,
      reclaimedAt: opts.reclaimedAt,
    })
  }
}

describe('reclaim', () => {
  describe('reclaimableObjects', () => {
    it('returns a video every declared platform has published', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      seedPublish(db, 'job-1', { platform: 'youtube', status: 'done', seq: 1 })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 2 })

      const rows = reclaimableObjects(db, {
        channel: 'chan-a',
        declared: ['youtube', 'instagram'],
        createdAfter: CUTOFF,
        limit: 25,
      })

      expect(rows).toEqual([{ jobId: 'job-1', objectKey: 'videos/chan-a/job-1.mp4', bytes: 2048 }])
    })

    it('holds a fresh video one platform has not taken yet', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('releases that same video once it ages past the horizon', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }).map((r) => r.jobId),
      ).toEqual(['job-1'])
    })

    it('holds an aged video whose leg is still interrupted', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1 })
      seedPublish(db, 'job-1', { platform: 'youtube', status: 'interrupted', seq: 2 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('skips an already-reclaimed object', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH, reclaimedAt: '2026-07-26T12:00:00.000Z' })
      seedPublish(db, 'job-1', { platform: 'youtube', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('skips a video with no stored object at all', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH, object: false })
      seedPublish(db, 'job-1', { platform: 'youtube', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('ignores another channel', () => {
      const db = memDb()
      seedJob(db, 'job-b', { channel: 'chan-b' })
      seedLibrary(db, 'job-b', { state: 'published', createdAt: FRESH })
      seedLibraryObject(db, 'job-b')
      seedPublish(db, 'job-b', { platform: 'youtube', channel: 'chan-b', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('caps the batch at limit', () => {
      const db = memDb()
      for (const id of ['job-1', 'job-2', 'job-3']) {
        seedVideo(db, id, { createdAt: YEAR_AGO })
      }

      const rows = reclaimableObjects(db, {
        channel: 'chan-a',
        declared: ['youtube'],
        createdAfter: CUTOFF,
        limit: 2,
      })

      expect(rows).toHaveLength(2)
    })

    it('returns nothing for a channel declaring no platforms', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: YEAR_AGO })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: [],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })
  })

  describe('reclaimObjects', () => {
    it('deletes each object, stamps reclaimed_at, and totals the bytes', async () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      const store = fakeStore(tmpDir('reclaim-'))
      await store.put('videos/chan-a/job-1.mp4', Buffer.from('video'), 'video/mp4')

      const result = await reclaimObjects({
        db,
        objects: [{ jobId: 'job-1', objectKey: 'videos/chan-a/job-1.mp4', bytes: 2048 }],
        store,
      })

      expect(result).toEqual({ reclaimed: ['job-1'], failed: [], bytes: 2048 })
      expect(await store.head('videos/chan-a/job-1.mp4')).toBeNull()
      const row = db.prepare('SELECT reclaimed_at AS at FROM library_objects WHERE job_id = ?').get('job-1') as
        { at: string | null }
      expect(row.at).not.toBeNull()
    })

    it('leaves reclaimed_at NULL and warns when the delete throws', async () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      const store = fakeStore(tmpDir('reclaim-'))
      store.delete = () => Promise.reject(new Error('bucket unreachable'))
      const warn = vi.fn()

      const result = await reclaimObjects({
        db,
        objects: [{ jobId: 'job-1', objectKey: 'videos/chan-a/job-1.mp4', bytes: 2048 }],
        store,
        warn,
      })

      expect(result).toEqual({ reclaimed: [], failed: ['job-1'], bytes: 0 })
      const row = db.prepare('SELECT reclaimed_at AS at FROM library_objects WHERE job_id = ?').get('job-1') as
        { at: string | null }
      expect(row.at).toBeNull()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain('videos/chan-a/job-1.mp4')
    })

    it('continues past one failure to the remaining objects', async () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      seedVideo(db, 'job-2', { createdAt: FRESH })
      const store = fakeStore(tmpDir('reclaim-'))
      const realDelete = store.delete.bind(store)
      store.delete = (key: string) =>
        key.includes('job-1') ? Promise.reject(new Error('nope')) : realDelete(key)

      const result = await reclaimObjects({
        db,
        objects: [
          { jobId: 'job-1', objectKey: 'videos/chan-a/job-1.mp4', bytes: 100 },
          { jobId: 'job-2', objectKey: 'videos/chan-a/job-2.mp4', bytes: 200 },
        ],
        store,
        warn: () => {},
      })

      expect(result).toEqual({ reclaimed: ['job-2'], failed: ['job-1'], bytes: 200 })
    })
  })
})
