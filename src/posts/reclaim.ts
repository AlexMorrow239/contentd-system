import type { Database } from 'better-sqlite3'
import { deleteStoredObjects } from '../jobs/library.js'
import type { ObjectStore } from '../storage/types.js'
import { fullyPostedClause } from './posts.js'
import type { Platform } from './types.js'

/** One video's stored object, ready to delete. `bytes` is for reporting only. */
export interface ReclaimableObject {
  jobId: string
  objectKey: string
  bytes: number
}

/**
 * How many objects one produce-lease sweep will reclaim. The old call site
 * (publish-next) passed a literal; the caller is generic now, so the limit
 * gets a named home here instead.
 */
export const RECLAIM_BATCH_LIMIT = 20

/**
 * Videos in this channel that have been posted to every declared platform and
 * whose object is still in the bucket.
 *
 * This was once decided in TypeScript over two reads, because the old settled
 * predicate needed an age clause plus per-(job, platform) aggregates that do
 * not exist as rows for a platform never attempted. "Posted to every declared
 * platform" is a plain row-existence count, so `fullyPostedClause` says it in
 * one correlated subquery — and the scan limit that bounded the old shape has
 * nothing left to bound.
 *
 * `declared` is the channel's target list as plain data, never a
 * ChannelConfig: this module stays config-free. An empty list returns nothing,
 * which is right — a channel with no checklist has no definition of "done",
 * and its videos are retired by discarding them, whose own delete path already
 * frees the bytes. That asymmetry is the clause's own ('fully' -> `0`), so it
 * needs no branch here.
 *
 * `limit` caps the batch so a large accumulated backlog cannot eat the produce
 * lease window; the next tick continues where this one left off. Oldest
 * first, so the rows most likely to be reclaimable are scanned first.
 */
export function reclaimableObjects(
  db: Database,
  opts: { channel: string; declared: readonly Platform[]; limit: number },
): ReclaimableObject[] {
  const posted = fullyPostedClause(opts.declared, { alias: 'l', match: 'fully' })
  return db
    .prepare(
      `SELECT l.job_id AS jobId, lo.object_key AS objectKey, lo.bytes AS bytes
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE j.channel = ? AND lo.reclaimed_at IS NULL
         AND ${posted.sql}
       ORDER BY l.created_at ASC, l.job_id ASC
       LIMIT ?`,
    )
    .all(opts.channel, ...posted.params, opts.limit) as ReclaimableObject[]
}

/**
 * Deletes each object and stamps `reclaimed_at`. The row itself survives as
 * the record of what was stored: `unstoredLibraryJobs` finds backfill
 * candidates by the ABSENCE of a library_objects row, so keeping it is what
 * stops `brainrot library backfill-store` from re-uploading what this deleted.
 *
 * `bytes` totals only what was actually freed, so a partially-failed sweep
 * never over-reports.
 */
export async function reclaimObjects(opts: {
  db: Database
  objects: readonly ReclaimableObject[]
  store: ObjectStore
  warn?: (message: string) => void
}): Promise<{ reclaimed: string[]; failed: string[]; bytes: number }> {
  const stamp = opts.db.prepare(
    "UPDATE library_objects SET reclaimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id = ?",
  )
  const bytesByJob = new Map(opts.objects.map((o) => [o.jobId, o.bytes]))
  let bytes = 0
  const { deleted, failed } = await deleteStoredObjects({
    objects: opts.objects,
    store: opts.store,
    onDeleted: (jobId) => {
      stamp.run(jobId)
      bytes += bytesByJob.get(jobId) ?? 0
    },
    warn: opts.warn ?? (() => {}),
  })
  return { reclaimed: deleted, failed, bytes }
}
