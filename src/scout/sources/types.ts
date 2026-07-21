import { createHash } from 'node:crypto'

export interface TrendCandidate {
  title: string
  url: string
  sourceId: string
  externalId: string
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
