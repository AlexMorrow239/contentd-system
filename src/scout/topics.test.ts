import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import {
  approveTopics,
  claimTopic,
  eligibleTopic,
  insertTopics,
  knownHashes,
  listTopics,
  markTopicUsedByJob,
  RECENT_TITLES_LIMIT,
  recentTopicTitles,
  rejectTopics,
} from './topics.js'

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

describe('approveTopics / rejectTopics', () => {
  it('approve flips candidates only and reports the changed count', () => {
    const db = openDb(':memory:')
    const a = seedTopic(db) // candidate
    const b = seedTopic(db, { status: 'used' })
    const c = seedTopic(db) // candidate
    // b is not a candidate and 9999 does not exist: both silently skipped
    expect(approveTopics(db, [a, b, c, 9999])).toBe(2)
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: a, status: 'approved' },
      { id: b, status: 'used' },
      { id: c, status: 'approved' },
    ])
    expect(approveTopics(db, [])).toBe(0)
    db.close()
  })

  it('reject flips candidate and approved, leaves claimed/used alone', () => {
    const db = openDb(':memory:')
    const a = seedTopic(db) // candidate
    const b = seedTopic(db, { status: 'approved' })
    const c = seedTopic(db, { status: 'claimed', jobId: 'job-1' })
    const d = seedTopic(db, { status: 'used' })
    expect(rejectTopics(db, [a, b, c, d])).toBe(2)
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: a, status: 'rejected' },
      { id: b, status: 'rejected' },
      { id: c, status: 'claimed' },
      { id: d, status: 'used' },
    ])
    expect(rejectTopics(db, [])).toBe(0)
    db.close()
  })
})

describe('claimTopic / markTopicUsedByJob', () => {
  it('claim binds the topic to its job and reports success', () => {
    const db = openDb(':memory:')
    const id = seedTopic(db, { status: 'approved' })
    expect(claimTopic(db, id, 'job-42')).toBe(true)
    const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
      status: string
      job_id: string | null
    }
    expect(row).toEqual({ status: 'claimed', job_id: 'job-42' })
    db.close()
  })

  it('claim never revives a rejected, used, or already-claimed topic', () => {
    const db = openDb(':memory:')
    for (const status of ['rejected', 'used', 'claimed'] as const) {
      const id = seedTopic(db, { status, jobId: 'job-old' })
      expect(claimTopic(db, id, 'job-new')).toBe(false)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      expect(row).toEqual({ status, job_id: 'job-old' })
    }
    db.close()
  })

  it('markTopicUsedByJob flips only the claimed row with that job id', () => {
    const db = openDb(':memory:')
    const claimed = seedTopic(db, { status: 'claimed', jobId: 'job-42' })
    const other = seedTopic(db, { status: 'claimed', jobId: 'job-7' })
    markTopicUsedByJob(db, 'job-42')
    const statuses = db.prepare('SELECT id, status FROM topics ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(statuses).toEqual([
      { id: claimed, status: 'used' },
      { id: other, status: 'claimed' },
    ])
    // manual `produce` jobs have no claimed topic: silent no-op
    expect(() => markTopicUsedByJob(db, 'job-unknown')).not.toThrow()
    db.close()
  })
})

describe('listTopics', () => {
  it('maps rows to camelCase and returns newest first', () => {
    const db = openDb(':memory:')
    seedTopic(db, { title: 'old', createdAt: '2026-07-19T00:00:00.000Z' })
    const newestId = seedTopic(db, {
      title: 'new',
      rawTitle: 'raw new',
      source: 'rss:example.com',
      url: 'https://example.com/new',
      dedupeHash: 'h-new',
      score: 91,
      reason: 'hooky',
      status: 'claimed',
      jobId: 'job-1',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    const rows = listTopics(db)
    expect(rows.map((r) => r.title)).toEqual(['new', 'old'])
    expect(rows[0]).toEqual({
      id: newestId,
      channel: 'chan-a',
      title: 'new',
      rawTitle: 'raw new',
      source: 'rss:example.com',
      url: 'https://example.com/new',
      dedupeHash: 'h-new',
      score: 91,
      reason: 'hooky',
      status: 'claimed',
      jobId: 'job-1',
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    db.close()
  })

  it('filters by channel and status independently', () => {
    const db = openDb(':memory:')
    seedTopic(db, { channel: 'chan-a', status: 'candidate' })
    seedTopic(db, { channel: 'chan-a', status: 'approved' })
    seedTopic(db, { channel: 'chan-b', status: 'approved' })
    expect(listTopics(db, { channel: 'chan-a' })).toHaveLength(2)
    expect(listTopics(db, { status: 'approved' })).toHaveLength(2)
    expect(listTopics(db, { channel: 'chan-a', status: 'approved' })).toHaveLength(1)
    db.close()
  })
})

describe('eligibleTopic', () => {
  it('volume takes candidate or approved, highest score first', () => {
    const db = openDb(':memory:')
    seedTopic(db, { score: 70, status: 'candidate', title: 'runner-up' })
    seedTopic(db, { score: 90, status: 'approved', title: 'winner' })
    seedTopic(db, { score: 95, status: 'rejected', title: 'rejected' })
    seedTopic(db, { score: 99, status: 'used', title: 'used' })
    seedTopic(db, { score: 99, status: 'claimed', title: 'claimed', jobId: 'job-1' })
    const pick = eligibleTopic(db, 'chan-a', 'volume', { autoPremium: false })
    expect(pick?.title).toBe('winner')
    db.close()
  })

  it('premium requires approved unless autoPremium lifts the gate', () => {
    const db = openDb(':memory:')
    seedTopic(db, { score: 95, status: 'candidate', title: 'unapproved' })
    seedTopic(db, { score: 60, status: 'approved', title: 'approved' })
    expect(eligibleTopic(db, 'chan-a', 'premium', { autoPremium: false })?.title).toBe('approved')
    expect(eligibleTopic(db, 'chan-a', 'premium', { autoPremium: true })?.title).toBe('unapproved')
    db.close()
  })

  it('breaks score ties oldest first and returns null on an empty queue', () => {
    const db = openDb(':memory:')
    seedTopic(db, { score: 80, createdAt: '2026-07-20T02:00:00.000Z', title: 'later' })
    seedTopic(db, { score: 80, createdAt: '2026-07-20T01:00:00.000Z', title: 'earlier' })
    expect(eligibleTopic(db, 'chan-a', 'volume', { autoPremium: false })?.title).toBe('earlier')
    expect(eligibleTopic(db, 'chan-b', 'volume', { autoPremium: false })).toBeNull()
    db.close()
  })
})
