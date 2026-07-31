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
 * INSERT a claimed row. Two reads are computed inside one transaction:
 *
 * - `attempt` = 1 + every prior row for this (jobId, platform) — the
 *   poison-video ordinal.
 * - `seq` = 1 + the highest seq already used for this (channel, platform,
 *   day) — the within-day ordinal that replaced the old clock-time slot.
 *   MAX rather than COUNT: a gap left by a rejected/retired ordinal (e.g.
 *   rows at seq 1 and 3, seq 2 never landing) would otherwise make every
 *   later claim that day recompute the same already-taken seq from
 *   COUNT(*) + 1, hit the UNIQUE constraint, and report `claim-conflict`
 *   deterministically until the day rolls over. MAX(seq) + 1 always lands on
 *   an unused ordinal, healing the gap for free. Coalesced to 0 so the first
 *   claim of the day is still 1.
 *
 * UNIQUE (channel, platform, day, seq) is a BOOKKEEPING invariant — it keeps
 * the day's ordinals distinct — and NOT a double-publish guard. `seq` is
 * derived from the rows that already exist, so two claims for the same (job,
 * platform, day) are serialized by this `.immediate()` transaction and simply
 * receive different ordinals (1 and 2); they never collide on it. (Under the
 * old design `slot` was CONFIG-derived, so two racing ticks computed the same
 * clock time and the second genuinely conflicted. That property left with the
 * slots.) A seq conflict is therefore only reachable when a second writer's
 * INSERT lands between this transaction's MAX(seq) read and its own INSERT.
 *
 * The double-publish guard is the OTHER constraint this INSERT is subject to:
 * `ux_publishes_live`, a partial unique index on (job_id, platform) over the
 * live statuses — the same rule `channelVideoCandidates` applies when it
 * decides a platform is blocked. That read runs in the tick, outside this
 * transaction, so two concurrent lease holders would both see the video as
 * open; the index is what stops the second one here, before any upload. It is
 * created by `db/migrate.ts` (`ensureLivePublishIndex`), which SKIPS creation
 * on a database that already holds a violating row rather than wedging every
 * command — so treat it as defense in depth behind the publish lease, not as a
 * guarantee the lease can be dropped.
 *
 * Either constraint's SqliteError from the INSERT (and only the INSERT) is
 * reported as null rather than propagated, which the tick renders as its
 * existing `claim-conflict` outcome.
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
  const maxDaySeq = db.prepare(
    'SELECT MAX(seq) AS maxSeq FROM publishes WHERE channel = ? AND platform = ? AND day = ?',
  )
  const insertClaim = db.prepare(
    'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt) ' +
      "VALUES (?, ?, ?, ?, ?, 'claimed', ?)",
  )
  const claim = db.transaction((): { id: number; seq: number } | null => {
    const { n: attempts } = countPriorAttempts.get(opts.jobId, opts.platform) as { n: number }
    const { maxSeq } = maxDaySeq.get(opts.channel, opts.platform, opts.day) as {
      maxSeq: number | null
    }
    const seq = (maxSeq ?? 0) + 1
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
// Named separately from ChannelVideoCandidate below because the SQL row shape
// (before per-platform blocking is folded in) is its own thing.
interface PublishableVideo {
  jobId: string
  videoPath: string
  // Null for library rows produced before object storage existed AND for rows
  // whose object has been reclaimed (publish/reclaim.ts) — both mean the same
  // thing to the caller: only a local file can serve this video.
  objectKey: string | null
  metadataJson: string
  topic: string
}

export interface ChannelVideoCandidate extends PublishableVideo {
  /** Platforms this video can never go to again, per database state alone. */
  blockedPlatforms: Platform[]
}

// The per-(job, platform) blocking aggregate, as a SQL fragment shared by the
// two reads below: the candidate query counts how many of the channel's
// declared platforms it rules out, and the reporting query names them. One
// text, so the two can never disagree about what "blocked" means.
//
// A platform is blocked when the job already has a done/claimed/interrupted
// row for it (published there, or in flight) or has reached
// MAX_PUBLISH_ATTEMPTS 'rejected' failures there (poison-video guard — only
// 'rejected' counts, since auth/quota/transient failures are channel- or
// platform-wide, not the video's fault).
const BLOCKING_AGGREGATE = `SELECT job_id, platform,
          SUM(CASE WHEN status IN ('done','claimed','interrupted') THEN 1 ELSE 0 END) AS blockingCount,
          SUM(CASE WHEN status = 'failed' AND error_kind = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount
   FROM publishes` as const
// Keeps only the blocked (job, platform) pairs. Applied as a WHERE against the
// aggregate wrapped as a subquery, so both reads can name its output columns by
// alias. The `?` binds MAX_PUBLISH_ATTEMPTS.
const BLOCKED_PREDICATE = 'blockingCount > 0 OR rejectedCount >= ?'

/**
 * Publishable videos for one channel, newest-relevant first, each carrying
 * the platforms that database state rules out. Selection is per channel, not
 * per platform, because one tick publishes one video to every platform that
 * still wants it — so the platform set is an output rather than an input.
 *
 * `platforms` is the channel's declared target list, passed as plain data (a
 * `Platform[]`, never a ChannelConfig — this stays a config-free DAO). It is
 * used for one thing: a video every one of THOSE platforms blocks is omitted,
 * because no caller could ever act on it. The count of platforms the codebase
 * knows about is irrelevant here — a YouTube-only channel's video that already
 * published to YouTube is finished, even though `instagram` exists as a
 * platform. Returning it anyway would let already-published rows crowd the
 * caller's limited candidate budget until a genuinely publishable video (which
 * sorts behind them the moment it carries one failure) never surfaced at all.
 * An empty `platforms` therefore returns nothing: every row is vacuously
 * fully-blocked.
 *
 * `blockedPlatforms` itself is NOT filtered by `platforms` — it reports every
 * platform database state rules out, so a caller can distinguish "not declared"
 * from "declared but blocked".
 *
 * The three conditions the DAO cannot see — the platform's quota, its
 * credential, and whether the video file still exists on disk — are the
 * caller's to apply, which is why this returns a LIST: the tick walks it
 * until one row survives all three.
 *
 * Order: fewest prior failed rows of any kind first (spreads attempts during
 * a channel-wide outage instead of hammering one video), then newest library
 * row (fresh trend content over stale), then job id for determinism. Bounded
 * by a SQL LIMIT, not a JS truncation: the fully-blocked drop test is
 * expressible against `platforms`, so a channel's whole publish history (every
 * `metadata_json` included) never has to be loaded to return `limit` rows.
 *
 * `createdAfter` is the aged-out horizon (agedCutoff, ./settled.ts): videos
 * older than it are never returned — PROVIDED something outranked them WHILE
 * THEY WERE WAITING, which is the NOT EXISTS half of the clause below and the
 * SQL twin of isAged (./settled.ts): a done row of a different job, in this
 * channel, created after the video AND at or before the same horizon. All
 * three parts have to be here: drop the date and nothing ages out; drop the
 * contention and a publish outage longer than backlog_days makes every stored
 * video permanently un-publishable while it still counts as inventory — a
 * channel wedged by its own gate, which is the exact livelock this design
 * exists to prevent; drop the `<= createdAfter` upper bound and the FIRST
 * publish after that outage ages out the entire backlog behind it in one tick,
 * which merely defers the same damage. The age clause alone (rather than the full
 * settled predicate) is sufficient for what remains: for an aged, contended
 * video EVERY declared platform is closed already — done, attempt-capped,
 * pending (which BLOCKED_PREDICATE rules out), or settled by age. Every
 * comparison is lexicographic on the same fixed-width ISO-8601 UTC format, so
 * string order is chronological order.
 */
export function channelVideoCandidates(
  db: Database,
  channel: string,
  platforms: readonly Platform[],
  limit: number,
  createdAfter: string,
): ChannelVideoCandidate[] {
  // `platform IN ()` is a syntax error, and the answer is [] regardless.
  if (platforms.length === 0) return []
  const platformParams = platforms.map(() => '?').join(', ')
  // The series tiebreak (second ORDER BY term below) sits between the
  // poison-video term and recency: a continuation part (part_index > 1)
  // outranks unrelated videos so an in-flight series drains contiguously,
  // while part 1 of a new story is an ordinary video. It reads part_index via
  // a correlated scalar subquery rather than a LEFT JOIN topics in the main
  // FROM clause: topics.job_id carries no unique constraint, so a join there
  // would duplicate a library row for any job with more than one topics row,
  // double-counting it as a candidate. ORDER BY t.id LIMIT 1 picks the first
  // such row deterministically, the same "first row wins" resolution used
  // elsewhere in this codebase for this same non-unique join (Task 5).
  // COALESCE is load-bearing too: a bare "part_index > 1" comparison is NULL
  // for every topic-mode row, and SQLite sorts NULL FIRST under DESC, which
  // would hand non-story videos the priority instead of denying it to them.
  const rows = db
    .prepare(
      `SELECT l.job_id AS jobId, l.video_path AS videoPath,
              CASE WHEN lo.reclaimed_at IS NULL THEN lo.object_key END AS objectKey,
              l.metadata_json AS metadataJson, j.topic AS topic
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       LEFT JOIN (
         SELECT job_id, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount
         FROM publishes GROUP BY job_id
       ) agg ON agg.job_id = l.job_id
       LEFT JOIN (
         SELECT job_id, COUNT(*) AS blockedCount FROM (
           ${BLOCKING_AGGREGATE} WHERE platform IN (${platformParams})
           GROUP BY job_id, platform
         ) WHERE ${BLOCKED_PREDICATE}
         GROUP BY job_id
       ) blk ON blk.job_id = l.job_id
       WHERE l.state IN (${PUBLISHABLE_LIBRARY_STATES}) AND j.channel = ?
             AND (l.created_at >= ?
                  OR NOT EXISTS (SELECT 1 FROM publishes p
                                 WHERE p.channel = ? AND p.status = 'done'
                                       AND p.job_id != l.job_id
                                       AND p.created_at > l.created_at
                                       AND p.created_at <= ?))
             AND COALESCE(blk.blockedCount, 0) < ?
       ORDER BY COALESCE(agg.failedCount, 0) ASC,
                (COALESCE((SELECT t.part_index FROM topics t WHERE t.job_id = l.job_id ORDER BY t.id LIMIT 1), 1) > 1) DESC,
                l.created_at DESC, l.job_id ASC
       LIMIT ?`,
    )
    .all(
      // Bind order follows the '?' order in the text above: the blk subquery's
      // platform list, then its attempt cap, then channel, the aged-out
      // horizon, the contention subquery's channel, the SAME horizon again as
      // that subquery's upper bound, the declared-platform count, and the row
      // limit.
      ...platforms,
      MAX_PUBLISH_ATTEMPTS,
      channel,
      createdAfter,
      channel,
      createdAfter,
      platforms.length,
      limit,
    ) as PublishableVideo[]
  if (rows.length === 0) return []

  // Every blocking fact for the rows actually returned, in ONE grouped read
  // rather than a query per row — the walk below is a Map lookup. Keyed by the
  // selected job ids (already channel-scoped by the query above), so the read
  // is bounded by `limit` no matter how long the channel's history grows.
  const jobParams = rows.map(() => '?').join(', ')
  const blocking = db
    .prepare(
      `SELECT job_id AS jobId, platform FROM (
         ${BLOCKING_AGGREGATE} WHERE job_id IN (${jobParams}) GROUP BY job_id, platform
       ) WHERE ${BLOCKED_PREDICATE}`,
    )
    .all(...rows.map((r) => r.jobId), MAX_PUBLISH_ATTEMPTS) as {
    jobId: string
    platform: Platform
  }[]

  const blockedByJob = new Map<string, Platform[]>()
  for (const b of blocking) {
    const list = blockedByJob.get(b.jobId) ?? []
    list.push(b.platform)
    blockedByJob.set(b.jobId, list)
  }

  // Ordered series: a part may not publish to a platform until its predecessor
  // has. Computed here rather than inside the aggregate above, which is dense
  // and load-bearing; two small reads plus a set difference is easier to
  // verify and leaves the settled predicate untouched.
  //
  // Fails OPEN when the predecessor topic row is missing entirely (it should
  // never be — parts insert in one transaction): an unexpected gap publishes a
  // part early, which is recoverable, rather than wedging the series forever.
  const predecessors = db
    .prepare(
      `SELECT t.job_id AS jobId, prev.job_id AS prevJobId
       FROM topics t
       JOIN topics prev ON prev.channel = t.channel
                       AND prev.series_key = t.series_key
                       AND prev.part_index = t.part_index - 1
       WHERE t.part_index > 1 AND t.job_id IN (${jobParams})`,
    )
    .all(...rows.map((r) => r.jobId)) as { jobId: string; prevJobId: string | null }[]

  if (predecessors.length > 0) {
    const prevIds = predecessors.map((p) => p.prevJobId).filter((id): id is string => id !== null)
    const donePairs = new Set<string>()
    if (prevIds.length > 0) {
      const donePlaceholders = prevIds.map(() => '?').join(', ')
      const done = db
        .prepare(
          `SELECT job_id AS jobId, platform FROM publishes
           WHERE status = 'done' AND job_id IN (${donePlaceholders})`,
        )
        .all(...prevIds) as { jobId: string; platform: Platform }[]
      for (const d of done) donePairs.add(`${d.jobId}\n${d.platform}`)
    }
    for (const { jobId, prevJobId } of predecessors) {
      // A predecessor that has no job yet (still queued as a topic) has
      // published nowhere, so every platform is blocked.
      const blocked = platforms.filter(
        (p) => prevJobId === null || !donePairs.has(`${prevJobId}\n${p}`),
      )
      if (blocked.length === 0) continue
      const list = blockedByJob.get(jobId) ?? []
      for (const p of blocked) if (!list.includes(p)) list.push(p)
      blockedByJob.set(jobId, list)
    }
  }

  return rows.map((row) => ({
    jobId: row.jobId,
    videoPath: row.videoPath,
    objectKey: row.objectKey,
    metadataJson: row.metadataJson,
    topic: row.topic,
    blockedPlatforms: [...(blockedByJob.get(row.jobId) ?? [])].sort(),
  }))
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
  // Invariant: channelVideoCandidates reports a platform with a blocking row
  // (done/claimed/interrupted) as blocked, so a job never re-enters rotation
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
// false). At most one such row per (job, platform) by channelVideoCandidates'
// blocking invariant; the ORDER BY only makes the multi-platform pick
// deterministic.
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
