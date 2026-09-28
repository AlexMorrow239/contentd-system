import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'
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
 * `posts.channel` is denormalized from `jobs.channel`, so the resolution is a
 * fact about this table's own schema rather than something each caller should
 * re-derive: a mismatched channel misfiles the row in every channel-scoped
 * read (pendingInventory, the posting queue, and the digest) with nothing to flag it.
 */
function jobChannel(db: Database, jobId: string): string {
  const row = db.prepare('SELECT channel FROM jobs WHERE id = ?').get(jobId) as
    { channel: string } | undefined
  if (row === undefined) {
    throw new BrainrotError(`no such job: ${jobId}`, { domain: 'job', kind: 'not-found' })
  }
  return row.channel
}

/**
 * Idempotent on the composite primary key. `posted_at` is deliberately NOT
 * refreshed on conflict — the fact being recorded is when the video went out,
 * and a second click correcting a typo'd url must not restamp it. `url` IS
 * overwritten, since the later value is the correction.
 *
 * `channel` is optional and resolved from the job when absent, which is what
 * makes the misfiling above structurally impossible rather than merely
 * commented against. A caller that already holds the channel may still pass
 * it and save the read.
 */
export function markPosted(
  db: Database,
  opts: { jobId: string; channel?: string; platform: Platform; url?: string },
): void {
  const channel = opts.channel ?? jobChannel(db, opts.jobId)
  db.prepare(
    'INSERT INTO posts (job_id, channel, platform, url) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(job_id, platform) DO UPDATE SET url = excluded.url',
  ).run(opts.jobId, channel, opts.platform, opts.url ?? null)
}

/**
 * The "posted to every declared platform" predicate as data, for the readers
 * that must agree on what "consumed" means: `pendingInventory` (the
 * production depth cap), `listPostQueue` (what the operator sees) and the
 * digest's unposted-age column. Each failure mode of a drifted copy is silent
 * — production halts or the digest lies.
 *
 * `alias` is the row alias the correlated subquery joins against (`l` where
 * the caller selects from `library l`), so a caller's own FROM naming stays
 * its business.
 *
 * The comparison and its bound length are part of what is returned rather
 * than appended by the caller, because the empty-`declared` case is not
 * symmetric and cannot be expressed as one count fragment two ways: a channel
 * with no platforms has not decided where to post yet, so nothing is fully
 * posted ('fully' -> `0`) while everything still
 * counts as inventory ('not-fully' -> `1`).
 */
export function fullyPostedClause(
  declared: readonly Platform[],
  opts: { alias: string; match: 'fully' | 'not-fully' },
): { sql: string; params: (Platform | number)[] } {
  if (declared.length === 0) return { sql: opts.match === 'fully' ? '0' : '1', params: [] }
  const placeholders = declared.map(() => '?').join(', ')
  const comparison = opts.match === 'fully' ? '>=' : '<'
  return {
    sql:
      `(SELECT COUNT(*) FROM posts p WHERE p.job_id = ${opts.alias}.job_id ` +
      `AND p.platform IN (${placeholders})) ${comparison} ?`,
    params: [...declared, declared.length],
  }
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
