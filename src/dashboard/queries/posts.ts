import type { Database } from 'better-sqlite3'
import type { Platform } from '../../posts/types.js'

export interface PostLogEntry {
  jobId: string
  channel: string
  platform: Platform
  topic: string
  url: string | null
  postedAt: string
}

// Joined here rather than layering on the DAO: the log needs
// the topic, which lives on `jobs`, and one query is simpler than a grouped
// re-read for a page that renders a flat table.
export function listPostLog(db: Database, opts?: { limit?: number }): PostLogEntry[] {
  return db
    .prepare(
      `SELECT p.job_id AS jobId, p.channel AS channel, p.platform AS platform,
              j.topic AS topic, p.url AS url, p.posted_at AS postedAt
       FROM posts p JOIN jobs j ON j.id = p.job_id
       ORDER BY p.posted_at DESC, p.job_id DESC, p.platform ASC
       LIMIT ?`,
    )
    .all(opts?.limit ?? 200) as PostLogEntry[]
}
