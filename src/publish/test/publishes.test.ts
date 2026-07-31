import type { Database } from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { claimTopic, insertTopics, redditCandidates } from '../../scout/topics.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../testing/db.js'
import { DAY_MS, isoAgo, recordTransactionModes } from './_publishes.fixtures.js'
import {
  channelVideoCandidates,
  claimPublish,
  lastAttemptAt,
  listPublishes,
  markInterruptedDone,
  markPublishDone,
  markPublishFailed,
  MAX_PUBLISH_ATTEMPTS,
  quotaBackedOff,
  QUOTA_BACKOFF_MS,
  retryInterrupted,
  sweepInterrupted,
  uploadsUsedToday,
  videosPublishedToday,
} from '../publishes.js'
import { PUBLISH_PLATFORMS } from '../types.js'

/**
 * The DAO for the `publishes` table: claiming a slot, closing it out, the
 * channelVideoCandidates selection query, the read-only accounting queries,
 * and the interrupted-row repair path. One describe per exported function;
 * shared fixtures live in _publishes.fixtures.ts and src/testing/db.ts.
 */

/**
 * The contention half of the aged-out clause: a DIFFERENT job of chan-a that
 * really did publish INSIDE the grace window of the aged videos under test —
 * after they were produced (2026-07-20) and no later than the horizon those
 * tests pass (2026-07-25). Without it the horizon must not fire at all —
 * nothing outranked them, publishing just never ran, or it only recovered
 * after the window had closed.
 *
 * No library row, deliberately: it supplies evidence without ever being a
 * candidate itself, so assertions stay about the videos under test.
 */
function seedOutranker(db: ReturnType<typeof memDb>): void {
  seedJob(db, 'job-outranker', { channel: 'chan-a' })
  seedPublish(db, 'job-outranker', {
    platform: 'youtube',
    channel: 'chan-a',
    status: 'done',
    seq: 99,
    createdAt: '2026-07-23T00:00:00.000Z',
  })
}

describe('claimPublish', () => {
  it('numbers attempts 1-based per (jobId, platform), counting every prior row regardless of day', () => {
    const db = memDb()
    seedJob(db, 'job-1')

    const first = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })
    expect(first).not.toBeNull()
    expect(
      (
        db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(first?.id) as {
          attempt: number
        }
      ).attempt,
    ).toBe(1)
    db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(first?.id)

    const second = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })
    expect(
      (
        db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(second?.id) as {
          attempt: number
        }
      ).attempt,
    ).toBe(2)
    db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(second?.id)

    const third = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-21',
    })
    expect(
      (
        db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(third?.id) as {
          attempt: number
        }
      ).attempt,
    ).toBe(3)
    db.close()
  })

  it('counts prior attempts and inserts inside one immediate transaction', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    const modes = recordTransactionModes(db)

    claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })

    expect(modes).toEqual(['immediate'])
    db.close()
  })
})

