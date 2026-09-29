import type { Database } from 'better-sqlite3'
import type { StoryPart } from '../stories/types.js'

// The tuple is the declaration and the union derives from it (the pattern
// posts/types.ts's PLATFORMS follows), so a surface that must enumerate the
// vocabulary — the dashboard's route guard, its status dropdown — reads this
// one list instead of keeping a copy the compiler cannot check against it.
export const TOPIC_STATUSES = ['candidate', 'claimed', 'used', 'rejected'] as const

export type TopicStatus = (typeof TOPIC_STATUSES)[number]

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
  /**
   * Story mode only — null on topic-mode rows. `bodyText` is the narratable
   * text of THIS part; `seriesKey` groups one post's parts; `partIndex` is
   * 1-based.
   */
  bodyText: string | null
  seriesKey: string | null
  partIndex: number | null
  partCount: number | null
  /** Whether the series this part belongs to was cut short by max_parts. */
  truncated: boolean
  dedupeHash: string
  score: number
  reason: string
  status: TopicStatus
  jobId: string | null
  createdAt: string
}

// Scorer output lands as 'candidate' (score >= SCOUT_MIN_SCORE) or 'rejected';
// the operator lifecycle states are reached only via the transition fns below.
export interface NewTopic {
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  targetUrl?: string
  bodyText?: string
  seriesKey?: string
  partIndex?: number
  partCount?: number
  truncated?: boolean
  dedupeHash: string
  score: number
  reason: string
  status: 'candidate' | 'rejected'
}

const TOPIC_COLUMNS =
  'id, channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status, ' +
  'job_id, body_text, series_key, part_index, part_count, truncated, created_at'

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
  body_text: string | null
  series_key: string | null
  part_index: number | null
  part_count: number | null
  truncated: number
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
    bodyText: row.body_text,
    seriesKey: row.series_key,
    partIndex: row.part_index,
    partCount: row.part_count,
    truncated: row.truncated === 1,
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
    'INSERT OR IGNORE INTO topics (channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status, ' +
      'body_text, series_key, part_index, part_count, truncated) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        t.bodyText ?? null,
        t.seriesKey ?? null,
        t.partIndex ?? null,
        t.partCount ?? null,
        t.truncated === true ? 1 : 0,
      ).changes
    }
    return inserted
  })
  return insertAll(rows)
}

// Pre-Haiku hash filter: any status counts as known (a rejected item must
// never be re-scored). IN-list size is bounded by the scout's per-source
// candidate caps, far under SQLite's bound-variable limit.
//
// Matches against dedupe_hash OR series_key. A topic-mode candidate's hash is
// only ever written to dedupe_hash, so this is the same lookup it always was.
// A story's PARTS are stored under derived per-part hashes
// (`dedupeHash(sourceId, "${externalId}#pN")`) — the un-suffixed base hash the
// caller asks about here is never a row's own dedupe_hash, only its
// series_key. Matching dedupe_hash alone would therefore never recognize an
// already-queued (or already-rejected) story post, re-paying Haiku for it on
// every tick still inside the source's fetch window.
export function knownHashes(db: Database, channel: string, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set()
  const placeholders = hashes.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT dedupe_hash AS h FROM topics WHERE channel = ? AND dedupe_hash IN (${placeholders}) ` +
        `UNION ` +
        `SELECT series_key AS h FROM topics WHERE channel = ? AND series_key IN (${placeholders})`,
    )
    .all(channel, ...hashes, channel, ...hashes) as { h: string }[]
  return new Set(rows.map((r) => r.h))
}

// Scorer prompt context: how many recent titles feed the "recently covered —
// score near-duplicates 0" instruction (design spec §5).
export const RECENT_TITLES_LIMIT = 30

// Rejected topics are noise (near-duplicates, off-niche); the scorer only
// needs what the channel actually covered or queued.
//
// One title per STORY (not per row): a story's parts are one row each with
// near-identical titles ("X (1/4)", "X (2/4)", ...), so at the corpus's
// measured ~3.3 parts/story counting every row would let ~9 distinct stories
// crowd out what used to be a 30-distinct-topic window, while the scorer's
// "recently covered" prompt fills up with near-duplicate strings that all
// describe the same post. Topic-mode rows (series_key NULL) have no series to
// collapse and keep counting individually. The representative for a series is
// its lowest part_index among non-rejected rows (recomputed per row via the
// correlated MIN so a rejected part_index=1 doesn't hide the rest of an
// otherwise-live series), with the "(i/N)" queue suffix stripped since it is
// not part of the story's actual title.
const PART_SUFFIX = /\s*\(\d+\/\d+\)\s*$/

// The scorer's window deliberately excludes rejected rows — a topic scored
// below SCOUT_MIN_SCORE is stale/off-niche noise, not something worth telling
// the scorer "recently covered".
export function recentTopicTitles(
  db: Database,
  channel: string,
  limit = RECENT_TITLES_LIMIT,
): string[] {
  const rows = db
    .prepare(
      `SELECT t1.title AS title, t1.series_key AS seriesKey FROM topics t1
       WHERE t1.channel = ? AND t1.status != 'rejected'
         AND (t1.series_key IS NULL OR t1.part_index = (
           SELECT MIN(t2.part_index) FROM topics t2
           WHERE t2.channel = t1.channel AND t2.series_key = t1.series_key
             AND t2.status != 'rejected'
         ))
       ORDER BY t1.created_at DESC, t1.id DESC LIMIT ?`,
    )
    .all(channel, limit) as { title: string; seriesKey: string | null }[]
  return rows.map((r) => (r.seriesKey === null ? r.title : r.title.replace(PART_SUFFIX, '')))
}

// Queue depth for the scout's own gate: only 'candidate' rows count. A
// 'claimed' topic is already in a job, and 'used'/'rejected' are history —
// counting any of them would let a channel's past keep it from scouting.
export function candidateTopicCount(db: Database, channel: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM topics WHERE channel = ? AND status = 'candidate'")
    .get(channel) as { n: number }
  return row.n
}

// The sibling read the digest's topic-starvation check needs: a 'claimed'
// topic is spoken for by a live job, so a channel holding only claimed rows
// has an empty queue for scouting purposes but is not yet starved.
export function claimedTopicCount(db: Database, channel: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM topics WHERE channel = ? AND status = 'claimed'")
    .get(channel) as { n: number }
  return row.n
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

/**
 * The story payload for a job, resolved through the topic row `claimTopic`
 * bound to it. Null for a topic-mode job, for a manual `brainrot produce` job
 * (no topic row at all), and for a story row missing its body — all three are
 * the same thing to the caller: run the ordinary script path.
 *
 * This is how the payload survives a resume without any new `jobs` column:
 * the topic row outlives the run, and runJob reads it fresh every time.
 */
export function storyPartForJob(db: Database, jobId: string): StoryPart | null {
  const row = db
    .prepare(
      // job_id carries no unique constraint; claimTopic maintains the invariant
      // of one row per job. Ordering by id makes the choice deterministic rather
      // than index-dependent if that invariant is ever broken.
      'SELECT body_text, part_index, part_count, url, truncated FROM topics WHERE job_id = ? ORDER BY id LIMIT 1',
    )
    .get(jobId) as
    | {
        body_text: string | null
        part_index: number | null
        part_count: number | null
        url: string
        truncated: number
      }
    | undefined
  if (row === undefined) return null
  if (row.body_text === null || row.part_index === null || row.part_count === null) return null
  return {
    bodyText: row.body_text,
    partIndex: row.part_index,
    partCount: row.part_count,
    sourceUrl: row.url,
    truncated: row.truncated === 1,
  }
}
