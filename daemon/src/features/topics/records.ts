import { parseSourcePost } from '../../shared/contracts/source-context.js'
import type { TopicStatus } from './status.js'
import { TopicRow } from './types.js'

export const TOPIC_COLUMNS =
  'id, channel, title, raw_title, source, url, target_url, dedupe_hash, score, reason, status, ' +
  'job_id, body_text, series_key, part_index, part_count, truncated, created_at, source_context_json'

export interface DbTopicRow {
  source_context_json: string | null
  id: number
  channel: string
  title: string
  raw_title: string
  source: string
  url: string
  target_url: string | null
  dedupe_hash: string
  score: number
  reason: string
  status: TopicStatus
  job_id: string | null
  body_text: string | null
  series_key: string | null
  part_index: number | null
  part_count: number | null
  truncated: number
  created_at: string
}

export function toTopicRow(row: DbTopicRow): TopicRow {
  return {
    sourceContext: parseSourcePost(row.source_context_json),
    id: row.id,
    channel: row.channel,
    title: row.title,
    rawTitle: row.raw_title,
    source: row.source,
    url: row.url,
    targetUrl: row.target_url,
    bodyText: row.body_text,
    seriesKey: row.series_key,
    partIndex: row.part_index,
    partCount: row.part_count,
    truncated: row.truncated === 1,
    dedupeHash: row.dedupe_hash,
    score: row.score,
    reason: row.reason,
    status: row.status,
    jobId: row.job_id,
    createdAt: row.created_at,
  }
}