describe('claimPublish seq', () => {
  it('numbers the first claim of a (channel, platform, day) as 1 and returns it', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(claim).toEqual({ id: expect.any(Number), seq: 1 })
    db.close()
  })

  it('increments seq per (channel, platform, day), independently per platform', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    const a = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    const b = claimPublish(db, {
      jobId: 'job-2',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    const c = claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect([a?.seq, b?.seq, c?.seq]).toEqual([1, 2, 1])
    db.close()
  })

  it('restarts seq at 1 on the next day', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    const next = claimPublish(db, {
      jobId: 'job-2',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-23',
    })
    expect(next?.seq).toBe(1)
    db.close()
  })

  it('self-heals a sequence gap: the next claim gets seq 4, not a doomed retry of seq 3', () => {
    // Rows at seq 1 and 3 (seq 2 never landed — a rejected/retired attempt).
    // COUNT(*) + 1 would recompute 3, collide with the UNIQUE constraint, and
    // report claim-conflict for every claim the rest of the day. MAX(seq) + 1
    // lands on 4, the first genuinely free ordinal. The gap is a property of
    // the (channel, platform, day) partition, so the three rows are three
    // different videos — one job cannot hold two live rows for a platform.
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    seedJob(db, 'job-3', { channel: 'chan-a' })
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) VALUES ' +
        "('job-1','youtube','chan-a','2026-07-22',1,'failed',1)," +
        "('job-2','youtube','chan-a','2026-07-22',3,'done',1)",
    ).run()
    const claim = claimPublish(db, {
      jobId: 'job-3',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(claim?.seq).toBe(4)
    db.close()
  })

  it('returns null rather than throwing when the computed seq is already taken', () => {
    // MAX(seq) + 1 always lands on an ordinal absent from the table, so a
    // genuine UNIQUE conflict can only happen when a second writer's INSERT
    // lands between this transaction's MAX(seq) read and its own INSERT — the
    // exact race `.immediate()` closes in production. Simulated here by
    // stubbing the MAX(seq) read to return a stale value (as if the row below
    // hadn't committed yet when it was read), so the INSERT this call issues
    // collides with a row that genuinely already holds that seq.
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    // A DIFFERENT job holds seq 1, so the collision below is the seq UNIQUE
    // this test is about and not ux_publishes_live's (job, platform) rule.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) VALUES ' +
        "('job-2','youtube','chan-a','2026-07-22',1,'done',1)",
    ).run()
    const originalPrepare = db.prepare.bind(db)
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('MAX(seq)')) {
        return { get: () => ({ maxSeq: 0 }) } as unknown as ReturnType<typeof originalPrepare>
      }
      return originalPrepare(sql)
    })
    // try/finally, not an inline restore: a throwing assertion below would
    // otherwise leak the db.prepare spy into every later test in this file.
    try {
      expect(
        claimPublish(db, {
          jobId: 'job-1',
          platform: 'youtube',
          channel: 'chan-a',
          day: '2026-07-22',
        }),
      ).toBeNull()
      // The failed INSERT is rolled back whole: still exactly the one seeded
      // row, no half-written attempt counter.
      expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 1 })
    } finally {
      prepareSpy.mockRestore()
    }
    db.close()
  })

  it('refuses a second live claim for the same (job, platform)', () => {
    // The database-level double-publish backstop (ux_publishes_live, added in
    // db/migrate.ts). Two lease holders racing each other both read the video
    // as open in channelVideoCandidates — outside this transaction — so the
    // second one only stops here, at the INSERT. It maps to the tick's
    // existing claim-conflict outcome, so no upload is attempted.
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    const first = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(first).not.toBeNull()

    const second = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })

    expect(second).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 1 })
    db.close()
  })

  it('still counts attempts per (job, platform), independent of seq', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    const first = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, first!.id, 'boom', 'transient', new Date())
    const second = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    const row = listPublishes(db).find((r) => r.id === second!.id)
    expect(row?.attempt).toBe(2)
    expect(row?.seq).toBe(2)
    db.close()
  })
})

describe('markPublishDone', () => {
  it('flips the publish row to done and the library row to published in one transaction', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })
    const id = claim!.id

    markPublishDone(
      db,
      id,
      'yt-abc123',
      'https://youtube.com/shorts/yt-abc123',
      new Date('2026-07-20T10:01:00.000Z'),
    )

    expect(
      db.prepare('SELECT status, post_id, url, finished_at FROM publishes WHERE id = ?').get(id),
    ).toEqual({
      status: 'done',
      post_id: 'yt-abc123',
      url: 'https://youtube.com/shorts/yt-abc123',
      finished_at: '2026-07-20T10:01:00.000Z',
    })
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as { state: string })
        .state,
    ).toBe('published')
    db.close()
  })

  it('runs the two-table flip in one immediate transaction', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })
    const modes = recordTransactionModes(db)

    markPublishDone(db, claim!.id, 'yt-abc123', 'https://youtube.com/shorts/yt-abc123', new Date())

    expect(modes).toEqual(['immediate'])
    db.close()
  })

  it('leaves both tables untouched when no row carries the id', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })

    markPublishDone(db, 999, 'yt-ghost', 'https://youtube.com/shorts/yt-ghost', new Date())

    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as { state: string })
        .state,
    ).toBe('ready')
    db.close()
  })
})

describe('markPublishFailed', () => {
  it('records the failure and leaves the library row ready', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
    })
    const id = claim!.id

    markPublishFailed(
      db,
      id,
      'upload rejected: bad metadata',
      'rejected',
      new Date('2026-07-20T10:02:00.000Z'),
    )

    expect(
      db
        .prepare('SELECT status, error, error_kind, finished_at FROM publishes WHERE id = ?')
        .get(id),
    ).toEqual({
      status: 'failed',
      error: 'upload rejected: bad metadata',
      error_kind: 'rejected',
      finished_at: '2026-07-20T10:02:00.000Z',
    })
    expect(
      (db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as { state: string })
        .state,
    ).toBe('ready')
    db.close()
  })
})

