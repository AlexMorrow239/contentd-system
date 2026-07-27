import { describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import {
  channelVideoCandidates,
  claimPublish,
  lastAttemptAt,
  listPublishes,
  markInterruptedDone,
  markPublishDone,
  markPublishFailed,
  MAX_PUBLISH_ATTEMPTS,
  retryInterrupted,
  sweepInterrupted,
  uploadsUsedToday,
  videosPublishedToday,
} from './publishes.js'
import { PUBLISH_PLATFORMS } from './types.js'

// Raw-insert seed: publishes.job_id references jobs(id) (FKs are OFF, but
// every fixture stays realistic — channelVideoCandidates' JOIN through jobs
// needs a real row). One helper covers every test below; overrides keep each test
// declaring only what it cares about.
function seedJob(
  db: Database,
  id: string,
  overrides: Partial<{ channel: string; tier: string; topic: string; status: string }> = {},
): void {
  db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
    id,
    overrides.channel ?? 'chan-a',
    overrides.tier ?? 'volume',
    overrides.topic ?? 'seeded topic',
    overrides.status ?? 'done',
  )
}

// Transaction mode leaves no trace in the resulting rows, so it is asserted
// white-box: wrap db.transaction and record which runner the DAO invokes.
// The plain call is a deferred BEGIN, whose read snapshot a concurrent
// writer can invalidate — SQLITE_BUSY_SNAPSHOT is the one busy error
// busy_timeout cannot retry, which is why these writes run `.immediate()`.
function recordTransactionModes(db: Database): string[] {
  const modes: string[] = []
  const original = db.transaction.bind(db)
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const txn = original(fn as never) as unknown as {
      (...args: unknown[]): unknown
      immediate(...args: unknown[]): unknown
    }
    const wrapped = ((...args: unknown[]) => {
      modes.push('deferred')
      return txn(...args)
    }) as unknown as typeof txn
    wrapped.immediate = (...args: unknown[]) => {
      modes.push('immediate')
      return txn.immediate(...args)
    }
    return wrapped
  }) as unknown as Database['transaction']
  return modes
}

