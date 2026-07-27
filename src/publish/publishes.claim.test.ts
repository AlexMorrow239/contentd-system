import { describe, expect, it, vi } from 'vitest'
import { memDb, seedJob, seedLibrary } from '../testing/db.js'
import { recordTransactionModes } from './_publishes.fixtures.js'
import { claimPublish, listPublishes, markPublishDone, markPublishFailed } from './publishes.js'

/**
 * Claiming a publish slot and closing it out: claimPublish (including seq
 * allocation), markPublishDone, markPublishFailed.
 *
 * Split from a single 1134-line publishes.test.ts that held one describe per
 * exported DAO function with its fixtures scattered between them; the shared
 * ones now live in _publishes.fixtures.ts and src/testing/db.ts.
 */

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
