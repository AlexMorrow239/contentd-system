import type { Database } from 'better-sqlite3'
import { whereClause } from '../../db/sql.js'
import type { TopicStatus } from '../../scout/topics.js'

/**
 * Distinct channels straight off the topics table, for the filter dropdown.
 * Deliberately separate from the view-level `topicChannels` that used to live
 * in views/topics.ts (which derived channels from an already-filtered array
 * of rows) — that helper collapsed the dropdown to whatever the current
 * filter happened to return. This one is always the full set.
 */
export function topicChannels(db: Database): string[] {
  const rows = db.prepare('SELECT DISTINCT channel FROM topics ORDER BY channel ASC').all() as {
    channel: string
  }[]
  return rows.map((r) => r.channel)
}

// Unbounded by whatever limit listTopics applies, so the view can tell the
// operator "showing 200 of 1,432" rather than truncating silently.
export function countTopics(
  db: Database,
  filter?: { channel?: string; status?: TopicStatus },
): number {
  const { clause, params } = whereClause([
    ['channel = ?', filter?.channel],
    ['status = ?', filter?.status],
  ])
  const row = db.prepare(`SELECT COUNT(*) AS count FROM topics${clause}`).get(...params) as {
    count: number
  }
  return row.count
}