describe('claimPublish', () => {
  it('numbers attempts 1-based per (jobId, platform), counting every prior row regardless of day', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    // lands on 4, the first genuinely free ordinal.
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) VALUES ' +
        "('job-1','youtube','chan-a','2026-07-22',1,'failed',1)," +
        "('job-1','youtube','chan-a','2026-07-22',3,'done',2)",
    ).run()
    const claim = claimPublish(db, {
      jobId: 'job-1',
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
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) VALUES ' +
        "('job-1','youtube','chan-a','2026-07-22',1,'done',1)",
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

  it('still counts attempts per (job, platform), independent of seq', () => {
    const db = openDb(':memory:')
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

// Same insert shape the runner's final-gate library upsert writes
// (src/jobs/runner.ts).
function seedLibrary(
  db: Database,
  jobId: string,
  overrides: Partial<{
    videoPath: string
    metadataJson: string
    state: string
    createdAt: string
  }> = {},
): void {
  db.prepare(
    'INSERT INTO library (job_id, video_path, metadata_json, state, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    jobId,
    overrides.videoPath ?? '/tmp/out.mp4',
    overrides.metadataJson ?? '{}',
    overrides.state ?? 'ready',
    overrides.createdAt ?? new Date().toISOString(),
  )
}

describe('markPublishDone', () => {
  it('flips the publish row to done and the library row to published in one transaction', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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

function seedPublish(
  db: Database,
  overrides: Partial<{
    jobId: string
    platform: string
    channel: string
    day: string
    seq: number
    status: string
    postId: string | null
    url: string | null
    error: string | null
    errorKind: string | null
    attempt: number
    createdAt: string
    finishedAt: string | null
  }> = {},
): number {
  const row = {
    jobId: 'job-1',
    platform: 'youtube',
    channel: 'chan-a',
    day: '2026-07-20',
    seq: 1,
    status: 'claimed',
    postId: null,
    url: null,
    error: null,
    errorKind: null,
    attempt: 1,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  }
  const res = db
    .prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, post_id, url, error, error_kind, attempt, created_at, finished_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.jobId,
      row.platform,
      row.channel,
      row.day,
      row.seq,
      row.status,
      row.postId,
      row.url,
      row.error,
      row.errorKind,
      row.attempt,
      row.createdAt,
      row.finishedAt,
    )
  return Number(res.lastInsertRowid)
}

describe('sweepInterrupted', () => {
  it('flips only claimed rows older than the cutoff, and is idempotent on rerun', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-old')
    seedJob(db, 'job-fresh')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const oldId = seedPublish(db, {
      jobId: 'job-old',
      status: 'claimed',
      createdAt: '2026-07-20T11:00:00.000Z',
    })
    const freshId = seedPublish(db, {
      jobId: 'job-fresh',
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
    const db = openDb(':memory:')
    seedJob(db, 'job-at-cutoff')
    seedJob(db, 'job-past-cutoff')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const atCutoffId = seedPublish(db, {
      jobId: 'job-at-cutoff',
      status: 'claimed',
      createdAt: '2026-07-20T11:30:00.000Z',
    })
    const pastCutoffId = seedPublish(db, {
      jobId: 'job-past-cutoff',
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

describe('uploadsUsedToday', () => {
  it('counts claimed/done/interrupted and non-auth failed rows, including NULL error_kind, excluding auth failures', () => {
    const db = openDb(':memory:')
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) seedJob(db, id)
    seedPublish(db, { jobId: 'job-1', seq: 1, status: 'claimed' })
    seedPublish(db, { jobId: 'job-2', seq: 2, status: 'done' })
    seedPublish(db, { jobId: 'job-3', seq: 3, status: 'interrupted' })
    seedPublish(db, { jobId: 'job-4', seq: 4, status: 'failed', errorKind: 'quota' })
    seedPublish(db, { jobId: 'job-5', seq: 5, status: 'failed', errorKind: null })
    seedPublish(db, { jobId: 'job-6', seq: 6, status: 'failed', errorKind: 'auth' })

    expect(uploadsUsedToday(db, 'youtube', '2026-07-20')).toBe(5)
    expect(uploadsUsedToday(db, 'youtube', '2026-07-21')).toBe(0)
    db.close()
  })

  // Design spec decision 7 (quota scope): a scope:'channel' quota (Instagram)
  // must count only its own channel's usage, distinct from the unfiltered
  // scope:'global' count (YouTube) that sums across every channel.
  it('filters to one channel when a channel is given', () => {
    const db = openDb(':memory:')
    seedJob(db, 'a', { channel: 'chan-a' })
    seedJob(db, 'b', { channel: 'chan-b' })
    seedPublish(db, {
      jobId: 'a',
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      day: '2026-07-25',
    })
    seedPublish(db, {
      jobId: 'b',
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

describe('channelVideoCandidates', () => {
  it('returns nothing for a channel with no publishable library rows', () => {
    const db = openDb(':memory:')
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })

  it('returns a ready video with no platforms blocked', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a', topic: 'ready topic' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([
      {
        jobId: 'job-1',
        videoPath: '/tmp/out.mp4',
        objectKey: null,
        metadataJson: '{}',
        topic: 'ready topic',
        blockedPlatforms: [],
      },
    ])
    db.close()
  })

  it('excludes library rows that are not publishable', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-ready', { channel: 'chan-a' })
    seedJob(db, 'job-review', { channel: 'chan-a' })
    seedJob(db, 'job-blocked', { channel: 'chan-a' })
    seedLibrary(db, 'job-ready', { state: 'ready' })
    seedLibrary(db, 'job-review', { state: 'needs-review' })
    seedLibrary(db, 'job-blocked', { state: 'blocked' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10).map((r) => r.jobId)).toEqual(
      ['job-ready'],
    )
    db.close()
  })

  // library_objects is LEFT-joined, never inner-joined: a library row predating
  // object storage has no object row and must still be selectable so it can
  // publish from its local file.
  it('carries the object key when the job has one', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1', 'videos/chan-a/job-1.mp4', 10, 'e')",
    ).run()
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].objectKey).toBe(
      'videos/chan-a/job-1.mp4',
    )
    db.close()
  })

  it('reports a platform with a done row as blocked, leaving the other open', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['youtube'],
    )
    db.close()
  })

  it('reports a claimed row as blocking (in flight)', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['instagram'],
    )
    db.close()
  })

  it('reports a platform at the rejection cap as blocked', () => {
    const db = openDb(':memory:')
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
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['youtube'],
    )
    db.close()
  })

  it('does not treat a transient failure as blocking — that video retries', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'network', 'transient', new Date())
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      [],
    )
    db.close()
  })

  it('omits a video whose every platform is blocked', () => {
    const db = openDb(':memory:')
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
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })

  // "Every platform" means every platform the CHANNEL declares, not every
  // platform the codebase knows about. A single-platform channel's published
  // video is finished even though a second platform exists in PUBLISH_PLATFORMS.
  it('omits a video published to the only platform the channel declares', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(channelVideoCandidates(db, 'chan-a', ['youtube'], 10)).toEqual([])
    // Still open — and still reported blocked on youtube — for a channel that
    // also declares instagram.
    expect(
      channelVideoCandidates(db, 'chan-a', ['youtube', 'instagram'], 10)[0].blockedPlatforms,
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
    const db = openDb(':memory:')
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

    expect(channelVideoCandidates(db, 'chan-a', ['youtube'], limit).map((r) => r.jobId)).toEqual([
      'job-hurt',
    ])
    db.close()
  })

  // A channel declaring no platform has nothing to publish, and `platform IN ()`
  // is not valid SQL — so this is an explicit early return, asserted.
  it('returns nothing when no platforms are declared', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', [], 10)).toEqual([])
    db.close()
  })

  it('orders fewest prior failures first, then newest library row', () => {
    const db = openDb(':memory:')
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
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10).map((r) => r.jobId)).toEqual(
      ['job-new', 'job-old', 'job-hurt'],
    )
    db.close()
  })

  it('honours the limit', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedLibrary(db, 'job-2', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 1)).toHaveLength(1)
    db.close()
  })

  it('ignores other channels', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-b' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })
})

