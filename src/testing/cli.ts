import { openDb } from '../db/index.js'
import { seedJob, seedLibrary, seedLibraryObject } from './db.js'

/**
 * Fixtures shared by the `cli.*.test.ts` files.
 *
 * These spawn the built CLI as a subprocess, so they cannot use `:memory:` or
 * `vi.stubEnv` — every one of them works through a real db file on disk. That
 * open-a-file-backed-db wrapper is the only thing here: the row SQL itself
 * belongs to ./db.ts, and these delegate to it.
 */

export function countJobs(dbPath: string): number {
  const db = openDb(dbPath)
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }
  db.close()
  return n
}

/**
 * A job + its library row, optionally with a library_objects row whose bytes
 * have already been reclaimed — the shape `library approve` refuses.
 */
export function seedLibraryRow(
  dbPath: string,
  opts: { jobId: string; channel: string; state: string; reclaimed?: boolean },
): void {
  const db = openDb(dbPath)
  seedJob(db, opts.jobId, { channel: opts.channel, topic: 'test topic' })
  seedLibrary(db, opts.jobId, { videoPath: '/tmp/video.mp4', state: opts.state })
  if (opts.reclaimed === true) {
    seedLibraryObject(db, opts.jobId, {
      objectKey: `videos/${opts.channel}/${opts.jobId}.mp4`,
      bytes: 2048,
      etag: 'etag',
      reclaimedAt: '2026-07-20T00:00:00.000Z',
    })
  }
  db.close()
}
