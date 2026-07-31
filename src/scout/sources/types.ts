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
  // Submitting account, without reddit's `/u/` prefix. Reddit only — the Atom
  // spec puts <author> at feed level for RSS sources, where it names the
  // publication rather than a person, so it carries no signal there.
  author?: string
  // Whether `author` is a bot account whose posts are never viable topics
  // (e.g. reddit's AutoModerator). Set by the source, same as postKind, so
  // scoutChannel can decide without importing source-specific author logic.
  automated?: boolean
  // Reddit self posts only: the narratable text of the post, extracted from
  // <content>. Absent for link posts and for r/AskReddit-style title-only
  // posts, which is what scoutChannel counts as droppedBodyless.
  body?: string
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
