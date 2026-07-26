import { existsSync, readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { objectKeyFor } from '../stages/store.js'
import type { ObjectStore } from '../storage/types.js'
import { upsertLibraryObject } from './library.js'

/**
 * Uploads finished videos produced before object storage existed. Without it,
 * every library row predating this plan is YouTube-only — publishMedia.url()
 * has nothing to presign, so Instagram fails them as 'rejected'.
 *
 * Operator command, run outside the publish lease like the others. Rows whose
 * local file has already been reclaimed are unrecoverable and reported as
 * skipped rather than failing the whole run.
 *
 * `library reject` deletes both the R2 object and the `library_objects` row,
 * which would otherwise look identical to a pre-storage row missing its
 * upload. The `state != 'blocked'` guard keeps this command from resurrecting
 * a video an operator deliberately deleted.
 */
export async function backfillStore(opts: {
  db: Database
  store: ObjectStore
}): Promise<{ uploaded: string[]; skipped: string[] }> {
  const rows = opts.db
    .prepare(
      `SELECT l.job_id AS jobId, l.video_path AS videoPath, j.channel AS channel
       FROM library l
       JOIN jobs j ON j.id = l.job_id
       LEFT JOIN library_objects lo ON lo.job_id = l.job_id
       WHERE lo.job_id IS NULL AND l.state != 'blocked'
       ORDER BY l.job_id`,
    )
    .all() as { jobId: string; videoPath: string; channel: string }[]

  const uploaded: string[] = []
  const skipped: string[] = []
  for (const row of rows) {
    if (!existsSync(row.videoPath)) {
      skipped.push(row.jobId)
      continue
    }
    const bytes = readFileSync(row.videoPath)
    const objectKey = objectKeyFor(row.channel, row.jobId)
    const put = await opts.store.put(objectKey, bytes, 'video/mp4')
    upsertLibraryObject(opts.db, row.jobId, { objectKey, bytes: put.bytes, etag: put.etag })
    uploaded.push(row.jobId)
  }
  return { uploaded, skipped }
}
