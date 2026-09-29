import { createHash } from 'node:crypto'
import type { PostKind } from './post-kind.js'

export interface TrendCandidate {
  title: string
  url: string
  sourceId: string
  externalId: string
  // The submission target (the post's `url` — a self post's own permalink, a
  // link post's destination) and what it points at. Undefined for a deleted
  // post, whose `url` is empty; the classifier then fails open to 'link'.
  targetUrl?: string
  postKind?: PostKind
  // Submitting account name; undefined for a deleted account.
  author?: string
  // Whether `author` is a bot account whose posts are never viable topics
  // (e.g. reddit's AutoModerator). Set by the source, same as postKind, so
  // scoutChannel can decide without importing source-specific author logic.
  automated?: boolean
  // Self posts only: the narratable text of the post, extracted from its
  // rendered `selftext_html`. Absent for link posts and for
  // r/AskReddit-style title-only posts, which is what scoutChannel counts as
  // droppedBodyless.
  body?: string
}

export interface TrendSourceFetchOpts {
  time?: import('../../time.js').TimeSource
  limit: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface TrendSource {
  readonly id: string
  fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]>
}

export type FetchLike = typeof globalThis.fetch

// A hung feed must not wedge the scout; the next cron firing is the retry.
export const SOURCE_FETCH_TIMEOUT_MS = 10_000

// Stable per-item identity feeding UNIQUE (channel, dedupe_hash) in topics.
// The newline delimiter keeps the sourceId/externalId concatenation unambiguous.
export function dedupeHash(sourceId: string, externalId: string): string {
  return createHash('sha256').update(`${sourceId}\n${externalId}`).digest('hex')
}
