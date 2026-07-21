import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Reddit blocks default library user agents; a descriptive UA is the
// documented convention for unauthenticated JSON listing access.
export const REDDIT_USER_AGENT =
  'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

// Wire shape of GET /r/<sub>/hot.json (public listing endpoint, no auth).
interface RedditChild {
  data: { name: string; title: string; permalink: string; stickied: boolean }
}
interface RedditListing {
  data: { children: RedditChild[] }
}

export function redditSource(subreddit: string, fetchImpl: FetchLike = fetch): TrendSource {
  const id = `reddit:r/${subreddit}`
  return {
    id,
    async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      // raw_json=1 stops reddit HTML-entity-escaping &, <, > inside titles.
      const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': REDDIT_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = (await res.json()) as RedditListing
      const candidates: TrendCandidate[] = []
      for (const child of body.data.children) {
        const post = child.data
        // Stickied posts are mod announcements, not trends.
        if (post.stickied === true) continue
        candidates.push({
          title: post.title,
          url: `https://www.reddit.com${post.permalink}`,
          sourceId: id,
          externalId: post.name,
        })
      }
      return candidates
    },
  }
}