describe('channelVideoCandidates', () => {
  it('returns nothing for a channel with no publishable library rows', () => {
    const db = memDb()
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z'),
    ).toEqual([])
    db.close()
  })

  it('returns a ready video with no platforms blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a', topic: 'ready topic' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z'),
    ).toEqual([
      {
        jobId: 'job-1',
        videoPath: '/runs/job-1/assemble/final.mp4',
        objectKey: null,
        metadataJson: '{}',
        topic: 'ready topic',
        blockedPlatforms: [],
        seriesBlockedPlatforms: [],
      },
    ])
    db.close()
  })

  it('excludes library rows that are not publishable', () => {
    const db = memDb()
    seedJob(db, 'job-ready', { channel: 'chan-a' })
    seedJob(db, 'job-review', { channel: 'chan-a' })
    seedJob(db, 'job-blocked', { channel: 'chan-a' })
    seedLibrary(db, 'job-ready', { state: 'ready' })
    seedLibrary(db, 'job-review', { state: 'needs-review' })
    seedLibrary(db, 'job-blocked', { state: 'blocked' })
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z').map(
        (r) => r.jobId,
      ),
    ).toEqual(['job-ready'])
    db.close()
  })

  // library_objects is LEFT-joined, never inner-joined: a library row predating
  // object storage has no object row and must still be selectable so it can
  // publish from its local file.
  it('carries the object key when the job has one', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1', 'videos/chan-a/job-1.mp4', 10, 'e')",
    ).run()
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z')[0]
        .objectKey,
    ).toBe('videos/chan-a/job-1.mp4')
    db.close()
  })

  it('reports a platform with a done row as blocked, leaving the other open', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z')[0]
        .blockedPlatforms,
    ).toEqual(['youtube'])
    db.close()
  })

  it('reports a claimed row as blocking (in flight)', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z')[0]
        .blockedPlatforms,
    ).toEqual(['instagram'])
    db.close()
  })

  it('reports a platform at the rejection cap as blocked, but not as series-blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      const claim = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: `2026-07-2${i}`,
      })
      markPublishFailed(db, claim!.id, 'bad video', 'rejected', new Date())
    }
    const found = channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z')[0]
    expect(found.blockedPlatforms).toEqual(['youtube'])
    // This video's own attempt history caused the block, not a predecessor
    // part — a standalone (non-series) video is never in seriesBlockedByJob.
    expect(found.seriesBlockedPlatforms).toEqual([])
    db.close()
  })

  it('does not treat a transient failure as blocking — that video retries', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'network', 'transient', new Date())
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z')[0]
        .blockedPlatforms,
    ).toEqual([])
    db.close()
  })

  it('omits a video whose every platform is blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    for (const platform of ['youtube', 'instagram'] as const) {
      const claim = claimPublish(db, {
        jobId: 'job-1',
        platform,
        channel: 'chan-a',
        day: '2026-07-22',
      })
      markPublishDone(db, claim!.id, `${platform}-1`, 'https://example.test/x', new Date())
    }
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z'),
    ).toEqual([])
    db.close()
  })

  // "Every platform" means every platform the CHANNEL declares, not every
  // platform the codebase knows about. A single-platform channel's published
  // video is finished even though a second platform exists in PUBLISH_PLATFORMS.
  it('omits a video published to the only platform the channel declares', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(
      channelVideoCandidates(db, 'chan-a', ['youtube'], 10, '2000-01-01T00:00:00.000Z'),
    ).toEqual([])
    // Still open — and still reported blocked on youtube — for a channel that
    // also declares instagram.
    expect(
      channelVideoCandidates(
        db,
        'chan-a',
        ['youtube', 'instagram'],
        10,
        '2000-01-01T00:00:00.000Z',
      )[0].blockedPlatforms,
    ).toEqual(['youtube'])
    db.close()
  })

  // Regression (final-review Fix 1): the drop test used to compare against the
  // GLOBAL platform count, so on a youtube-only channel an already-published
  // video (blockedPlatforms ['youtube'], 1 < 2) was still returned and still
  // consumed one of the caller's `limit` slots. Because ordering is
  // failedCount ASC first, a genuinely publishable video carrying one
  // 'transient' failure sorts BEHIND every zero-failure row — so once a
  // channel accumulated `limit` published rows (~17 days at 3/day) it was
  // never returned at all, and the tick reported no-ready-video while a
  // publishable video sat in the library.
  it('returns a once-failed video that published rows would otherwise crowd out', () => {
    const db = memDb()
    const limit = 5
    // limit + 1 already-published videos, all newer than the failed one, each
    // done on the channel's only declared platform.
    for (let i = 0; i <= limit; i++) {
      const jobId = `job-done-${i}`
      seedJob(db, jobId, { channel: 'chan-a' })
      seedLibrary(db, jobId, {
        state: 'published',
        createdAt: `2026-07-2${i}T00:00:00.000Z`,
      })
      const claim = claimPublish(db, {
        jobId,
        platform: 'youtube',
        channel: 'chan-a',
        day: `2026-07-2${i}`,
      })
      markPublishDone(db, claim!.id, `yt-${i}`, `https://youtu.be/yt-${i}`, new Date())
    }
    seedJob(db, 'job-hurt', { channel: 'chan-a' })
    seedLibrary(db, 'job-hurt', { state: 'ready', createdAt: '2026-07-10T00:00:00.000Z' })
    const hurt = claimPublish(db, {
      jobId: 'job-hurt',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-19',
    })
    markPublishFailed(db, hurt!.id, 'network', 'transient', new Date())

    expect(
      channelVideoCandidates(db, 'chan-a', ['youtube'], limit, '2000-01-01T00:00:00.000Z').map(
        (r) => r.jobId,
      ),
    ).toEqual(['job-hurt'])
    db.close()
  })

  // A channel declaring no platform has nothing to publish, and `platform IN ()`
  // is not valid SQL — so this is an explicit early return, asserted.
  it('returns nothing when no platforms are declared', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', [], 10, '2000-01-01T00:00:00.000Z')).toEqual([])
    db.close()
  })

  it('orders fewest prior failures first, then newest library row', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedJob(db, 'job-new', { channel: 'chan-a' })
    seedJob(db, 'job-hurt', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedLibrary(db, 'job-new', { state: 'ready', createdAt: '2026-07-22T00:00:00.000Z' })
    seedLibrary(db, 'job-hurt', { state: 'ready', createdAt: '2026-07-23T00:00:00.000Z' })
    const claim = claimPublish(db, {
      jobId: 'job-hurt',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'network', 'transient', new Date())
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z').map(
        (r) => r.jobId,
      ),
    ).toEqual(['job-new', 'job-old', 'job-hurt'])
    db.close()
  })

  it('honours the limit', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedLibrary(db, 'job-2', { state: 'ready' })
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 1, '2000-01-01T00:00:00.000Z'),
    ).toHaveLength(1)
    db.close()
  })

  it('ignores other channels', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-b' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(
      channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10, '2000-01-01T00:00:00.000Z'),
    ).toEqual([])
    db.close()
  })

  it('omits a video older than the createdAfter bound once something outranked it', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedOutranker(db)

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows).toEqual([])
  })

  it('keeps an old video the channel never published past', () => {
    // A publish outage longer than backlog_days: nothing outranked these, so
    // the horizon has not fired. Dropping them here while pendingInventory
    // still counts them is the livelock the contention clause exists to stop —
    // production gated by a backlog no tick would ever be offered.
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedJob(db, 'job-older', { channel: 'chan-a' })
    seedLibrary(db, 'job-older', { state: 'ready', createdAt: '2026-07-19T00:00:00.000Z' })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-old', 'job-older'])
  })

  it('does not accept another channel’s publish as contention', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedJob(db, 'job-b', { channel: 'chan-b' })
    seedPublish(db, 'job-b', {
      channel: 'chan-b',
      status: 'done',
      seq: 1,
      // Inside the window in every respect except the channel, so the channel
      // is the only thing that can be rejecting it.
      createdAt: '2026-07-23T00:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-old'])
  })

  it('does not accept a publish that landed after the horizon as contention', () => {
    // The recovering outage. One publish once credentials are fixed must not
    // age out the whole backlog that was waiting behind it — the SQL twin of
    // isAged's `<= cutoff` upper bound (settled.ts).
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedJob(db, 'job-recovered', { channel: 'chan-a' })
    seedPublish(db, 'job-recovered', {
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-old'])
  })

  it('accepts contention landing exactly at the horizon', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedJob(db, 'job-edge', { channel: 'chan-a' })
    seedPublish(db, 'job-edge', {
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      createdAt: '2026-07-25T00:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows).toEqual([])
  })

  it('does not accept the video’s own publish as contention', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedPublish(db, 'job-old', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      createdAt: '2026-07-23T00:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-old'])
  })

  it('does not accept a later non-done row as contention', () => {
    for (const status of ['failed', 'claimed', 'interrupted'] as const) {
      const db = memDb()
      seedJob(db, 'job-old', { channel: 'chan-a' })
      seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
      seedJob(db, `job-${status}`, { channel: 'chan-a' })
      seedPublish(db, `job-${status}`, {
        channel: 'chan-a',
        status,
        seq: 1,
        createdAt: '2026-07-23T00:00:00.000Z',
      })

      const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

      expect(rows.map((r) => r.jobId)).toEqual(['job-old'])
      db.close()
    }
  })

  it('keeps the channel’s newest video, which nothing published past', () => {
    // Contention is strictly "after this video was produced", so the newest
    // row in a channel survives even when older siblings aged out around it.
    // job-b published at 07-22: inside job-a's window (drops job-a), not
    // inside its own (keeps job-b), and before job-c existed (keeps job-c).
    const db = memDb()
    for (const [id, createdAt] of [
      ['job-a', '2026-07-20T00:00:00.000Z'],
      ['job-b', '2026-07-21T00:00:00.000Z'],
      ['job-c', '2026-07-23T00:00:00.000Z'],
    ] as const) {
      seedJob(db, id, { channel: 'chan-a' })
      seedLibrary(db, id, { state: 'ready', createdAt })
    }
    seedPublish(db, 'job-b', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      seq: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-c', 'job-b'])
  })

  it('keeps a video exactly at the createdAfter bound', () => {
    const db = memDb()
    seedJob(db, 'job-edge', { channel: 'chan-a' })
    seedLibrary(db, 'job-edge', { state: 'ready', createdAt: '2026-07-25T00:00:00.000Z' })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-25T00:00:00.000Z')

    expect(rows.map((r) => r.jobId)).toEqual(['job-edge'])
  })

  it('reports a reclaimed object as having no object key', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready', createdAt: '2026-07-26T00:00:00.000Z' })
    seedLibraryObject(db, 'job-1', {
      objectKey: 'videos/chan-a/job-1.mp4',
      reclaimedAt: '2026-07-26T12:00:00.000Z',
    })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-01T00:00:00.000Z')

    expect(rows[0].objectKey).toBeNull()
  })

  it('still reports an unreclaimed object key', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready', createdAt: '2026-07-26T00:00:00.000Z' })
    seedLibraryObject(db, 'job-1', { objectKey: 'videos/chan-a/job-1.mp4' })

    const rows = channelVideoCandidates(db, 'chan-a', ['youtube'], 50, '2026-07-01T00:00:00.000Z')

    expect(rows[0].objectKey).toBe('videos/chan-a/job-1.mp4')
  })

  // Pins the proof that lets the scan use the age clause alone rather than
  // the full settled predicate: an aged video is closed to every declared
  // platform, so it can never be a candidate — whatever its publish history.
  it('omits every aged video regardless of its publish history', () => {
    const db = memDb()
    const histories: { id: string; seed: () => void }[] = [
      { id: 'job-none', seed: () => {} },
      {
        id: 'job-done',
        seed: () => seedPublish(db, 'job-done', { platform: 'instagram', status: 'done', seq: 1 }),
      },
      {
        id: 'job-pending',
        seed: () =>
          seedPublish(db, 'job-pending', { platform: 'youtube', status: 'interrupted', seq: 2 }),
      },
      {
        id: 'job-failed',
        seed: () =>
          seedPublish(db, 'job-failed', {
            platform: 'youtube',
            status: 'failed',
            errorKind: 'transient',
            seq: 3,
          }),
      },
    ]
    for (const h of histories) {
      seedJob(db, h.id, { channel: 'chan-a' })
      seedLibrary(db, h.id, { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
      h.seed()
    }
    seedOutranker(db)

    const rows = channelVideoCandidates(
      db,
      'chan-a',
      ['youtube', 'instagram'],
      50,
      '2026-07-25T00:00:00.000Z',
    )

    expect(rows).toEqual([])
  })
})

