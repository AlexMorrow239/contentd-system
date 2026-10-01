import { type SourcePost } from '../../shared/contracts/source-context.js'
import type { TopicStatus } from './status.js'

export interface TopicRow {
  sourceContext: SourcePost | null
  id: number
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  // The submission target: what the post points at, as opposed to `url`,
  // which is its comments permalink. Null for RSS items (no submission) and
  // for rows written before the column existed.
  targetUrl: string | null
  /**
   * Story mode only — null on topic-mode rows. `bodyText` is the narratable
   * text of THIS part; `seriesKey` groups one post's parts; `partIndex` is
   * 1-based.
   */
  bodyText: string | null
  seriesKey: string | null
  partIndex: number | null
  partCount: number | null
  /** Whether the series this part belongs to was cut short by max_parts. */
  truncated: boolean
  dedupeHash: string
  score: number
  reason: string
  status: TopicStatus
  jobId: string | null
  createdAt: string
}

// Scorer output lands as 'candidate' (score >= SCOUT_MIN_SCORE) or 'rejected';
// the operator lifecycle states are reached only via the transition fns in mutations.ts.
export interface NewTopic {
  sourceContext?: SourcePost
  channel: string
  title: string
  rawTitle: string
  source: string
  url: string
  targetUrl?: string
  bodyText?: string
  seriesKey?: string
  partIndex?: number
  partCount?: number
  truncated?: boolean
  dedupeHash: string
  score: number
  reason: string
  status: 'candidate' | 'rejected'
}

export type RequeueOutcome =
  | { ok: true }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'not-claimed'; status: TopicStatus }
  | { ok: false; reason: 'job-active'; jobId: string; jobStatus: string }

export interface TopicFilter {
  channel?: string
  status?: TopicStatus
  q?: string
}
