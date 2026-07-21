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

const TOPIC_COLUMNS =
  'id, channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id, created_at'

interface DbTopicRow {
  id: number
  channel: string
  title: string
  raw_title: string
  source: string
  url: string
  dedupe_hash: string
  score: number
  reason: string
  status: TopicStatus
  job_id: string | null
  created_at: string
}

function toTopicRow(row: DbTopicRow): TopicRow {
  return {
    id: row.id,
    channel: row.channel,
    title: row.title,
    rawTitle: row.raw_title,
    source: row.source,
    url: row.url,
    dedupeHash: row.dedupe_hash,
    score: row.score,
    reason: row.reason,
    status: row.status,
    jobId: row.job_id,
    createdAt: row.created_at,
  }
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

// Pre-Haiku hash filter: any status counts as known (a rejected item must
// never be re-scored). IN-list size is bounded by the scout's per-source
// candidate caps, far under SQLite's bound-variable limit.
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set()
  const placeholders = hashes.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT dedupe_hash FROM topics WHERE channel = ? AND dedupe_hash IN (${placeholders})`,
    )
    .all(channel, ...hashes) as { dedupe_hash: string }[]
  return new Set(rows.map((r) => r.dedupe_hash))
}

// Scorer prompt context: how many recent titles feed the "recently covered —
// score near-duplicates 0" instruction (design spec §5).
export const RECENT_TITLES_LIMIT = 30

// Rejected topics are noise (near-duplicates, off-niche); the scorer only
// needs what the channel actually covered or queued.
export function recentTopicTitles(
  db: Database,
  channel: string,
  limit = RECENT_TITLES_LIMIT,
): string[] {
  const rows = db
    .prepare(
      "SELECT title FROM topics WHERE channel = ? AND status != 'rejected' " +
        'ORDER BY created_at DESC, id DESC LIMIT ?',
    )
    .all(channel, limit) as { title: string }[]
  return rows.map((r) => r.title)
}

// Operator gate transitions. The status guard in the WHERE clause makes both
// idempotent and blind to ids in the wrong state — the returned count is what
// actually changed, which the CLI reports against ids.length.
export function approveTopics(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE topics SET status = 'approved' WHERE id IN (${placeholders}) AND status = 'candidate'`,
    )
    .run(...ids).changes
}

export function rejectTopics(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE topics SET status = 'rejected' WHERE id IN (${placeholders}) AND status IN ('candidate','approved')`,
    )
    .run(...ids).changes
}

// Claim = bind topic to job. Guarded so a rejected/used/claimed topic is
// never revived even if a caller slips outside the produce lease; the boolean
// lets produce-next treat a failed claim as the invariant breach it is.
export function claimTopic(db: Database, topicId: number, jobId: string): boolean {
  const info = db
    .prepare(
      "UPDATE topics SET status = 'claimed', job_id = ? WHERE id = ? AND status IN ('candidate','approved')",
    )
    .run(jobId, topicId)
  return info.changes === 1
}

// Called when a job lands in the library; a job with no claimed topic
// (manual `produce`) is a silent no-op.
export function markTopicUsedByJob(db: Database, jobId: string): void {
  db.prepare("UPDATE topics SET status = 'used' WHERE job_id = ? AND status = 'claimed'").run(jobId)
}

export function listTopics(
  db: Database,
  filter?: { channel?: string; status?: TopicStatus },
): TopicRow[] {
  const where: string[] = []
  const params: string[] = []
  if (filter?.channel !== undefined) {
    where.push('channel = ?')
    params.push(filter.channel)
  }
  if (filter?.status !== undefined) {
    where.push('status = ?')
    params.push(filter.status)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT ${TOPIC_COLUMNS} FROM topics${clause} ORDER BY created_at DESC, id DESC`)
    .all(...params) as DbTopicRow[]
  return rows.map(toTopicRow)
}
