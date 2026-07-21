import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'

// Raw-insert seed: the DAO only ever writes status/job_id transitions, so
// tests control every column (created_at included) directly.
let seq = 0
function seedTopic(
  db: Database,
  overrides: Partial<{
    channel: string
    title: string
    rawTitle: string
    source: string
    url: string
    dedupeHash: string
    score: number
    reason: string
    status: string
    jobId: string | null
    createdAt: string
  }> = {},
): number {
  seq += 1
  const row = {
    channel: 'chan-a',
    title: `Topic ${seq}`,
    rawTitle: `Raw ${seq}`,
    source: 'reddit:r/space',
    url: `https://example.com/${seq}`,
    dedupeHash: `hash-${seq}`,
    score: 50,
    reason: 'seeded',
    status: 'candidate',
    jobId: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  }
  const res = db
    .prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.channel,
      row.title,
      row.rawTitle,
      row.source,
      row.url,
      row.dedupeHash,
      row.score,
      row.reason,
      row.status,
      row.jobId,
      row.createdAt,
    )
  return Number(res.lastInsertRowid)
}

describe('topics table schema', () => {
  it('creates the table with candidate default and UNIQUE (channel, dedupe_hash)', () => {
    const db = openDb(':memory:')
    db.prepare(
      "INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
    ).run()
    const row = db.prepare('SELECT status, job_id, created_at FROM topics').get() as {
      status: string
      job_id: string | null
      created_at: string
    }
    expect(row.status).toBe('candidate')
    expect(row.job_id).toBeNull()
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // same (channel, dedupe_hash) is ignored; same hash on another channel inserts
    const dup = db
      .prepare(
        "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-a', 'T2', 'R2', 's', 'u', 'h1', 10, 'r')",
      )
      .run()
    expect(dup.changes).toBe(0)
    const other = db
      .prepare(
        "INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason) VALUES ('chan-b', 'T', 'R', 's', 'u', 'h1', 80, 'r')",
      )
      .run()
    expect(other.changes).toBe(1)
    db.close()
  })

  it('rejects a status outside the lifecycle CHECK', () => {
    const db = openDb(':memory:')
    expect(() => seedTopic(db, { status: 'simmering' })).toThrow(/CHECK/)
    db.close()
  })
})