describe('uploadsUsedToday', () => {
  it('counts claimed/done/interrupted and non-auth failed rows, including NULL error_kind, excluding auth failures', () => {
    const db = memDb()
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) seedJob(db, id)
    seedPublish(db, 'job-1', { seq: 1, status: 'claimed' })
    seedPublish(db, 'job-2', { seq: 2, status: 'done' })
    seedPublish(db, 'job-3', { seq: 3, status: 'interrupted' })
    seedPublish(db, 'job-4', { seq: 4, status: 'failed', errorKind: 'quota' })
    seedPublish(db, 'job-5', { seq: 5, status: 'failed', errorKind: null })
    seedPublish(db, 'job-6', { seq: 6, status: 'failed', errorKind: 'auth' })

    expect(uploadsUsedToday(db, 'youtube', '2026-07-20')).toBe(5)
    expect(uploadsUsedToday(db, 'youtube', '2026-07-21')).toBe(0)
    db.close()
  })

  // Design spec decision 7 (quota scope): a scope:'channel' quota (Instagram)
  // must count only its own channel's usage, distinct from the unfiltered
  // scope:'global' count (YouTube) that sums across every channel.
  it('filters to one channel when a channel is given', () => {
    const db = memDb()
    seedJob(db, 'a', { channel: 'chan-a' })
    seedJob(db, 'b', { channel: 'chan-b' })
    seedPublish(db, 'a', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      day: '2026-07-25',
    })
    seedPublish(db, 'b', {
      platform: 'instagram',
      channel: 'chan-b',
      status: 'done',
      day: '2026-07-25',
    })

    expect(uploadsUsedToday(db, 'instagram', '2026-07-25', 'chan-a')).toBe(1)
    expect(uploadsUsedToday(db, 'instagram', '2026-07-25')).toBe(2)
    db.close()
  })
})

