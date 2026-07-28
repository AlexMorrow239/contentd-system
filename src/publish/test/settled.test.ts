import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import {
  memDb,
  seedJob,
  seedLibrary,
  seedLibraryObject,
  seedPublish,
} from '../../testing/db.js'
import {
  agedCutoff,
  contentionFacts,
  isAged,
  isFullySettled,
  isLegSettled,
  legFactsByJob,
} from '../settled.js'
import type { ContentionFacts, LegFacts } from '../settled.js'
import { MAX_PUBLISH_ATTEMPTS, channelVideoCandidates } from '../publishes.js'
import { pendingInventory } from '../../jobs/library.js'
import { reclaimableObjects } from '../reclaim.js'
import type { Platform } from '../types.js'

function leg(overrides: Partial<LegFacts> = {}): LegFacts {
  return { platform: 'youtube', doneCount: 0, pendingCount: 0, rejectedCount: 0, ...overrides }
}

describe('settled', () => {
  describe('agedCutoff', () => {
    it('subtracts whole days and renders the stored created_at format', () => {
      expect(agedCutoff(new Date('2026-07-27T12:00:00.000Z'), 2)).toBe('2026-07-25T12:00:00.000Z')
    })
  })

  describe('isLegSettled', () => {
    it('settles a done leg regardless of age', () => {
      expect(isLegSettled(leg({ doneCount: 1 }), false)).toBe(true)
      expect(isLegSettled(leg({ doneCount: 1 }), true)).toBe(true)
    })

    it('settles an attempt-capped leg regardless of age', () => {
      const capped = leg({ rejectedCount: MAX_PUBLISH_ATTEMPTS })
      expect(isLegSettled(capped, false)).toBe(true)
      expect(isLegSettled(capped, true)).toBe(true)
    })

    it('does not settle a leg one rejection short of the cap', () => {
      expect(isLegSettled(leg({ rejectedCount: MAX_PUBLISH_ATTEMPTS - 1 }), false)).toBe(false)
    })

    it('does not settle an unattempted leg on a fresh video', () => {
      expect(isLegSettled(undefined, false)).toBe(false)
    })

    it('settles an unattempted leg once the video has aged out', () => {
      expect(isLegSettled(undefined, true)).toBe(true)
    })

    it('never settles a leg with a live claimed or interrupted row, even when aged', () => {
      expect(isLegSettled(leg({ pendingCount: 1 }), true)).toBe(false)
      expect(isLegSettled(leg({ pendingCount: 1 }), false)).toBe(false)
    })

    it('settles an aged leg whose only rows are non-rejected failures', () => {
      // transient/auth/quota failures leave no live row: the video was never
      // taken and never will be, so age settles it.
      expect(isLegSettled(leg({ rejectedCount: 0 }), true)).toBe(true)
    })
  })

  describe('isFullySettled', () => {
    it('is true when every declared platform is settled', () => {
      expect(
        isFullySettled({
          declared: ['youtube', 'instagram'],
          legs: [leg({ platform: 'youtube', doneCount: 1 }), leg({ platform: 'instagram', doneCount: 1 })],
          aged: false,
        }),
      ).toBe(true)
    })

    it('is false when one declared platform is still open on a fresh video', () => {
      expect(
        isFullySettled({
          declared: ['youtube', 'instagram'],
          legs: [leg({ platform: 'instagram', doneCount: 1 })],
          aged: false,
        }),
      ).toBe(false)
    })

    it('is true for the passed-over video once it ages out', () => {
      // The 10-a-day-against-YouTube's-6 case: instagram took it, youtube
      // never attempted it, and tomorrow's videos outrank it forever.
      expect(
        isFullySettled({
          declared: ['youtube', 'instagram'],
          legs: [leg({ platform: 'instagram', doneCount: 1 })],
          aged: true,
        }),
      ).toBe(true)
    })

    it('ignores legs for platforms the channel does not declare', () => {
      expect(
        isFullySettled({
          declared: ['instagram'],
          legs: [leg({ platform: 'instagram', doneCount: 1 }), leg({ platform: 'youtube' })],
          aged: false,
        }),
      ).toBe(true)
    })

    it('is false when a channel declares no platforms at all', () => {
      expect(isFullySettled({ declared: [], legs: [], aged: true })).toBe(false)
    })
  })

  describe('legFactsByJob', () => {
    it('groups per (job, platform) and counts each status class', () => {
      const db = memDb()
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1')
      seedJob(db, 'job-2')
      seedLibrary(db, 'job-2')
      seedPublish(db, 'job-1', { platform: 'youtube', status: 'done', seq: 1 })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'failed', errorKind: 'rejected', seq: 2 })
      seedPublish(db, 'job-1', { platform: 'instagram', status: 'failed', errorKind: 'transient', seq: 3 })
      seedPublish(db, 'job-2', { platform: 'youtube', status: 'interrupted', seq: 4 })

      const byJob = legFactsByJob(db, ['job-1', 'job-2'])

      expect(byJob.get('job-1')).toEqual([
        { platform: 'instagram', doneCount: 0, pendingCount: 0, rejectedCount: 1 },
        { platform: 'youtube', doneCount: 1, pendingCount: 0, rejectedCount: 0 },
      ])
      expect(byJob.get('job-2')).toEqual([
        { platform: 'youtube', doneCount: 0, pendingCount: 1, rejectedCount: 0 },
      ])
    })

    it('returns an empty map for no job ids without touching the database', () => {
      const db = memDb()
      expect(legFactsByJob(db, []).size).toBe(0)
    })

    it('omits jobs with no publishes rows', () => {
      const db = memDb()
      seedJob(db, 'job-1')
      seedLibrary(db, 'job-1')
      expect(legFactsByJob(db, ['job-1']).has('job-1')).toBe(false)
    })
  })

  describe('isAged', () => {
    const CUTOFF = '2026-07-25T00:00:00.000Z'
    const facts = (rows: { jobId: string; at: string }[]): ContentionFacts => ({ recentDone: rows })

    it('is false for a video newer than the cutoff, contended or not', () => {
      expect(
        isAged(facts([{ jobId: 'other', at: '2026-07-28T00:00:00.000Z' }]), {
          jobId: 'job-1',
          createdAt: '2026-07-26T00:00:00.000Z',
        }, CUTOFF),
      ).toBe(false)
    })

    it('is false for an old video no other job published past', () => {
      // The publish outage: old enough, but nothing outranked it.
      expect(
        isAged(facts([]), { jobId: 'job-1', createdAt: '2026-07-20T00:00:00.000Z' }, CUTOFF),
      ).toBe(false)
    })

    it('does not count the video’s own publish as contention', () => {
      expect(
        isAged(facts([{ jobId: 'job-1', at: '2026-07-28T00:00:00.000Z' }]), {
          jobId: 'job-1',
          createdAt: '2026-07-20T00:00:00.000Z',
        }, CUTOFF),
      ).toBe(false)
    })

    it('does not count a publish that predates the video', () => {
      expect(
        isAged(facts([{ jobId: 'other', at: '2026-07-19T00:00:00.000Z' }]), {
          jobId: 'job-1',
          createdAt: '2026-07-20T00:00:00.000Z',
        }, CUTOFF),
      ).toBe(false)
    })

    it('is true when another job published after this old video was produced', () => {
      expect(
        isAged(facts([{ jobId: 'other', at: '2026-07-26T00:00:00.000Z' }]), {
          jobId: 'job-1',
          createdAt: '2026-07-20T00:00:00.000Z',
        }, CUTOFF),
      ).toBe(true)
    })

    it('sees past the video’s own row to the runner-up', () => {
      // Two rows is the whole read (contentionFacts LIMIT 2): the newest done
      // publish being the video's own must not hide the one behind it.
      expect(
        isAged(
          facts([
            { jobId: 'job-1', at: '2026-07-28T00:00:00.000Z' },
            { jobId: 'other', at: '2026-07-27T00:00:00.000Z' },
          ]),
          { jobId: 'job-1', createdAt: '2026-07-20T00:00:00.000Z' },
          CUTOFF,
        ),
      ).toBe(true)
    })
  })

  describe('contentionFacts', () => {
    it('reads the newest done publish per job, newest first, capped at two', () => {
      const db = memDb()
      for (const id of ['job-1', 'job-2', 'job-3']) {
        seedJob(db, id, { channel: 'chan-a' })
        seedLibrary(db, id)
      }
      seedPublish(db, 'job-1', { status: 'done', seq: 1, createdAt: '2026-07-21T00:00:00.000Z' })
      seedPublish(db, 'job-2', { status: 'done', seq: 2, createdAt: '2026-07-22T00:00:00.000Z' })
      seedPublish(db, 'job-3', { status: 'done', seq: 3, createdAt: '2026-07-23T00:00:00.000Z' })
      // Not done, and another channel's: neither is evidence.
      seedPublish(db, 'job-1', { status: 'failed', seq: 4, createdAt: '2026-07-24T00:00:00.000Z' })
      seedJob(db, 'job-b', { channel: 'chan-b' })
      seedLibrary(db, 'job-b')
      seedPublish(db, 'job-b', {
        channel: 'chan-b',
        status: 'done',
        seq: 1,
        createdAt: '2026-07-25T00:00:00.000Z',
      })

      expect(contentionFacts(db, 'chan-a').recentDone).toEqual([
        { jobId: 'job-3', at: '2026-07-23T00:00:00.000Z' },
        { jobId: 'job-2', at: '2026-07-22T00:00:00.000Z' },
      ])
      db.close()
    })

    it('is empty for a channel that has never published', () => {
      const db = memDb()
      expect(contentionFacts(db, 'chan-a').recentDone).toEqual([])
      db.close()
    })
  })

  describe('the passed-over video, end to end', () => {
    // The 10-a-day-against-YouTube's-6 case: instagram published it, youtube
    // never attempted it, tomorrow's videos outrank it forever. Reclaimable,
    // not inventory, and not a candidate — the three must agree, or the
    // channel either leaks bytes or wedges its own production.
    const DECLARED: Platform[] = ['youtube', 'instagram']
    const CUTOFF = '2026-07-25T00:00:00.000Z'

    function seedPassedOver(db: Database, createdAt: string): void {
      seedJob(db, 'job-1', { channel: 'chan-a' })
      seedLibrary(db, 'job-1', { state: 'published', createdAt })
      seedLibraryObject(db, 'job-1', { objectKey: 'videos/chan-a/job-1.mp4', bytes: 2048 })
      seedPublish(db, 'job-1', { platform: 'instagram', channel: 'chan-a', status: 'done', seq: 1 })
    }

    // What "passed over" actually means: a NEWER video took the slot. Seeded
    // separately from the video under test because it is the thing being
    // asserted about — with no contention the horizon must not fire at all
    // (the outage case below).
    function seedOutranker(db: Database): void {
      seedJob(db, 'job-2', { channel: 'chan-a' })
      seedLibrary(db, 'job-2', { state: 'published', createdAt: '2026-07-26T00:00:00.000Z' })
      seedPublish(db, 'job-2', {
        platform: 'instagram',
        channel: 'chan-a',
        status: 'done',
        seq: 2,
        createdAt: '2026-07-26T00:00:00.000Z',
      })
    }

    it('is held by all three while it is still fresh', () => {
      const db = memDb()
      seedPassedOver(db, '2026-07-26T00:00:00.000Z')

      expect(
        reclaimableObjects(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF, limit: 25 }),
      ).toEqual([])
      expect(pendingInventory(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF })).toBe(1)
      expect(channelVideoCandidates(db, 'chan-a', DECLARED, 50, CUTOFF).map((r) => r.jobId)).toEqual(['job-1'])
    })

    it('is released by all three once it ages out behind a newer video', () => {
      const db = memDb()
      seedPassedOver(db, '2026-07-20T00:00:00.000Z')
      seedOutranker(db)

      expect(
        reclaimableObjects(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF, limit: 25 }).map(
          (r) => r.jobId,
        ),
      ).toEqual(['job-1'])
      // job-2 is fresh and still owed to youtube, so it is the only inventory.
      expect(pendingInventory(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF })).toBe(1)
      expect(channelVideoCandidates(db, 'chan-a', DECLARED, 50, CUTOFF).map((r) => r.jobId)).toEqual(['job-2'])
    })

    it('is held by all three when nothing ever outranked it', () => {
      // The publish outage — host down, credential expired — for longer than
      // backlog_days. All three consumers must agree that the horizon has NOT
      // fired: reclaim it and the bytes of a still-publishable video are gone;
      // drop it from candidates while still counting it as inventory and the
      // channel's production wedges behind a backlog nothing can drain.
      const db = memDb()
      seedPassedOver(db, '2026-07-20T00:00:00.000Z')
      db.prepare("DELETE FROM publishes WHERE job_id = 'job-1'").run()

      expect(
        reclaimableObjects(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF, limit: 25 }),
      ).toEqual([])
      expect(pendingInventory(db, { channel: 'chan-a', declared: DECLARED, createdAfter: CUTOFF })).toBe(1)
      expect(channelVideoCandidates(db, 'chan-a', DECLARED, 50, CUTOFF).map((r) => r.jobId)).toEqual(['job-1'])
    })
  })
})
