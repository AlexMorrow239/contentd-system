import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { insertTopics, knownHashes, RECENT_TITLES_LIMIT, recentTopicTitles } from './topics.js'

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

describe('insertTopics', () => {
  it('inserts a batch and reports only rows actually written', () => {
    const db = openDb(':memory:')
    const base = {
      title: 'Why the Moon is drifting away',
      rawTitle: 'Moon drifting 3.8cm/yr',
      source: 'reddit:r/space',
      url: 'https://www.reddit.com/r/space/1',
      score: 82,
      reason: 'high novelty',
    }
    const first = insertTopics(db, [
      { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
      { ...base, channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' },
    ])
    expect(first).toBe(2)
    // re-run overlap: h1 already known, h3 is new
    const second = insertTopics(db, [
      { ...base, channel: 'chan-a', dedupeHash: 'h1', status: 'candidate' },
      { ...base, channel: 'chan-a', dedupeHash: 'h3', status: 'candidate' },
    ])
    expect(second).toBe(1)
    const rows = db
      .prepare('SELECT dedupe_hash, status FROM topics ORDER BY id')
      .all() as { dedupe_hash: string; status: string }[]
    expect(rows).toEqual([
      { dedupe_hash: 'h1', status: 'candidate' },
      { dedupe_hash: 'h2', status: 'rejected' },
      { dedupe_hash: 'h3', status: 'candidate' },
    ])
    db.close()
  })

  it('returns 0 for an empty batch', () => {
    const db = openDb(':memory:')
    expect(insertTopics(db, [])).toBe(0)
    db.close()
  })
})

describe('knownHashes', () => {
  it('returns only hashes already stored for that channel', () => {
    const db = openDb(':memory:')
    seedTopic(db, { channel: 'chan-a', dedupeHash: 'h1' })
    // rejected rows are still "known" — they must never reach the scorer again
    seedTopic(db, { channel: 'chan-a', dedupeHash: 'h2', status: 'rejected' })
    seedTopic(db, { channel: 'chan-b', dedupeHash: 'h3' })
    expect(knownHashes(db, 'chan-a', ['h1', 'h2', 'h3', 'h9'])).toEqual(new Set(['h1', 'h2']))
    expect(knownHashes(db, 'chan-a', [])).toEqual(new Set())
    db.close()
  })
})

describe('recentTopicTitles', () => {
  it('returns non-rejected titles newest first, capped at the limit', () => {
    const db = openDb(':memory:')
    seedTopic(db, { title: 'oldest', createdAt: '2026-07-18T00:00:00.000Z' })
    seedTopic(db, { title: 'skipped', createdAt: '2026-07-19T00:00:00.000Z', status: 'rejected' })
    seedTopic(db, { title: 'middle', createdAt: '2026-07-19T12:00:00.000Z', status: 'used' })
    seedTopic(db, { title: 'newest', createdAt: '2026-07-20T00:00:00.000Z', status: 'approved' })
    seedTopic(db, { title: 'other channel', channel: 'chan-b', createdAt: '2026-07-20T06:00:00.000Z' })
    expect(recentTopicTitles(db, 'chan-a')).toEqual(['newest', 'middle', 'oldest'])
    expect(recentTopicTitles(db, 'chan-a', 2)).toEqual(['newest', 'middle'])
    db.close()
  })

  it('defaults the limit to RECENT_TITLES_LIMIT (30)', () => {
    const db = openDb(':memory:')
    expect(RECENT_TITLES_LIMIT).toBe(30)
    for (let i = 0; i < 35; i++) {
      seedTopic(db, { createdAt: `2026-07-19T00:00:${String(i).padStart(2, '0')}.000Z` })
    }
    expect(recentTopicTitles(db, 'chan-a')).toHaveLength(30)
    db.close()
  })
})
