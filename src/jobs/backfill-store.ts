import { existsSync, readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { objectKeyFor } from '../stages/store.js'
import type { ObjectStore } from '../storage/types.js'
import { unstoredLibraryJobs, upsertLibraryObject } from './library.js'

/**
 * Uploads finished videos produced before object storage existed. Without it,
 * every library row predating this plan has nothing in the bucket at all —
 * once its local runs/ file is cleaned up, the operator has no way to
 * download it for manual posting to any platform.
 *
 * Operator command, run outside the publish lease like the others. Rows whose
 * local file has already been reclaimed are unrecoverable and reported as
 * skipped rather than failing the whole run.
 *
 * The set it uploads is `unstoredLibraryJobs` (./library.ts), shared with the
 * digest line that tells the operator to run this command — so the count
 * reported and the count acted on cannot drift apart.
 */
export async function backfillStore(opts: {
  db: Database
  store: ObjectStore
}): Promise<{ uploaded: string[]; skipped: string[] }> {
  const rows = unstoredLibraryJobs(opts.db)

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