describe('quotaBackedOff', () => {
  // Fixed clock (this file has no shared NOW — sweepInterrupted's tests use
  // the same locally-scoped-`now` pattern), so the window math below is exact
  // rather than racing Date.now().
  const NOW = new Date('2026-07-20T12:00:00.000Z')
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

  it('is true for a quota failure inside the window', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'failed',
      errorKind: 'quota',
      createdAt: at(60 * 60 * 1000),
    })

    expect(quotaBackedOff(db, 'instagram', NOW)).toBe(true)
    db.close()
  })

  it('is false once the failure ages past QUOTA_BACKOFF_MS', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'failed',
      errorKind: 'quota',
      createdAt: at(QUOTA_BACKOFF_MS + 1000),
    })

    expect(quotaBackedOff(db, 'instagram', NOW)).toBe(false)
    db.close()
  })

  it('ignores non-quota failure kinds', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'failed',
      errorKind: 'transient',
      createdAt: at(60 * 60 * 1000),
    })

    expect(quotaBackedOff(db, 'instagram', NOW)).toBe(false)
    db.close()
  })

  it('ignores done rows', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    // errorKind 'quota' on a done row is unreachable via production writers —
    // seeded here so this test discriminates against dropping the
    // status = 'failed' clause, not just the error_kind filter.
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      errorKind: 'quota',
      createdAt: at(60 * 60 * 1000),
    })

    expect(quotaBackedOff(db, 'instagram', NOW)).toBe(false)
    db.close()
  })

  it('scopes to the channel when one is given', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'other' })
    seedPublish(db, 'job-1', {
      platform: 'instagram',
      channel: 'other',
      status: 'failed',
      errorKind: 'quota',
      createdAt: at(60 * 60 * 1000),
    })

    expect(quotaBackedOff(db, 'instagram', NOW, 'mine')).toBe(false)
    expect(quotaBackedOff(db, 'instagram', NOW)).toBe(true)
    db.close()
  })
})

