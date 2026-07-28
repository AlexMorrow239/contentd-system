import type { StoreArtifact } from '../stages/store.js'
import type { Database } from 'better-sqlite3'
import { errorMessage } from '../errors.js'
import type { ObjectStore } from '../storage/types.js'

export type LibraryState = 'ready' | 'needs-review' | 'published' | 'blocked'

/**
 * The library states a video can still be published FROM, as a SQL list ready
 * to interpolate into an `IN (...)`. 'published' belongs here because a row
 * flips to it on the FIRST platform that takes the video, while the channel's
 * other declared platforms have yet to publish it — so "already published
 * somewhere" must not remove it from the pool. Interpolated from one
 * definition rather than spelled out at each query, so adding a state cannot
 * update some call sites and miss others.
 */
export const PUBLISHABLE_LIBRARY_STATES = "'ready', 'published'"

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

// Publish gate (design spec decision 4): only needs-review rows can be
// promoted into the publish pool, and only into 'ready'. The status guard
// makes this idempotent and blind to ids in the wrong state — the returned
// count is what actually changed, which the CLI reports against jobIds.length.
export function approveLibrary(db: Database, jobIds: string[]): number {
  if (jobIds.length === 0) return 0
  const placeholders = jobIds.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE library SET state = 'ready' WHERE job_id IN (${placeholders}) AND state = 'needs-review'`,
    )
    .run(...jobIds).changes
}

// Reject retires a row from any of three states: needs-review (never
// promoted), ready (pulled from the pool / an attempt-capped video), or
// published (design spec decision 10) — a video already live on one
// platform can be pulled out of another platform's queue after the fact,
// since decision 1 keeps 'published' rows eligible everywhere until each
// platform has its own done row.
export function rejectLibrary(db: Database, jobIds: string[]): number {
  if (jobIds.length === 0) return 0
  const placeholders = jobIds.map(() => '?').join(', ')
  return db
    .prepare(
      `UPDATE library SET state = 'blocked' WHERE job_id IN (${placeholders}) AND state IN ('needs-review', 'ready', 'published')`,
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
 * straight into the publish pool, where a missing object is an Instagram
 * failure, so it is worth uploading and worth reporting before then.
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
 * Records where a finished video landed in object storage. Idempotent on
 * job_id, which both callers depend on: the final gate's re-runnable window
 * (runJob, ./runner.ts) upserts the same artifact on every resume, and the
 * operator backfill (./backfill-store.ts) may be re-run over rows it already
 * uploaded. Synchronous, so it composes inside runJob's db.transaction().
 */
export function upsertLibraryObject(db: Database, jobId: string, object: StoreArtifact): void {
  db.prepare(
    'INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(job_id) DO UPDATE SET object_key=excluded.object_key, bytes=excluded.bytes, etag=excluded.etag',
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
 * Deletes each rejected video's stored object, store-injected so the loop is
 * unit-testable against a fake store with no S3/MinIO (mirrors backfillStore
 * in ./backfill-store.ts). One bad key must not stop the rest: each delete is
 * its own try/catch, and the `library_objects` row is cleared only after its
 * delete succeeds, so a failure leaves the row in place as the orphan marker
 * the CLI's warning line points the operator at.
 */
export async function deleteRejectedObjects(opts: {
  db: Database
  objects: { jobId: string; objectKey: string }[]
  store: ObjectStore
  warn?: (message: string) => void
}): Promise<{ deleted: string[]; failed: string[] }> {
  const warn = opts.warn ?? (() => {})
  const deleteStmt = opts.db.prepare('DELETE FROM library_objects WHERE job_id = ?')

  const deleted: string[] = []
  const failed: string[] = []
  for (const o of opts.objects) {
    try {
      await opts.store.delete(o.objectKey)
      deleteStmt.run(o.jobId)
      deleted.push(o.jobId)
    } catch (err) {
      warn(`could not delete ${o.objectKey} for ${o.jobId} (left orphaned): ${errorMessage(err)}`)
      failed.push(o.jobId)
    }
  }
  return { deleted, failed }
}
