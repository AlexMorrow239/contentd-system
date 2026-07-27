import type { Database } from 'better-sqlite3'
import BetterSqlite3 from 'better-sqlite3'
import type { Platform, PublishErrorKind } from './types.js'
import { PUBLISHABLE_LIBRARY_STATES } from '../jobs/library.js'

export type PublishStatus = 'claimed' | 'done' | 'failed' | 'interrupted'

export interface PublishRow {
  id: number
  jobId: string
  platform: Platform
  channel: string
  day: string
  seq: number
  status: PublishStatus
  postId: string | null
  url: string | null
  error: string | null
  errorKind: PublishErrorKind | null
  attempt: number
  createdAt: string
  finishedAt: string | null
}

// Attempt cap for the eligibility pool (design spec decision 8): a job with
// this many 'rejected'-kind failures retires from rotation and is
// digest-flagged — auth/quota/transient failures never count toward it.
export const MAX_PUBLISH_ATTEMPTS = 3

/**
 * INSERT a claimed row. Two counts are computed inside one transaction:
 *
 * - `attempt` = 1 + every prior row for this (jobId, platform) — the
 *   poison-video ordinal.
 * - `seq` = 1 + every prior row for this (channel, platform, day) — the
 *   within-day ordinal that replaced the old clock-time slot. The
 *   UNIQUE (channel, platform, day, seq) constraint is the database-level
 *   backstop against a double-publish when the publish lease fails; a
 *   conflict means a racing tick already took this ordinal, so the
 *   SqliteError from the INSERT (and only the INSERT) is reported as null
 *   rather than propagated.
 *
 * `.immediate()` (not a deferred BEGIN): the two reads and the INSERT must
 * share one write-locked snapshot, or a writer committing in between
 * invalidates it as SQLITE_BUSY_SNAPSHOT — the one busy error busy_timeout
 * cannot retry. Same rationale as acquireLease (lease.ts).
 *
 * Returns both the row id (for the finalize path) and the seq (for the tick's
 * reported outcome), or null on the conflict.
 */
export function claimPublish(
  db: Database,
  opts: { jobId: string; platform: Platform; channel: string; day: string },
): { id: number; seq: number } | null {
  const countPriorAttempts = db.prepare(
    'SELECT COUNT(*) AS n FROM publishes WHERE job_id = ? AND platform = ?',
  )
  const countDayRows = db.prepare(
    'SELECT COUNT(*) AS n FROM publishes WHERE channel = ? AND platform = ? AND day = ?',
  )
  const insertClaim = db.prepare(
    'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
      "VALUES (?, ?, ?, ?, ?, 'claimed', ?)",
  )
  const claim = db.transaction((): { id: number; seq: number } | null => {
    const { n: attempts } = countPriorAttempts.get(opts.jobId, opts.platform) as { n: number }
    const { n: dayRows } = countDayRows.get(opts.channel, opts.platform, opts.day) as { n: number }
    const seq = dayRows + 1
    try {
      const info = insertClaim.run(
        opts.jobId,
        opts.platform,
        opts.channel,
        opts.day,
        seq,
        attempts + 1,
      )
      return { id: Number(info.lastInsertRowid), seq }
    } catch (err) {
      if (err instanceof BetterSqlite3.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return null
      }
      throw err
    }
  })
  return claim.immediate()
}

// Which publishes row a done-flip targets: the tick keys the row it just
// claimed by id, the manual mark-done path keys it by job_id + status.
type PublishTargetRow = { id: number } | { jobId: string; status: PublishStatus }