describe('listPublishes', () => {
  it('defaults to a 7-day window, newest first, mapped to camelCase', () => {
    const db = memDb()
    seedJob(db, 'job-newer')
    seedJob(db, 'job-older')
    seedJob(db, 'job-out')
    const newerAt = isoAgo(1 * DAY_MS)
    const olderAt = isoAgo(2 * DAY_MS)
    const newerId = seedPublish(db, 'job-newer', {
      status: 'done',
      postId: 'yt-1',
      url: 'https://youtube.com/shorts/yt-1',
      createdAt: newerAt,
    })
    const olderId = seedPublish(db, 'job-older', {
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
      createdAt: olderAt,
    })
    seedPublish(db, 'job-out', {
      seq: 3,
      status: 'failed',
      errorKind: 'transient',
      createdAt: isoAgo(8 * DAY_MS),
    })

    const rows = listPublishes(db)
    expect(rows.map((r) => r.id)).toEqual([newerId, olderId])
    expect(rows[0]).toEqual({
      id: newerId,
      jobId: 'job-newer',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      seq: 1,
      status: 'done',
      postId: 'yt-1',
      url: 'https://youtube.com/shorts/yt-1',
      error: null,
      errorKind: null,
      attempt: 1,
      createdAt: newerAt,
      finishedAt: null,
    })
    db.close()
  })

  it('sinceDays widens or narrows the window', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedPublish(db, 'job-1', { createdAt: isoAgo(8 * DAY_MS) })

    expect(listPublishes(db)).toHaveLength(0)
    expect(listPublishes(db, { sinceDays: 10 })).toHaveLength(1)
    db.close()
  })
})

describe('videosPublishedToday', () => {
  it('is 0 for a channel with no rows', () => {
    const db = memDb()
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(0)
    db.close()
  })

  it('counts a fan-out of one video to two platforms as ONE video', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(1)
    db.close()
  })

  it('counts two distinct videos as two', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    claimPublish(db, { jobId: 'job-2', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(2)
    db.close()
  })

  it('counts a failed attempt — an attempt consumes its place in the day', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'boom', 'transient', new Date())
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(1)
    db.close()
  })

  it('ignores other channels and other days', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-b' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-21' })
    claimPublish(db, { jobId: 'job-2', platform: 'youtube', channel: 'chan-b', day: '2026-07-22' })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(0)
    db.close()
  })
})

