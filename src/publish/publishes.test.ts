import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import {
  claimPublish,
  consumedSlots,
  markPublishDone,
  markPublishFailed,
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
})
