import type { Database } from 'better-sqlite3'
import type { Platform } from './types.js'

/**
 * The `posts` DAO. A row exists iff the operator posted that video to that
 * platform — there is no status, no attempt count and no error kind, because
 * nothing here talks to a platform. Every failure mode the deleted `publishes`
 * state machine modelled belonged to an upload API this codebase no longer
 * calls.
 *
 * Config-free by the same discipline the old publishes DAO followed: callers
 * pass a channel name and a platform list as plain data, never a ChannelConfig.
 */

/**
 * Idempotent on the composite primary key. `posted_at` is deliberately NOT
 * refreshed on conflict — the fact being recorded is when the video went out,
 * and a second click correcting a typo'd url must not restamp it. `url` IS
 * overwritten, since the later value is the correction.
 */
export function markPosted(
  db: Database,
  opts: { jobId: string; channel: string; platform: Platform; url?: string },
): void {
  db.prepare(
    'INSERT INTO posts (job_id, channel, platform, url) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(job_id, platform) DO UPDATE SET url = excluded.url',
  ).run(opts.jobId, opts.channel, opts.platform, opts.url ?? null)
}

/** True when a row was actually removed — the caller reports "nothing to unmark" from false. */
export function unmarkPosted(db: Database, jobId: string, platform: Platform): boolean {
  return (
    db.prepare('DELETE FROM posts WHERE job_id = ? AND platform = ?').run(jobId, platform).changes >
    0
  )
}

/**
 * Posted platforms per job, each mapped to its url, in ONE grouped read
 * rather than a query per row — the same discipline libraryLinks follows.
 *
 * The url rides along rather than needing a second read: every caller that
 * wants to know WHICH platforms are posted also wants to link to them, and
 * two reads over the same rows is the N+1 this shape exists to avoid.
 *
 * A job with no posts is ABSENT from the map, not present with an empty one.
 */
export function postedPlatforms(
  db: Database,
  jobIds: string[],
): Map<string, Map<Platform, string | null>> {
  const byJob = new Map<string, Map<Platform, string | null>>()
  if (jobIds.length === 0) return byJob
  const placeholders = jobIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT job_id, platform, url FROM posts WHERE job_id IN (${placeholders})`)
    .all(...jobIds) as { job_id: string; platform: string; url: string | null }[]
  for (const row of rows) {
    const perJob = byJob.get(row.job_id) ?? new Map<Platform, string | null>()
    perJob.set(row.platform as Platform, row.url)
    byJob.set(row.job_id, perJob)
  }
  return byJob
}
