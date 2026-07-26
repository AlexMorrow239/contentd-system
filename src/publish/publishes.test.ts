import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import {
  claimPublish,
  consumedSlots,
  eligibleVideo,
  listPublishes,
  markInterruptedDone,
  markPublishDone,
  markPublishFailed,
  MAX_PUBLISH_ATTEMPTS,
  retryInterrupted,
  sweepInterrupted,
  uploadsUsedToday,
} from './publishes.js'

// Raw-insert seed: publishes.job_id references jobs(id) (FKs are OFF, but
// every fixture stays realistic — eligibleVideo's JOIN through jobs needs a
// real row). One helper covers every test below; overrides keep each test
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
  it('numbers attempts 1-based per (jobId, platform), counting every prior row regardless of slot or day', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')

    const id1 = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    })
    expect(id1).not.toBeNull()
    expect(
      (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id1) as { attempt: number })
        .attempt,
    ).toBe(1)
    db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(id1)

    const id2 = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '14:00',
    })
    expect(
      (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id2) as { attempt: number })
        .attempt,
    ).toBe(2)
    db.prepare("UPDATE publishes SET status = 'failed' WHERE id = ?").run(id2)

    const id3 = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-21',
      slot: '10:00',
    })
    expect(
      (db.prepare('SELECT attempt FROM publishes WHERE id = ?').get(id3) as { attempt: number })
        .attempt,
    ).toBe(3)
    db.close()
  })

  it('returns null on a UNIQUE (channel, platform, day, slot) conflict and writes nothing', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedJob(db, 'job-2')

    const first = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    })
    expect(first).not.toBeNull()

    const conflict = claimPublish(db, {
      jobId: 'job-2',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    })
    expect(conflict).toBeNull()

    const rows = db.prepare('SELECT job_id FROM publishes').all() as { job_id: string }[]
    expect(rows).toEqual([{ job_id: 'job-1' }])
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
      slot: '10:00',
    })

    expect(modes).toEqual(['immediate'])
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
    const id = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    }) as number

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
    const id = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    }) as number
    const modes = recordTransactionModes(db)

    markPublishDone(db, id, 'yt-abc123', 'https://youtube.com/shorts/yt-abc123', new Date())

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
    const id = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      slot: '10:00',
    }) as number

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
    slot: string
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
    slot: '10:00',
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
      'INSERT INTO publishes (job_id, platform, channel, day, slot, status, post_id, url, error, error_kind, attempt, created_at, finished_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.jobId,
      row.platform,
      row.channel,
      row.day,
      row.slot,
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
      slot: '14:00',
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
      slot: '14:00',
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

describe('consumedSlots', () => {
  it('returns slot strings with any-status row for the given (channel, platform, day)', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedJob(db, 'job-2')
    seedJob(db, 'job-3')
    seedPublish(db, { jobId: 'job-1', slot: '10:00', status: 'done' })
    seedPublish(db, { jobId: 'job-2', slot: '14:00', status: 'failed', errorKind: 'transient' })
    seedPublish(db, { jobId: 'job-3', slot: '19:00', channel: 'chan-b' })
    seedPublish(db, { jobId: 'job-3', slot: '08:00', day: '2026-07-19' })

    expect(consumedSlots(db, 'chan-a', 'youtube', '2026-07-20')).toEqual(
      new Set(['10:00', '14:00']),
    )
    expect(consumedSlots(db, 'chan-a', 'youtube', '2026-07-21')).toEqual(new Set())
    db.close()
  })
})

