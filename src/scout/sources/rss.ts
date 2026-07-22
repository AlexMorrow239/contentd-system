import { parseFeedCandidates } from './feed.js'
import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

export function rssSource(feedUrl: string, fetchImpl: FetchLike = fetch): TrendSource {
  const id = `rss:${new URL(feedUrl).hostname}`
  return {
    id,
    async fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(opts.timeoutMs) })
      if (!res.ok) {
        throw new Error(`rssSource: ${feedUrl} responded ${res.status}`)
      }
      const candidates = parseFeedCandidates(await res.text(), id, `rssSource: ${feedUrl}`)
      // Feeds have no server-side limit parameter — cap client-side to honor
      // the channel's per_source_limit.
      return candidates.slice(0, opts.limit)
    },
  }
}