describe('lastAttemptAt', () => {
  it('is null for a channel with no rows', () => {
    const db = memDb()
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })

  it('returns the newest created_at across every day, not just today', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('job-1','youtube','chan-a','2026-07-21',1,'done',1,'2026-07-21T20:50:00.000Z')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('job-2','youtube','chan-a','2026-07-22',1,'done',1,'2026-07-22T10:00:00.000Z')",
    ).run()
    expect(lastAttemptAt(db, 'chan-a')?.toISOString()).toBe('2026-07-22T10:00:00.000Z')
    db.close()
  })

  it('ignores other channels', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-b' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-b', day: '2026-07-22' })
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })
})

describe('sweepInterrupted', () => {
  it('flips only claimed rows older than the cutoff, and is idempotent on rerun', () => {
    const db = memDb()
    seedJob(db, 'job-old')
    seedJob(db, 'job-fresh')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const oldId = seedPublish(db, 'job-old', {
      status: 'claimed',
      createdAt: '2026-07-20T11:00:00.000Z',
    })
    const freshId = seedPublish(db, 'job-fresh', {
      seq: 2,
      status: 'claimed',
      createdAt: '2026-07-20T11:55:00.000Z',
    })

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(1)
    const rows = db.prepare('SELECT id, status FROM publishes ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(rows).toEqual([
      { id: oldId, status: 'interrupted' },
      { id: freshId, status: 'claimed' },
    ])

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(0)
    db.close()
  })

  // The cutoff is inclusive (publishes.ts): a row created at exactly
  // now - olderThanMs is stale, one millisecond later is not.
  it('sweeps a row created exactly at the cutoff, not one a millisecond after it', () => {
    const db = memDb()
    seedJob(db, 'job-at-cutoff')
    seedJob(db, 'job-past-cutoff')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const atCutoffId = seedPublish(db, 'job-at-cutoff', {
      status: 'claimed',
      createdAt: '2026-07-20T11:30:00.000Z',
    })
    const pastCutoffId = seedPublish(db, 'job-past-cutoff', {
      seq: 2,
      status: 'claimed',
      createdAt: '2026-07-20T11:30:00.001Z',
    })

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(1)
    expect(db.prepare('SELECT id, status FROM publishes ORDER BY id').all()).toEqual([
      { id: atCutoffId, status: 'interrupted' },
      { id: pastCutoffId, status: 'claimed' },
    ])
    db.close()
  })
})

describe('retryInterrupted', () => {
  it('flips an interrupted row to failed, kind transient, with an appended clearance note', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    const id = seedPublish(db, 'job-1', { status: 'interrupted' })

    expect(retryInterrupted(db, 'job-1')).toBe(true)
    expect(
      db.prepare('SELECT status, error, error_kind FROM publishes WHERE id = ?').get(id),
    ).toEqual({
      status: 'failed',
      error: '; manually cleared',
      error_kind: 'transient',
    })
    db.close()
  })

  it('returns false and touches nothing when the job has no interrupted row', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedPublish(db, 'job-1', { status: 'done' })

    expect(retryInterrupted(db, 'job-1')).toBe(false)
    expect(retryInterrupted(db, 'job-unknown')).toBe(false)
    expect(
      (
        db.prepare('SELECT status FROM publishes WHERE job_id = ?').get('job-1') as {
          status: string
        }
      ).status,
    ).toBe('done')
    db.close()
  })
})

describe('markInterruptedDone', () => {
  it('flips the interrupted publish row to done and the library row to published together', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const id = seedPublish(db, 'job-1', { status: 'interrupted' })

    const ok = markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date('2026-07-20T10:10:00.000Z'),
    )

    expect(ok).toBe(true)
    expect(
      db.prepare('SELECT status, post_id, url, finished_at FROM publishes WHERE id = ?').get(id),
    ).toEqual({
      status: 'done',
      post_id: 'yt-xyz789',
      url: 'https://youtube.com/shorts/yt-xyz789',
      finished_at: '2026-07-20T10:10:00.000Z',
    })
    expect(
      (
        db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }
      ).state,
    ).toBe('published')
    db.close()
  })

  it('runs the two-table flip in one immediate transaction', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPublish(db, 'job-1', { status: 'interrupted' })
    const modes = recordTransactionModes(db)

    markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date(),
    )

    expect(modes).toEqual(['immediate'])
    db.close()
  })

  it('returns false and touches neither table when the job has no interrupted row', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })

    const ok = markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date('2026-07-20T10:10:00.000Z'),
    )

    expect(ok).toBe(false)
    expect(
      (
        db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }
      ).state,
    ).toBe('ready')
    db.close()
  })
})

