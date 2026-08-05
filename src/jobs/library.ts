import type { StoreArtifact } from '../stages/store.js'
import type { Database } from 'better-sqlite3'
import { errorMessage } from '../errors.js'
// ./config.js, not ./s3.js: this module is reachable from the produce tick and
// the dashboard's queries, neither of which may drag the AWS SDK in.
import { loadStoreFromEnv } from '../storage/config.js'
import type { ObjectStore } from '../storage/types.js'
import type { Platform } from '../posts/types.js'

// One list, type derived (the pattern posts/types.ts sets for PLATFORMS), so
// the dashboard's filter allowlist and its dropdown options can share the
// vocabulary the DAO owns instead of each spelling it out.
export const LIBRARY_STATES = ['ready', 'needs-review', 'blocked'] as const

export type LibraryState = (typeof LIBRARY_STATES)[number]

export interface LibraryRow {
  jobId: string
  channel: string
  topic: string
  videoPath: string
  state: LibraryState
  createdAt: string
}

// library only carries job_id/video_path/metadata_json/state/created_at;
// channel/topic live on the owning job row, hence the JOIN.
const LIBRARY_COLUMNS =
  'library.job_id AS job_id, jobs.channel AS channel, jobs.topic AS topic, ' +
  'library.video_path AS video_path, library.state AS state, library.created_at AS created_at'

interface DbLibraryRow {
  job_id: string
  channel: string
  topic: string
  video_path: string
  state: LibraryState
  created_at: string
}

function toLibraryRow(row: DbLibraryRow): LibraryRow {
  return {
    jobId: row.job_id,
    channel: row.channel,
    topic: row.topic,
    videoPath: row.video_path,
    state: row.state,
    createdAt: row.created_at,
  }
}

export function listLibrary(
  db: Database,
  filter?: { state?: LibraryState; channel?: string },
): LibraryRow[] {
  const where: string[] = []
  const params: string[] = []
  if (filter?.state !== undefined) {
    where.push('library.state = ?')
    params.push(filter.state)
  }
  if (filter?.channel !== undefined) {
    where.push('jobs.channel = ?')
    params.push(filter.channel)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT ${LIBRARY_COLUMNS} FROM library JOIN jobs ON library.job_id = jobs.id${clause} ` +
        'ORDER BY created_at DESC',
    )
    .all(...params) as DbLibraryRow[]
  return rows.map(toLibraryRow)
}

export interface ApproveResult {
  /** Rows actually promoted to 'ready'. */
  approved: number
  /**
   * Ids refused because their bytes are gone. Reported separately rather than
   * folded into the shortfall: an id in the wrong state is a typo, an id whose
   * object was reclaimed is a video the operator can never publish.
   */
  reclaimed: string[]
}

/**
 * Publish gate (design spec decision 4): only needs-review rows can be
 * promoted into the publish pool, and only into 'ready'. The status guard
 * makes this idempotent and blind to ids in the wrong state — the returned
 * count is what actually changed, which the CLI reports against jobIds.length.
 *
 * A row whose stored object was reclaimed is refused. A needs-review video has
 * no `posts` rows, so once every declared platform is posted the reclaim
 * sweep frees its bytes (the accepted behaviour — needs-review is deliberately
 * NOT exempt). Promoting such a row afterwards would put a video with nothing
 * to upload into the publish pool, where the operator can only post it, find
 * nothing there, and try again. The refusal is reported, never silent.
 */
export function approveLibrary(db: Database, jobIds: string[]): ApproveResult {
  if (jobIds.length === 0) return { approved: 0, reclaimed: [] }
  const placeholders = jobIds.map(() => '?').join(', ')
  // Named BEFORE the update, and scoped to rows the update would otherwise
  // have taken — an id already 'ready' or unknown is not a reclaimed refusal.
  const reclaimed = (
    db
      .prepare(
        `SELECT l.job_id AS jobId FROM library l
         JOIN library_objects lo ON lo.job_id = l.job_id
         WHERE l.job_id IN (${placeholders}) AND l.state = 'needs-review'
               AND lo.reclaimed_at IS NOT NULL
         ORDER BY l.job_id`,
      )
      .all(...jobIds) as { jobId: string }[]
  ).map((r) => r.jobId)
  const approved = db
    .prepare(
      `UPDATE library SET state = 'ready' WHERE job_id IN (${placeholders}) AND state = 'needs-review'
       AND NOT EXISTS (SELECT 1 FROM library_objects lo
                       WHERE lo.job_id = library.job_id AND lo.reclaimed_at IS NOT NULL)`,
    )
    .run(...jobIds).changes
  return { approved, reclaimed }
}

// Reject retires a row from either of two states: needs-review (never
// promoted) or ready (pulled from the pool). There is no 'published' state
// to pull back from any more — a video is either not yet fully posted
// (still 'ready'/'needs-review') or it is, and posting is recorded in
// `posts`, not in `library.state`.
export function rejectLibrary(db: Database, jobIds: string[]): number {
  if (jobIds.length === 0) return 0
  const placeholders = jobIds.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE library SET state = 'blocked' WHERE job_id IN (${placeholders}) AND state IN ('needs-review', 'ready')`,
    )
    .run(...jobIds).changes
}

