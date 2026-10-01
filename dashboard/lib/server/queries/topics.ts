import type { Database } from 'better-sqlite3'
import {
  TOPIC_COLUMNS,
  toTopicRow,
  type DbTopicRow,
} from '../../../../daemon/src/features/topics/records.js'
import type { JobAction } from './job-content.js'
import { actionsTableExists } from './actions.js'
export { countTopics } from '../../../../daemon/src/features/topics/queries.js'

export function getTopic(db: Database, id: number) {
  const row = db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = ?`).get(id) as
    DbTopicRow | undefined
  return row ? toTopicRow(row) : null
}

export function topicActions(db: Database, ids: number[]): Map<number, JobAction> {
  const result = new Map<number, JobAction>()
  if (!ids.length || !actionsTableExists(db)) return result
  const rows = db
    .prepare(
      `
    SELECT a.id, a.kind, a.status, a.error, a.notice, CAST(t.value AS INTEGER) AS topicId
    FROM operator_actions a, json_each(
      CASE WHEN json_valid(a.args) THEN
        CASE WHEN a.kind = 'topics.reject' THEN json_extract(a.args, '$.ids')
        ELSE json_array(json_extract(a.args, '$.id')) END
      ELSE '[]' END
    ) t
    WHERE a.kind IN ('topics.reject', 'topics.requeue')
      AND CAST(t.value AS INTEGER) IN (${ids.map(() => '?').join(',')})
    ORDER BY (a.status IN ('pending', 'running')) DESC, a.id DESC
  `,
    )
    .all(...ids) as (JobAction & { topicId: number })[]
  for (const row of rows) if (!result.has(row.topicId)) result.set(row.topicId, row)
  return result
}

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
