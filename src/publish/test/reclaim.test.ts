import { describe, expect, it, vi } from 'vitest'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../testing/db.js'
import { tmpDir } from '../../testing/tmp.js'
import { fakeStore } from '../../storage/fake.js'
import { RECLAIM_SCAN_LIMIT, reclaimableObjects, reclaimObjects } from '../reclaim.js'

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

/**
 * The contention evidence ageing out requires: a DIFFERENT job of this channel
 * that actually published INSIDE the grace window of the video under test —
 * after that video was produced and no later than the horizon. Without it
 * nothing outranked the video — publishing simply never ran, or only recovered
 * after the window closed — and the horizon must not fire (settled.ts,
 * isAged).
 *
 * Published to instagram only, and to no youtube leg, so it is never itself
 * reclaimable for any platform set these tests declare: it adds contention
 * without adding a candidate.
 */
const CONTENTION_AT = '2026-07-24T00:00:00.000Z'

function seedContention(db: ReturnType<typeof memDb>, jobId = 'newer-job'): void {
  seedVideo(db, jobId, { createdAt: '2026-07-23T00:00:00.000Z' })
  seedPublish(db, jobId, { platform: 'instagram', status: 'done', seq: 9, createdAt: CONTENTION_AT })
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
      seedContention(db)

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
      seedContention(db)

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
      seedContention(db)

      const rows = reclaimableObjects(db, {
        channel: 'chan-a',
        declared: ['youtube'],
        createdAfter: CUTOFF,
        limit: 2,
      })

      expect(rows).toHaveLength(2)
    })

    it('holds every aged video when the channel has published nothing at all', () => {
      // The publish outage: the host was down (or a credential expired) for
      // longer than backlog_days. Nothing outranked these videos — publishing
      // never ran — so the first recovering tick must not delete the bytes of
      // the whole channel and then refuse to publish any of it.
      const db = memDb()
      for (const id of ['job-1', 'job-2', 'job-3']) {
        seedVideo(db, id, { createdAt: YEAR_AGO })
      }

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('does not treat a video’s own publish as contention', () => {
      // One video, published to instagram long ago, youtube never attempted.
      // Its OWN done row is the only publish on the channel, so nothing
      // outranked it — it is old, not passed over.
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: YEAR_AGO })
      seedPublish(db, 'job-1', {
        platform: 'instagram',
        status: 'done',
        seq: 1,
        createdAt: AGED,
      })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('ignores a done publish that predates the video', () => {
      // Contention means something published AFTER this video was produced.
      // An older sibling's post did not take a slot this video was waiting for.
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1 })
      // No stored object of its own, so the only candidate here is job-1.
      seedVideo(db, 'older-job', { createdAt: YEAR_AGO, object: false })
      seedPublish(db, 'older-job', {
        platform: 'youtube',
        status: 'done',
        seq: 2,
        createdAt: YEAR_AGO,
      })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }).map((r) => r.jobId),
      ).toEqual([])
    })

    it('counts another channel’s publishes as no contention at all', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1 })
      seedJob(db, 'job-b', { channel: 'chan-b' })
      seedLibrary(db, 'job-b', { state: 'published', createdAt: FRESH })
      seedPublish(db, 'job-b', { platform: 'youtube', channel: 'chan-b', status: 'done', seq: 1 })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('ignores a done publish that lands after the horizon', () => {
      // The recovering outage: nothing published while job-1 waited, and the
      // first publish after credentials were fixed is not evidence that job-1
      // was passed over. Deleting its bytes here is exactly the damage the
      // window's upper bound exists to stop.
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1, createdAt: AGED })
      seedVideo(db, 'recovered-job', { createdAt: AGED, object: false })
      seedPublish(db, 'recovered-job', {
        platform: 'youtube',
        status: 'done',
        seq: 2,
        createdAt: '2026-07-27T00:00:00.000Z',
      })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }),
      ).toEqual([])
    })

    it('accepts a done publish landing exactly at the horizon', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: AGED })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1, createdAt: AGED })
      seedVideo(db, 'edge-job', { createdAt: AGED, object: false })
      seedPublish(db, 'edge-job', {
        platform: 'youtube',
        status: 'done',
        seq: 2,
        createdAt: CUTOFF,
      })

      expect(
        reclaimableObjects(db, {
          channel: 'chan-a',
          declared: ['youtube', 'instagram'],
          createdAfter: CUTOFF,
          limit: 25,
        }).map((r) => r.jobId),
      ).toEqual(['job-1'])
    })

    it('does not accept a later failed, claimed or interrupted row as contention', () => {
      // Only 'done' is evidence that a slot was actually consumed.
      for (const status of ['failed', 'claimed', 'interrupted'] as const) {
        const db = memDb()
        seedVideo(db, 'job-1', { createdAt: AGED })
        seedPublish(db, 'job-1', { platform: 'instagram', status: 'done', seq: 1, createdAt: AGED })
        seedVideo(db, 'other-job', { createdAt: AGED, object: false })
        seedPublish(db, 'other-job', {
          platform: 'youtube',
          status,
          seq: 2,
          createdAt: CONTENTION_AT,
        })

        expect(
          reclaimableObjects(db, {
            channel: 'chan-a',
            declared: ['youtube', 'instagram'],
            createdAfter: CUTOFF,
            limit: 25,
          }),
        ).toEqual([])
      }
    })

    it('warns when the scan comes back full', () => {
      // RECLAIM_SCAN_LIMIT rows means reclaimable objects may exist past the
      // window this call could see — and oldest-first means the next tick
      // reads the same prefix, so silence would read as "nothing left".
      const db = memDb()
      const insert = db.transaction(() => {
        for (let i = 0; i < RECLAIM_SCAN_LIMIT; i++) {
          seedVideo(db, `job-${String(i).padStart(4, '0')}`, { createdAt: YEAR_AGO })
        }
      })
      insert()
      const warn = vi.fn()

      reclaimableObjects(db, {
        channel: 'chan-a',
        declared: ['youtube'],
        createdAfter: CUTOFF,
        limit: 25,
        warn,
      })

      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain(String(RECLAIM_SCAN_LIMIT))
      expect(warn.mock.calls[0][0]).toContain('chan-a')
    })

    it('does not warn on a scan that fits', () => {
      const db = memDb()
      seedVideo(db, 'job-1', { createdAt: FRESH })
      const warn = vi.fn()

      reclaimableObjects(db, {
        channel: 'chan-a',
        declared: ['youtube'],
        createdAfter: CUTOFF,
        limit: 25,
        warn,
      })

      expect(warn).not.toHaveBeenCalled()
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
