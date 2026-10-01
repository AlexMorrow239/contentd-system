import { openDb } from '../src/infra/db/index.js'
import { seedJob, seedLibrary } from './db.js'

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

export function seedLibraryRow(
  dbPath: string,
  opts: { jobId: string; channel: string; state: string },
): void {
  const db = openDb(dbPath)
  seedJob(db, opts.jobId, { channel: opts.channel, topic: 'test topic' })
  seedLibrary(db, opts.jobId, { videoPath: '/tmp/video.mp4', state: opts.state })
  db.close()
}
