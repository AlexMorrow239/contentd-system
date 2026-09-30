import type { Database } from 'better-sqlite3'
export { countTopics } from '../../../../daemon/src/scout/topics.js'

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
