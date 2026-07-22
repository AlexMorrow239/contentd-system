import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { claimPublish, markPublishDone, markPublishFailed } from './publishes.js'

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
