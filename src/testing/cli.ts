import path from 'node:path'
import { openDb } from '../db/index.js'
import { tmpDir } from './tmp.js'

/**
 * Fixtures shared by the `cli.*.test.ts` files.
 *
 * These spawn the built CLI as a subprocess, so they cannot use `:memory:` or
 * `vi.stubEnv` — every one of them works through a real db file on disk.
 */

/** A path in a fresh temp dir for the CLI to create its db at. */
export function tmpDbPath(): string {
  return path.join(tmpDir('brainrot-cli-'), 'brainrot.db')
}

export function countJobs(dbPath: string): number {
  const db = openDb(dbPath)
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }
  db.close()
  return n
}

/** A job + its library row + one publishes row, the shape `publish`/`publishes` read. */
export function seedPublishRow(
  dbPath: string,
  opts: {
    jobId: string
    channel: string
    day: string
    seq: number
    status: string
    postId?: string | null
    url?: string | null
    error?: string | null
    errorKind?: string | null
    attempt?: number
  },
): void {
  const db = openDb(dbPath)
  db.prepare(
    "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', 'test topic', 'done')",
  ).run(opts.jobId, opts.channel)
  db.prepare(
    "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, '/tmp/video.mp4', '{}', 'ready')",
  ).run(opts.jobId)
  db.prepare(
    `INSERT INTO publishes (job_id, platform, channel, day, seq, status, post_id, url, error, error_kind, attempt)
     VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.jobId,
    opts.channel,
    opts.day,
    opts.seq,
    opts.status,
    opts.postId ?? null,
    opts.url ?? null,
    opts.error ?? null,
    opts.errorKind ?? null,
    opts.attempt ?? 1,
  )
  db.close()
}