// The done-flip both finalize paths share: the publishes row takes its post
// facts AND the library row flips to 'published' in ONE transaction — no
// window where one fact is visible without the other (design spec §6 step
// 9). `.immediate()` for the same reason as claimPublish: the job_id read
// and the two writes must share one write-locked snapshot. job_id is read
// inside the transaction because one caller keys by id and the other by
// job_id + status; the read must precede the UPDATE, which changes the very
// status the second form matches on. Returns the number of publishes rows
// flipped so each caller keeps its own return semantics.
function finishPublish(
  db: Database,
  target: PublishTargetRow,
  postId: string,
  url: string | null,
  now: Date,
): number {
  // Fixed literals, chosen by the target shape — never caller-supplied SQL.
  const where = 'id' in target ? 'id = ?' : 'job_id = ? AND status = ?'
  const params: (number | string)[] = 'id' in target ? [target.id] : [target.jobId, target.status]
  const selectJobIds = db.prepare(`SELECT job_id FROM publishes WHERE ${where}`)
  const updatePublish = db.prepare(
    `UPDATE publishes SET status = 'done', post_id = ?, url = ?, finished_at = ? WHERE ${where}`,
  )
  const updateLibrary = db.prepare("UPDATE library SET state = 'published' WHERE job_id = ?")
  const flip = db.transaction((): number => {
    const rows = selectJobIds.all(...params) as { job_id: string }[]
    if (rows.length === 0) return 0
    const info = updatePublish.run(postId, url, now.toISOString(), ...params)
    for (const row of rows) updateLibrary.run(row.job_id)
    return info.changes
  })
  return flip.immediate()
}

// Tick finalize (design spec §6 step 9). A missing id is a silent no-op
// (defensive; the tick only ever calls this with an id it just claimed).
export function markPublishDone(
  db: Database,
  id: number,
  postId: string,
  url: string,
  now: Date,
): void {
  finishPublish(db, { id }, postId, url, now)
}

// Failure never touches the library row: the video stays 'ready' and
// re-enters the eligibility pool for the next attempt (design spec decision 7).
export function markPublishFailed(
  db: Database,
  id: number,
  error: string,
  kind: PublishErrorKind,
  now: Date,
): void {
  db.prepare(
    "UPDATE publishes SET status = 'failed', error = ?, error_kind = ?, finished_at = ? WHERE id = ?",
  ).run(error, kind, now.toISOString(), id)
}

// Repair sweep for a tick that died mid-upload (design spec decision 12):
// claimed rows older than the TTL are stale — flip to 'interrupted' so
// they never look like an active claim to a later tick. Guarded by
// status, so a rerun against the same cutoff finds nothing left to flip.
export function sweepInterrupted(db: Database, olderThanMs: number, now: Date): number {
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString()
  const info = db
    .prepare(
      "UPDATE publishes SET status = 'interrupted' WHERE status = 'claimed' AND created_at <= ?",
    )
    .run(cutoff)
  return info.changes
}