describe('retryInterrupted', () => {
  it('flips an interrupted row to failed, kind transient, with an appended clearance note', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    const id = seedPublish(db, { jobId: 'job-1', status: 'interrupted' })

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
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedPublish(db, { jobId: 'job-1', status: 'done' })

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
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const id = seedPublish(db, { jobId: 'job-1', status: 'interrupted' })

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
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPublish(db, { jobId: 'job-1', status: 'interrupted' })
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
    const db = openDb(':memory:')
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

const DAY_MS = 24 * 60 * 60 * 1000

// Explicit timestamps offset from the real clock keep the
// datetime('now', ...) window comparison inside listPublishes meaningful.
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

describe('listPublishes', () => {
  it('defaults to a 7-day window, newest first, mapped to camelCase', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-newer')
    seedJob(db, 'job-older')
    seedJob(db, 'job-out')
    const newerAt = isoAgo(1 * DAY_MS)
    const olderAt = isoAgo(2 * DAY_MS)
    const newerId = seedPublish(db, {
      jobId: 'job-newer',
      status: 'done',
      postId: 'yt-1',
      url: 'https://youtube.com/shorts/yt-1',
      createdAt: newerAt,
    })
    const olderId = seedPublish(db, {
      jobId: 'job-older',
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
      createdAt: olderAt,
    })
    seedPublish(db, {
      jobId: 'job-out',
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
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedPublish(db, { jobId: 'job-1', createdAt: isoAgo(8 * DAY_MS) })

    expect(listPublishes(db)).toHaveLength(0)
    expect(listPublishes(db, { sinceDays: 10 })).toHaveLength(1)
    db.close()
  })
})

describe('videosPublishedToday', () => {
  it('is 0 for a channel with no rows', () => {
    const db = openDb(':memory:')
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(0)
    db.close()
  })

  it('counts a fan-out of one video to two platforms as ONE video', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    claimPublish(db, { jobId: 'job-2', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(2)
    db.close()
  })

  it('counts a failed attempt — an attempt consumes its place in the day', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })

  it('returns the newest created_at across every day, not just today', () => {
    const db = openDb(':memory:')
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
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan-b' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-b', day: '2026-07-22' })
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })
})
