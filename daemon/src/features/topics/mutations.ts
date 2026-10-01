import type { Database } from 'better-sqlite3'
import { systemTime, type TimeSource } from '../../shared/time.js'
import type { TopicStatus } from './status.js'
import { NewTopic, RequeueOutcome } from './types.js'

// INSERT OR IGNORE on UNIQUE (channel, dedupe_hash): re-inserting a known item
// is a no-op, so the returned count is rows actually written. One transaction —
// a mid-run crash loses the whole batch, never half of it.
export function insertTopics(
  db: Database,
  rows: NewTopic[],
  time: TimeSource = systemTime,
): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status, ' +
      'body_text, series_key, part_index, part_count, truncated, created_at, source_context_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertAll = db.transaction((batch: NewTopic[]) => {
    const createdAt = time.now().toISOString()
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
        t.bodyText ?? null,
        t.seriesKey ?? null,
        t.partIndex ?? null,
        t.partCount ?? null,
        t.truncated === true ? 1 : 0,
        createdAt,
        t.sourceContext === undefined ? null : JSON.stringify(t.sourceContext),
      ).changes
    }
    return inserted
  })
  return insertAll(rows)
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
