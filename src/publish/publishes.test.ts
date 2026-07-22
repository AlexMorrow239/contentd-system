import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { claimPublish } from './publishes.js'

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
