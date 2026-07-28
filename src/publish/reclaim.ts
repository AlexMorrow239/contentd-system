import type { Database } from 'better-sqlite3'
import { deleteStoredObjects } from '../jobs/library.js'
import type { ObjectStore } from '../storage/types.js'
import { contentionFacts, isAged, isFullySettled, legFactsByJob } from './settled.js'
import type { Platform } from './types.js'

/** One video's stored object, ready to delete. `bytes` is for reporting only. */
export interface ReclaimableObject {
  jobId: string
  objectKey: string
  bytes: number
}

interface DbCandidateRow {
  jobId: string
  objectKey: string
  bytes: number
  createdAt: string
}

/**
 * Videos in this channel whose every declared platform has a settled leg and
 * whose object is still in the bucket.
 *
 * Settledness is decided in TypeScript (./settled.ts) rather than SQL, and
 * deliberately: the age clause makes the predicate depend on a per-row
 * comparison AND on per-(job, platform) aggregates that do not exist as rows
 * for a platform never attempted. Expressing "count the declared platforms
 * with no row at all" in SQL means a second correlated subquery whose bind
 * order is easy to get silently wrong. The scan is bounded by
 * RECLAIM_SCAN_LIMIT rows (oldest first), so the two-read-then-filter shape —
 * and the `IN (...)` legFactsByJob builds from its job ids — costs a fixed
 * ceiling no matter how many objects a channel accumulates. Real inventory is
 * a few dozen rows; the limit only exists so a pathological database cannot
 * bind thousands of ids into one statement. Oldest-first means the rows most
 * likely to be settled are always the ones scanned.
 *
 * `declared` is the channel's target list as plain data, never a
 * ChannelConfig: this module stays config-free like the publishes DAO. An
 * empty list returns nothing (isFullySettled), which is right — a channel
 * with no [publish] table retires its videos through `library reject`, whose
 * own delete path already frees the bytes.
 *
 * `limit` caps the batch so a large accumulated backlog cannot eat the publish
 * lease window; the next tick continues where this one left off.
 */
export const RECLAIM_SCAN_LIMIT = 500

export function reclaimableObjects(
  db: Database,
  opts: {
    channel: string
    declared: readonly Platform[]
    createdAfter: string
    limit: number
  },
): ReclaimableObject[] {
  if (opts.declared.length === 0) return []
  const rows = db
    .prepare(
      `SELECT l.job_id AS jobId, lo.object_key AS objectKey, lo.bytes AS bytes,
              l.created_at AS createdAt
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE j.channel = ? AND lo.reclaimed_at IS NULL
       ORDER BY l.created_at ASC, l.job_id ASC
       LIMIT ?`,
    )
    .all(opts.channel, RECLAIM_SCAN_LIMIT) as DbCandidateRow[]
  if (rows.length === 0) return []

  const legs = legFactsByJob(
    db,
    rows.map((r) => r.jobId),
  )
  // One channel-wide read, reused for every row: ageing out requires evidence
  // that a DIFFERENT job published after this video was produced (./settled.ts).
  const contention = contentionFacts(db, opts.channel)
  const out: ReclaimableObject[] = []
  for (const row of rows) {
    const settled = isFullySettled({
      declared: opts.declared,
      legs: legs.get(row.jobId) ?? [],
      aged: isAged(contention, row, opts.createdAfter),
    })
    if (!settled) continue
    out.push({ jobId: row.jobId, objectKey: row.objectKey, bytes: row.bytes })
    if (out.length === opts.limit) break
  }
  return out
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