// `videoPath` is the local file backfill uploads FROM; the digest ignores it
// and reports on jobId/channel alone.
export interface UnstoredLibraryJob {
  jobId: string
  channel: string
  videoPath: string
}

/**
 * Library rows with no stored object — exactly the set
 * `brainrot library backfill-store` will upload.
 *
 * One definition rather than two, because the digest's warning line names that
 * command: when the two predicates disagree, the digest reports a count the
 * command it recommends does not act on. 'blocked' is the only excluded
 * state — a rejected video's object was deliberately deleted (design spec
 * decision 7), and re-uploading it would resurrect what the operator threw
 * away. 'needs-review' is deliberately IN scope: approving one promotes it
 * straight into the publish pool, where a missing object leaves the operator
 * nothing to download and post, so it is worth uploading and worth reporting
 * before then.
 */
export function unstoredLibraryJobs(db: Database): UnstoredLibraryJob[] {
  return db
    .prepare(
      `SELECT l.job_id AS jobId, j.channel AS channel, l.video_path AS videoPath
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE lo.job_id IS NULL AND l.state != 'blocked'
       ORDER BY l.job_id`,
    )
    .all() as UnstoredLibraryJob[]
}

/**
 * How many finished videos this channel is still holding — the number
 * plan-tick compares against backlogCap.
 *
 * "Unconsumed" is now simply "not posted to every declared platform".
 * 'needs-review' counts too: the video exists, it cost money, and it is
 * waiting on the operator either way.
 *
 * The zero-declared-platforms case needs its own branch, not a clever
 * subquery: with `declared` empty the comparison below reads `0 < 0` for
 * every row, nothing would ever count, and a channel that has not yet
 * decided where its videos go would produce without bound.
 */
export function pendingInventory(
  db: Database,
  opts: { channel: string; declared: readonly Platform[] },
): number {
  if (opts.declared.length === 0) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM library l JOIN jobs j ON j.id = l.job_id
         WHERE j.channel = ? AND l.state IN ('needs-review', 'ready')`,
      )
      .get(opts.channel) as { n: number }
    return row.n
  }
  const placeholders = opts.declared.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM library l JOIN jobs j ON j.id = l.job_id
       WHERE j.channel = ? AND l.state IN ('needs-review', 'ready')
         AND (SELECT COUNT(*) FROM posts p
              WHERE p.job_id = l.job_id AND p.platform IN (${placeholders})) < ?`,
    )
    .get(opts.channel, ...opts.declared, opts.declared.length) as { n: number }
  return row.n
}

/**
 * Records where a finished video landed in object storage. Idempotent on
 * job_id, which both callers depend on: the final gate's re-runnable window
 * (runJob, ./runner.ts) upserts the same artifact on every resume, and the
 * operator backfill (./backfill-store.ts) may be re-run over rows it already
 * uploaded. Synchronous, so it composes inside runJob's db.transaction().
 *
 * `reclaimed_at` is cleared on conflict: the row describes what is in the
 * bucket NOW, and an upsert means something was just put there. No caller
 * re-uploads a reclaimed job today (backfillStore keys off the row's absence,
 * and reclaim keeps the row precisely to stop that), but leaving the stamp set
 * would mark a live object as freed and orphan it in the bucket forever.
 */
export function upsertLibraryObject(db: Database, jobId: string, object: StoreArtifact): void {
  db.prepare(
    'INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(job_id) DO UPDATE SET object_key=excluded.object_key, bytes=excluded.bytes, ' +
      'etag=excluded.etag, reclaimed_at=NULL',
  ).run(jobId, object.objectKey, object.bytes, object.etag)
}

