import type { Database } from 'better-sqlite3'
import type { Tier } from '../jobs/types.js'

export type TopicStatus = 'candidate' | 'approved' | 'claimed' | 'used' | 'rejected'

export interface TopicRow {
  id: number
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  dedupeHash: string
  score: number
  reason: string
  status: TopicStatus
  jobId: string | null
  createdAt: string
}

// Scorer output lands as 'candidate' (score >= min_score) or 'rejected';
// the operator lifecycle states are reached only via the transition fns below.
export interface NewTopic {
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  dedupeHash: string
  score: number
  reason: string
  status: 'candidate' | 'rejected'
}

// INSERT OR IGNORE on UNIQUE (channel, dedupe_hash): re-inserting a known item
// is a no-op, so the returned count is rows actually written. One transaction —
// a mid-run crash loses the whole batch, never half of it.
export function insertTopics(db: Database, rows: NewTopic[]): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertAll = db.transaction((batch: NewTopic[]) => {
    let inserted = 0
    for (const t of batch) {
      inserted += stmt.run(
        t.channel,
        t.title,
        t.rawTitle,
        t.source,
        t.url,
        t.dedupeHash,
        t.score,
        t.reason,
        t.status,
      ).changes
    }
    return inserted
  })
  return insertAll(rows)
}