// Platform quota gate (design spec decision 10, §6 step 4): every row that
// plausibly reached videos.insert today — claimed/done/interrupted, plus
// failed rows whose error_kind isn't 'auth' (an auth rejection never
// reaches the upload call, so it never burns quota; NULL error_kind is a
// non-auth failure and still counts). `IS NOT` (not `!=`) so a NULL
// error_kind compares as non-auth instead of making the whole clause
// unknown.
//
// `channel` is optional (design spec decision 7, §7): a `scope: 'global'`
// quota (YouTube) calls this with no channel, counting every channel's
// usage together; a `scope: 'channel'` quota (Instagram) passes its channel
// so each account's cap is tracked independently. Appended only when given,
// so the unfiltered call shape is unchanged.
export function uploadsUsedToday(
  db: Database,
  platform: Platform,
  day: string,
  channel?: string,
): number {
  const channelClause = channel !== undefined ? 'AND channel = ?' : ''
  const params = channel !== undefined ? [platform, day, channel] : [platform, day]
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM publishes WHERE platform = ? AND day = ? ${channelClause} ` +
        "AND (status != 'failed' OR error_kind IS NOT 'auth')",
    )
    .get(...params) as { n: number }
  return row.n
}

/**
 * Videos — not rows — this channel attempted today. A fan-out writes one row
 * per platform for the SAME video, and `videos_per_day` counts videos, so
 * this counts DISTINCT job_id.
 *
 * Rows of ANY status count. An attempt consumes its place in the day exactly
 * as a slot used to be consumed: a channel with a broken credential burns one
 * attempt per min-gap instead of racing through its whole library in an hour.
 */
export function videosPublishedToday(db: Database, channel: string, day: string): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT job_id) AS n FROM publishes WHERE channel = ? AND day = ?')
    .get(channel, day) as { n: number }
  return row.n
}

/**
 * When this channel last attempted a publish, for the min-gap check — or null
 * when it never has. Deliberately NOT filtered by day: a day-scoped read
 * returns null at 00:00 and would let a channel publish immediately after a
 * 23:55 attempt. created_at is stored as UTC ISO-8601 with a 'Z' suffix, so
 * `new Date` parses it unambiguously.
 */
export function lastAttemptAt(db: Database, channel: string): Date | null {
  const row = db
    .prepare('SELECT MAX(created_at) AS at FROM publishes WHERE channel = ?')
    .get(channel) as { at: string | null }
  return row.at === null ? null : new Date(row.at)
}

// One row of the publish pool: the video the tick will hand an adapter, plus
// the metadata it needs to render the post. `objectKey` is null for library
// rows produced before object storage existed (see ../jobs/backfill-store.ts),
// so it is the tick's cue that only a local file can serve this video.
// Named rather than inlined at each use because the publish tick threads the
// same shape through its candidate scan and its `picked` state.
export interface EligibleVideo {
  jobId: string
  videoPath: string
  objectKey: string | null
  metadataJson: string
  topic: string
}

// Eligibility per design spec §6 step 6 and §3.3 (decision 1, decision 9):
// 'ready' OR 'published' library rows for jobs on this channel — a video
// already published on one platform stays in every other platform's pool,
// since platforms never compete for videos — excluding any job that
// already has a done/claimed/interrupted row for THIS platform (it's
// either published here already or in flight), and excluding any job at
// or past MAX_PUBLISH_ATTEMPTS 'rejected' failures (poison-video guard —
// decision 8; only 'rejected' counts, since auth/quota/transient failures
// are channel- or platform-wide, not the video's fault). The LEFT JOIN is
// against a per-job aggregate (grouped by job_id, filtered to this platform) rather
// than a raw join against `publishes`, so a job with several rows
// contributes exactly one joined row — no fan-out to dedupe. Order:
// fewest failed rows of any kind first (spreads attempts during a
// channel-wide outage), then newest library row first (fresh trend
// content over stale), then job id for determinism.
//
// `excludeJobIds` lets a caller walk PAST the top row and see the next one:
// the publish tick uses it to step over ready rows whose video file was
// pruned off disk, a condition no column here can express. Only the count of
// ids shapes the SQL (one `?` each) — the ids themselves are bound
// parameters, never interpolated text.
export function eligibleVideo(
  db: Database,
  channel: string,
  platform: Platform,
  excludeJobIds: readonly string[] = [],
): EligibleVideo | null {
  const exclusion =
    excludeJobIds.length === 0
      ? ''
      : `AND l.job_id NOT IN (${excludeJobIds.map(() => '?').join(', ')})`
  const row = db
    .prepare(
      `SELECT l.job_id AS jobId, l.video_path AS videoPath, lo.object_key AS objectKey,
              l.metadata_json AS metadataJson, j.topic AS topic
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       LEFT JOIN (
         SELECT job_id,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
                SUM(CASE WHEN status = 'failed' AND error_kind = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
                SUM(CASE WHEN status IN ('done','claimed','interrupted') THEN 1 ELSE 0 END) AS blockingCount
         FROM publishes
         WHERE platform = ?
         GROUP BY job_id
       ) p ON p.job_id = l.job_id
       WHERE l.state IN (${PUBLISHABLE_LIBRARY_STATES})
         AND j.channel = ?
         AND COALESCE(p.blockingCount, 0) = 0
         AND COALESCE(p.rejectedCount, 0) < ?
         ${exclusion}
       ORDER BY COALESCE(p.failedCount, 0) ASC, l.created_at DESC, l.job_id ASC
       LIMIT 1`,
    )
    .get(platform, channel, MAX_PUBLISH_ATTEMPTS, ...excludeJobIds) as EligibleVideo | undefined
  return row === undefined ? null : row
}

// Manual resolution path (design spec §7 `publish retry`): interrupted →
// failed with kind 'transient' so the video re-enters the eligibility
// pool at the next attempt. The suffix appends to whatever error text is
// already on the row (interrupted rows leave it NULL, so COALESCE keeps
// the append from producing a literal "null" prefix). Guarded by status,
// so a job with no interrupted row is a no-op and reports false.
export function retryInterrupted(db: Database, jobId: string): boolean {
  const info = db
    .prepare(
      "UPDATE publishes SET status = 'failed', error_kind = 'transient', " +
        "error = COALESCE(error, '') || '; manually cleared' " +
        "WHERE job_id = ? AND status = 'interrupted'",
    )
    .run(jobId)
  // Invariant: eligibleVideo excludes any job with a blocking row (done/
  // claimed/interrupted) for the platform, so a job never re-enters rotation
  // to accrue a second interrupted row — ≤1 per (job, platform). `>= 1` (not
  // `=== 1`) so that even under a hypothetical multi-row state this still
  // reports the truthful "rows were changed" rather than a false negative.
  return info.changes >= 1
}

// Manual resolution path (design spec §7 `publish mark-done`): for when
// Studio confirms the upload actually landed. Shares markPublishDone's
// transaction via finishPublish, guarded on the interrupted row existing —
// a job with no interrupted row leaves both tables untouched and reports
// false. `>= 1` (not `=== 1`) for the same invariant as retryInterrupted:
// at most one interrupted row per (job, platform), so any match is a real
// flip.
export function markInterruptedDone(
  db: Database,
  jobId: string,
  postId: string,
  url: string | null,
  now: Date,
): boolean {
  return finishPublish(db, { jobId, status: 'interrupted' }, postId, url, now) >= 1
}

// Which platform a job's interrupted upload landed on — the row itself is the
// authority, so `publish mark-done` needs no --platform flag and can never
// record one platform's URL shape against another's post. Null when the job
// has no interrupted row (the same condition markInterruptedDone reports as
// false). At most one such row per (job, platform) by eligibleVideo's
// invariant; the ORDER BY only makes the multi-platform pick deterministic.
export function interruptedPlatform(db: Database, jobId: string): Platform | null {
  const row = db
    .prepare(
      "SELECT platform FROM publishes WHERE job_id = ? AND status = 'interrupted' ORDER BY id ASC",
    )
    .get(jobId) as { platform: Platform } | undefined
  return row?.platform ?? null
}

const PUBLISH_COLUMNS =
  'id, job_id, platform, channel, day, seq, status, post_id, url, error, error_kind, attempt, created_at, finished_at'

interface DbPublishRow {
  id: number
  job_id: string
  platform: Platform
  channel: string
  day: string
  seq: number
  status: PublishStatus
  post_id: string | null
  url: string | null
  error: string | null
  error_kind: PublishErrorKind | null
  attempt: number
  created_at: string
  finished_at: string | null
}

function toPublishRow(row: DbPublishRow): PublishRow {
  return {
    id: row.id,
    jobId: row.job_id,
    platform: row.platform,
    channel: row.channel,
    day: row.day,
    seq: row.seq,
    status: row.status,
    postId: row.post_id,
    url: row.url,
    error: row.error,
    errorKind: row.error_kind,
    attempt: row.attempt,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

// Attempt history for `brainrot publishes list` (design spec §7). No
// `now` parameter — this is a display query, not scheduling logic, so it
// reads SQLite's own wall clock exactly like the digest's '-1 day' window
// does.
export function listPublishes(db: Database, opts?: { sinceDays?: number }): PublishRow[] {
  const sinceDays = opts?.sinceDays ?? 7
  const rows = db
    .prepare(
      `SELECT ${PUBLISH_COLUMNS} FROM publishes WHERE datetime(created_at) >= datetime('now', ?) ` +
        'ORDER BY created_at DESC, id DESC',
    )
    .all(`-${sinceDays} days`) as DbPublishRow[]
  return rows.map(toPublishRow)
}