describe('uploadsUsedToday', () => {
  it('counts claimed/done/interrupted and non-auth failed rows, including NULL error_kind, excluding auth failures', () => {
    const db = openDb(':memory:')
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) seedJob(db, id)
    seedPublish(db, { jobId: 'job-1', slot: '08:00', status: 'claimed' })
    seedPublish(db, { jobId: 'job-2', slot: '09:00', status: 'done' })
    seedPublish(db, { jobId: 'job-3', slot: '10:00', status: 'interrupted' })
    seedPublish(db, { jobId: 'job-4', slot: '11:00', status: 'failed', errorKind: 'quota' })
    seedPublish(db, { jobId: 'job-5', slot: '12:00', status: 'failed', errorKind: null })
    seedPublish(db, { jobId: 'job-6', slot: '13:00', status: 'failed', errorKind: 'auth' })

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

describe('eligibleVideo', () => {
  it('only considers ready library rows on the given channel, excluding needs-review and blocked', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-ready', { topic: 'ready topic' })
    seedJob(db, 'job-review')
    seedJob(db, 'job-blocked')
    seedJob(db, 'job-other-chan', { channel: 'chan-b' })
    seedLibrary(db, 'job-ready', { state: 'ready' })
    seedLibrary(db, 'job-review', { state: 'needs-review' })
    seedLibrary(db, 'job-blocked', { state: 'blocked' })
    seedLibrary(db, 'job-other-chan', { state: 'ready' })

    expect(eligibleVideo(db, 'chan-a', 'youtube')).toEqual({
      jobId: 'job-ready',
      videoPath: '/tmp/out.mp4',
      objectKey: null,
      metadataJson: '{}',
      topic: 'ready topic',
    })
    expect(eligibleVideo(db, 'chan-c', 'youtube')).toBeNull()
    db.close()
  })

  // library_objects is LEFT-joined, never inner-joined: a library row
  // predating object storage has no object row and must still be selectable
  // so it can publish to YouTube from its local file.
  it('returns the object key when the job has one', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1', 'videos/chan-a/job-1.mp4', 10, 'e')",
    ).run()

    expect(eligibleVideo(db, 'chan-a', 'youtube')?.objectKey).toBe('videos/chan-a/job-1.mp4')
    db.close()
  })

  it('returns a null object key for a library row predating library_objects', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })

    expect(eligibleVideo(db, 'chan-a', 'youtube')?.objectKey).toBeNull()
    db.close()
  })

  // Design spec decision 1 (cross-post semantics): a video already
  // 'published' via one platform must stay in the eligibility pool for
  // every other platform, since platforms never compete for videos.
  it('includes a published-state row when the platform has no blocking row of its own', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan' })
    seedLibrary(db, 'job-1', { state: 'published' })

    const row = eligibleVideo(db, 'chan', 'instagram')

    expect(row?.jobId).toBe('job-1')
    db.close()
  })

  it('excludes a published-state row once THIS platform also has a done row', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-1', { channel: 'chan' })
    seedLibrary(db, 'job-1', { state: 'published' })
    seedPublish(db, { jobId: 'job-1', platform: 'instagram', channel: 'chan', status: 'done' })

    expect(eligibleVideo(db, 'chan', 'instagram')).toBeNull()
    db.close()
  })

  it('excludes jobs with a done, claimed, or interrupted row for the platform', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-done')
    seedJob(db, 'job-claimed')
    seedJob(db, 'job-interrupted')
    seedLibrary(db, 'job-done', { state: 'ready' })
    seedLibrary(db, 'job-claimed', { state: 'ready' })
    seedLibrary(db, 'job-interrupted', { state: 'ready' })
    seedPublish(db, { jobId: 'job-done', slot: '08:00', status: 'done' })
    seedPublish(db, { jobId: 'job-claimed', slot: '09:00', status: 'claimed' })
    seedPublish(db, { jobId: 'job-interrupted', slot: '10:00', status: 'interrupted' })

    expect(eligibleVideo(db, 'chan-a', 'youtube')).toBeNull()
    db.close()
  })

  it('excludes a job at MAX_PUBLISH_ATTEMPTS rejected failures but includes one still under the cap', () => {
    const db = openDb(':memory:')
    expect(MAX_PUBLISH_ATTEMPTS).toBe(3)
    seedJob(db, 'job-capped', { topic: 'capped' })
    seedJob(db, 'job-under-cap', { topic: 'under cap' })
    seedLibrary(db, 'job-capped', { state: 'ready' })
    seedLibrary(db, 'job-under-cap', { state: 'ready' })
    seedPublish(db, { jobId: 'job-capped', slot: '08:00', status: 'failed', errorKind: 'rejected' })
    seedPublish(db, { jobId: 'job-capped', slot: '09:00', status: 'failed', errorKind: 'rejected' })
    seedPublish(db, { jobId: 'job-capped', slot: '10:00', status: 'failed', errorKind: 'rejected' })
    // Different day than job-capped's rows: publishes.day plays no part in
    // eligibleVideo's per-job_id aggregate, but reusing job-capped's
    // (channel, platform, day, slot) here would collide with the schema's
    // UNIQUE constraint since both jobs share the default channel/day.
    seedPublish(db, {
      jobId: 'job-under-cap',
      day: '2026-07-21',
      slot: '08:00',
      status: 'failed',
      errorKind: 'rejected',
    })
    seedPublish(db, {
      jobId: 'job-under-cap',
      day: '2026-07-21',
      slot: '09:00',
      status: 'failed',
      errorKind: 'rejected',
    })

    expect(eligibleVideo(db, 'chan-a', 'youtube')?.jobId).toBe('job-under-cap')
    db.close()
  })

  it('orders by fewest failed rows of any kind, then newest library row, then job id', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-a')
    seedJob(db, 'job-b')
    seedJob(db, 'job-c')
    seedJob(db, 'job-d')
    // job-a: one non-rejected failure — doesn't count toward the cap, but
    // still outranked by the zero-failure jobs on the primary sort key.
    seedLibrary(db, 'job-a', { state: 'ready', createdAt: '2026-07-19T00:00:00.000Z' })
    seedPublish(db, { jobId: 'job-a', slot: '08:00', status: 'failed', errorKind: 'transient' })
    // job-b, job-c, job-d: zero failures — tie broken by created_at DESC,
    // then job_id ASC.
    seedLibrary(db, 'job-b', { state: 'ready', createdAt: '2026-07-18T00:00:00.000Z' })
    seedLibrary(db, 'job-c', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedLibrary(db, 'job-d', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })

    expect(eligibleVideo(db, 'chan-a', 'youtube')?.jobId).toBe('job-c')
    db.close()
  })

  // The exclusion list is how the publish tick walks past ready rows whose
  // video file was pruned: without it the single returned row shadows every
  // older healthy row on the channel.
  it('skips excluded job ids and returns the next one in order', () => {
    const db = openDb(':memory:')
    seedJob(db, 'job-new')
    seedJob(db, 'job-mid')
    seedJob(db, 'job-old')
    seedLibrary(db, 'job-new', { createdAt: '2026-07-20T00:00:00.000Z' })
    seedLibrary(db, 'job-mid', { createdAt: '2026-07-19T00:00:00.000Z' })
    seedLibrary(db, 'job-old', { createdAt: '2026-07-18T00:00:00.000Z' })

    expect(eligibleVideo(db, 'chan-a', 'youtube', [])?.jobId).toBe('job-new')
    expect(eligibleVideo(db, 'chan-a', 'youtube', ['job-new'])?.jobId).toBe('job-mid')
    expect(eligibleVideo(db, 'chan-a', 'youtube', ['job-new', 'job-mid'])?.jobId).toBe('job-old')
    expect(eligibleVideo(db, 'chan-a', 'youtube', ['job-new', 'job-mid', 'job-old'])).toBeNull()
    db.close()
  })

  // The exclusion list reaches SQL as placeholders, never as interpolated
  // text: a job id carrying quotes matches literally and closes nothing.
  it('binds excluded job ids as parameters rather than interpolating them', () => {
    const db = openDb(':memory:')
    const nasty = `job-'); DROP TABLE library; --`
    seedJob(db, nasty)
    seedJob(db, 'job-plain')
    seedLibrary(db, nasty, { createdAt: '2026-07-20T00:00:00.000Z' })
    seedLibrary(db, 'job-plain', { createdAt: '2026-07-19T00:00:00.000Z' })

    expect(eligibleVideo(db, 'chan-a', 'youtube')?.jobId).toBe(nasty)
    expect(eligibleVideo(db, 'chan-a', 'youtube', [nasty])?.jobId).toBe('job-plain')
    expect(db.prepare('SELECT COUNT(*) AS n FROM library').get()).toEqual({ n: 2 })
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
      slot: '11:00',
      status: 'failed',
      errorKind: 'rejected',
      createdAt: olderAt,
    })
    seedPublish(db, {
      jobId: 'job-out',
      slot: '12:00',
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
      slot: '10:00',
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
