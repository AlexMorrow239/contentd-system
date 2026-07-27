import type { Database } from 'better-sqlite3'

export type TopicStatus = 'candidate' | 'claimed' | 'used' | 'rejected'

export interface TopicRow {
  id: number
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  // The submission target: what the post points at, as opposed to `url`,
  // which is its comments permalink. Null for RSS items (no submission) and
  // for rows written before the column existed.
  targetUrl: string | null
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
  targetUrl?: string
  dedupeHash: string
  score: number
  reason: string
  status: 'candidate' | 'rejected'
}

const TOPIC_COLUMNS =
  'id, channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status, job_id, created_at'

interface DbTopicRow {
  id: number
  channel: string
  title: string
  raw_title: string
  source: string
  url: string
  target_url: string | null
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
    targetUrl: row.target_url,
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
    'INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        t.targetUrl ?? null,
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

// Operator veto. The status guard in the WHERE clause makes this idempotent
// and blind to ids in the wrong state — the returned count is what actually
// changed, which the CLI reports against ids.length.
export function rejectTopics(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE topics SET status = 'rejected' WHERE id IN (${placeholders}) AND status = 'candidate'`,
    )
    .run(...ids).changes
}

// Claim = bind topic to job. Guarded so a rejected/used/claimed topic is
// never revived even if a caller slips outside the produce lease; the boolean
// lets produce-next treat a failed claim as the invariant breach it is.
export function claimTopic(db: Database, topicId: number, jobId: string): boolean {
  const info = db
    .prepare(
      "UPDATE topics SET status = 'claimed', job_id = ? WHERE id = ? AND status = 'candidate'",
    )
    .run(jobId, topicId)
  return info.changes === 1
}

// A job in one of these states still owns its topic: requeueing it would let a
// second job claim the same topic while the first is live. 'blocked' is
// deliberately NOT here — a blocked job sits out the resume pass until an
// operator repairs the config behind it, which is precisely the strand this
// command exists to break, and refusing it left the digest's blocked-job
// advice with no command to name. Releasing it is safe because requeue also
// clears job_id, and markTopicUsedByJob keys on job_id: the old job resuming
// to completion later matches nothing. Every other jobs.status ('failed',
// 'done') is terminal, as is a missing job row.
const ACTIVE_JOB_STATUSES: readonly string[] = ['queued', 'running']

export type RequeueOutcome =
  | { ok: true }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'not-claimed'; status: TopicStatus }
  | { ok: false; reason: 'job-active'; jobId: string; jobStatus: string }

/**
 * Operator repair for a topic stranded in 'claimed' by a job that will never
 * finish (config drift, unreachable blocked job). Returns it to 'candidate' —
 * the base queue state — and unbinds the dead job so the stale binding can
 * never flip it to 'used' later. BEGIN IMMEDIATE because the guard reads
 * before it writes.
 */
export function requeueTopic(db: Database, id: number): RequeueOutcome {
  const attempt = db.transaction((): RequeueOutcome => {
    const topic = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as
      { status: TopicStatus; job_id: string | null } | undefined
    if (topic === undefined) return { ok: false, reason: 'unknown' }
    if (topic.status !== 'claimed')
      return { ok: false, reason: 'not-claimed', status: topic.status }
    if (topic.job_id !== null) {
      const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(topic.job_id) as
        { status: string } | undefined
      if (job !== undefined && ACTIVE_JOB_STATUSES.includes(job.status)) {
        return { ok: false, reason: 'job-active', jobId: topic.job_id, jobStatus: job.status }
      }
    }
    db.prepare("UPDATE topics SET status = 'candidate', job_id = NULL WHERE id = ?").run(id)
    return { ok: true }
  })
  return attempt.immediate()
}

// Called when a job lands in the library; a job with no claimed topic
// (manual `produce`) is a silent no-op.
export function markTopicUsedByJob(db: Database, jobId: string): void {
  db.prepare("UPDATE topics SET status = 'used' WHERE job_id = ? AND status = 'claimed'").run(jobId)
}

// limit is optional and unlimited by default — the CLI (`topics list`) relies
// on that to keep showing every row; only the dashboard passes one, to bound
// what an unbounded scout queue can otherwise render.
export function listTopics(
  db: Database,
  filter?: { channel?: string; status?: TopicStatus; limit?: number },
): TopicRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter?.channel !== undefined) {
    where.push('channel = ?')
    params.push(filter.channel)
  }
  if (filter?.status !== undefined) {
    where.push('status = ?')
    params.push(filter.status)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const limitClause = filter?.limit !== undefined ? ' LIMIT ?' : ''
  if (filter?.limit !== undefined) params.push(filter.limit)
  const rows = db
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics${clause} ORDER BY created_at DESC, id DESC${limitClause}`,
    )
    .all(...params) as DbTopicRow[]
  return rows.map(toTopicRow)
}

export function eligibleTopic(db: Database, channel: string): TopicRow | null {
  const row = db
    .prepare(
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE channel = ? AND status = 'candidate' ` +
        'ORDER BY score DESC, created_at ASC, id ASC LIMIT 1',
    )
    .get(channel) as DbTopicRow | undefined
  return row === undefined ? null : toTopicRow(row)
}