// Reject deletes the stored object too (design spec decision 7), so the CLI
// needs the keys BEFORE the rows are touched. Returns only jobs that actually
// have an object — an id with no row simply does not appear, and neither does
// one whose object the reclaim sweep already deleted: attempting that delete
// would warn about an orphan that does not exist.
export function libraryObjectKeys(
  db: Database,
  jobIds: string[],
): { jobId: string; objectKey: string }[] {
  if (jobIds.length === 0) return []
  const placeholders = jobIds.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT job_id AS jobId, object_key AS objectKey FROM library_objects
       WHERE job_id IN (${placeholders}) AND reclaimed_at IS NULL ORDER BY job_id`,
    )
    .all(...jobIds) as { jobId: string; objectKey: string }[]
}

/**
 * The store-delete loop both retirement paths share: reject (which drops the
 * library_objects row) and reclaim (which stamps reclaimed_at instead). One
 * text, so the two can never drift on error handling.
 *
 * One bad key must not stop the rest, so each delete is its own try/catch, and
 * `onDeleted` runs only after its delete succeeds — a failure therefore leaves
 * the row's record untouched, which is what makes the next sweep retry it
 * rather than orphan the object silently.
 */
export async function deleteStoredObjects(opts: {
  objects: readonly { jobId: string; objectKey: string }[]
  store: ObjectStore
  onDeleted: (jobId: string) => void
  warn: (message: string) => void
}): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = []
  const failed: string[] = []
  for (const o of opts.objects) {
    try {
      await opts.store.delete(o.objectKey)
      opts.onDeleted(o.jobId)
      deleted.push(o.jobId)
    } catch (err) {
      opts.warn(
        `could not delete ${o.objectKey} for ${o.jobId} (left orphaned): ${errorMessage(err)}`,
      )
      failed.push(o.jobId)
    }
  }
  return { deleted, failed }
}

/**
 * Deletes each rejected video's stored object, store-injected so the loop is
 * unit-testable against a fake store with no S3/MinIO (mirrors backfillStore
 * in ./backfill-store.ts). The `library_objects` row is dropped entirely here
 * — a rejected video is retired, not published, so there is nothing to record.
 */
export async function deleteRejectedObjects(opts: {
  db: Database
  objects: { jobId: string; objectKey: string }[]
  store: ObjectStore
  warn?: (message: string) => void
}): Promise<{ deleted: string[]; failed: string[] }> {
  const deleteStmt = opts.db.prepare('DELETE FROM library_objects WHERE job_id = ?')
  return deleteStoredObjects({
    objects: opts.objects,
    store: opts.store,
    onDeleted: (jobId) => {
      deleteStmt.run(jobId)
    },
    warn: opts.warn ?? (() => {}),
  })
}

export interface RejectAndFreeResult {
  /** Rows actually moved to 'blocked' — an id in the wrong state is not one. */
  rejected: number
  requested: number
  /** Objects the reject found to delete, before any of them were attempted. */
  objects: number
  deleted: string[]
  failed: string[]
  /** Set when storage could not be reached at all; the objects are untouched. */
  storageUnavailable?: string
}

/**
 * "Reject, then free the bytes" — the whole sequence, in the module that owns
 * both halves, so the CLI's `library reject` and the dashboard's
 * `library.reject` action cannot drift on the part that matters.
 *
 * The ordering is load-bearing: the keys are read BEFORE the state change
 * (rejectLibrary does not touch library_objects, but a later reader would see
 * a retired row and could not tell which objects were its), and the deletes
 * run AFTER it and are best-effort — the reject itself must not depend on
 * network reachability, and a storage failure must neither roll it back nor
 * fail it. An object left behind is reported through `warn` (and `failed`),
 * which is how an orphan is found; there is no list() sweep.
 *
 * Callers keep only what is genuinely theirs: where `warn` goes (a console
 * line vs an action notice) and what the outcome means for an exit code.
 * `storeFromEnv` overrides the acquisition for tests against a fake store.
 */
export async function rejectLibraryAndFreeObjects(opts: {
  db: Database
  jobIds: string[]
  warn: (message: string) => void
  storeFromEnv?: () => ObjectStore
}): Promise<RejectAndFreeResult> {
  const objects = libraryObjectKeys(opts.db, opts.jobIds)
  const rejected = rejectLibrary(opts.db, opts.jobIds)
  const base = { rejected, requested: opts.jobIds.length, objects: objects.length }
  if (objects.length === 0) return { ...base, deleted: [], failed: [] }

  let store: ObjectStore
  if (opts.storeFromEnv !== undefined) {
    store = opts.storeFromEnv()
  } else {
    const loaded = await loadStoreFromEnv()
    if ('error' in loaded)
      return { ...base, deleted: [], failed: [], storageUnavailable: loaded.error }
    store = loaded.store
  }
  const outcome = await deleteRejectedObjects({
    db: opts.db,
    objects,
    store,
    warn: opts.warn,
  })
  return { ...base, ...outcome }
}
