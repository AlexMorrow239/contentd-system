import { createHash } from 'node:crypto'
import type { PostKind } from './post-kind.js'

export interface TrendCandidate {
  title: string
  url: string
  sourceId: string
  externalId: string
  // Reddit only: the submission target (the feed's `[link]` anchor) and what
  // it points at. Optional because rssSource has neither — an RSS item is
  // already an article, so it renders to the scorer with no annotation.
  targetUrl?: string
  postKind?: PostKind
  // Raw Atom <content> body, carried so the reddit source can interpret it.
  // Not consumed downstream of redditSource.
  contentHtml?: string
}

export interface TrendSourceFetchOpts {
  limit: number
  timeoutMs: number
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