describe('channelVideoCandidates series ordering', () => {
  // Builds a two-part series: job p1 and job p2, both with ready library rows.
  function seedSeries(db: Database): { p1: string; p2: string } {
    const p1 = 'job-p1'
    const p2 = 'job-p2'
    seedJob(db, p1, { channel: 'aita', topic: 'Story (1/2)' })
    seedJob(db, p2, { channel: 'aita', topic: 'Story (2/2)' })
    seedLibrary(db, p1, { state: 'ready' })
    seedLibrary(db, p2, { state: 'ready' })
    insertTopics(db, [
      {
        channel: 'aita',
        title: 'Story (1/2)',
        rawTitle: 'S',
        source: 'reddit:r/a',
        url: 'u',
        dedupeHash: 'h1',
        score: 88,
        reason: 'r',
        status: 'candidate',
        bodyText: 'a',
        seriesKey: 'S',
        partIndex: 1,
        partCount: 2,
      },
      {
        channel: 'aita',
        title: 'Story (2/2)',
        rawTitle: 'S',
        source: 'reddit:r/a',
        url: 'u',
        dedupeHash: 'h2',
        score: 88,
        reason: 'r',
        status: 'candidate',
        bodyText: 'b',
        seriesKey: 'S',
        partIndex: 2,
        partCount: 2,
      },
    ])
    const rows = redditCandidates(db, 'aita')
    claimTopic(db, rows[0].id, p1)
    claimTopic(db, rows[1].id, p2)
    return { p1, p2 }
  }

  it('blocks part 2 on a platform until part 1 is done there', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    const found = channelVideoCandidates(db, 'aita', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    const part2 = found.find((v) => v.jobId === p2)
    const part1 = found.find((v) => v.jobId === p1)
    expect(part1?.blockedPlatforms).toEqual([])
    expect(part2?.blockedPlatforms).toEqual(['youtube'])
    // Reported separately: this block came from the predecessor gate, not
    // from part 2's own publish history (it has none yet).
    expect(part2?.seriesBlockedPlatforms).toEqual(['youtube'])
  })

  it('unblocks part 2 once part 1 has a done row', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    seedPublish(db, p1, { platform: 'youtube', channel: 'aita', status: 'done' })
    const found = channelVideoCandidates(db, 'aita', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    expect(found.find((v) => v.jobId === p2)?.blockedPlatforms).toEqual([])
    expect(found.find((v) => v.jobId === p2)?.seriesBlockedPlatforms).toEqual([])
  })

  it('gates each platform independently', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    // Part 1 published to youtube only: the series continues there and stalls
    // on instagram.
    seedPublish(db, p1, { platform: 'youtube', channel: 'aita', status: 'done' })
    const found = channelVideoCandidates(
      db,
      'aita',
      ['youtube', 'instagram'],
      50,
      '1970-01-01T00:00:00.000Z',
    )
    expect(found.find((v) => v.jobId === p2)?.blockedPlatforms).toEqual(['instagram'])
  })

  it('keeps part 2 blocked when part 1 only failed', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    seedPublish(db, p1, {
      platform: 'youtube',
      channel: 'aita',
      status: 'failed',
      errorKind: 'rejected',
    })
    const found = channelVideoCandidates(db, 'aita', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    expect(found.find((v) => v.jobId === p2)?.blockedPlatforms).toEqual(['youtube'])
  })

  it('keeps part 2 blocked when part 1 has a claimed (in-flight) row', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    seedPublish(db, p1, {
      platform: 'youtube',
      channel: 'aita',
      status: 'claimed',
    })
    const found = channelVideoCandidates(db, 'aita', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    expect(found.find((v) => v.jobId === p2)?.blockedPlatforms).toEqual(['youtube'])
    db.close()
  })

  it('sorts a continuation part ahead of an unrelated newer video', () => {
    const db = memDb()
    const { p1, p2 } = seedSeries(db)
    seedPublish(db, p1, { platform: 'youtube', channel: 'aita', status: 'done' })
    // An unrelated, NEWER standalone video. created_at DESC alone would put it
    // first; the series tiebreak must not let it interrupt the story.
    seedJob(db, 'job-solo', { channel: 'aita', topic: 'Unrelated' })
    seedLibrary(db, 'job-solo', { state: 'ready', createdAt: '2099-01-01T00:00:00.000Z' })
    const found = channelVideoCandidates(db, 'aita', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    expect(found[0].jobId).toBe(p2)
  })

  it('leaves topic-mode videos unaffected', () => {
    const db = memDb()
    seedJob(db, 'job-plain', { channel: 'space', topic: 'Voyager' })
    seedLibrary(db, 'job-plain', { state: 'ready' })
    const found = channelVideoCandidates(db, 'space', ['youtube'], 50, '1970-01-01T00:00:00.000Z')
    expect(found).toHaveLength(1)
    expect(found[0].blockedPlatforms).toEqual([])
  })
})
