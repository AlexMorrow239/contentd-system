import { BrainrotError } from '../../errors.js'
import { parseFeedCandidates } from './feed.js'
import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Reddit blocks default library user agents; a descriptive UA is the
// documented convention for public feed access.
export const REDDIT_USER_AGENT =
  'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

// Keyless only: the public Atom feed at /r/<sub>/.rss. Reddit 403s hot.json
// unauthenticated from most residential IPs (observed live 2026-07-21) AND
// gates Data API app creation behind manual approval under its Responsible
// Builder Policy, so the feed is the only path an operator can rely on.
// Trade-off: the feed carries no `stickied` flag, so mod stickies reach the
// scorer instead of being skipped — they dedupe, so each costs one scoring
// slot once, and low scores keep them out of the queue.
export function redditSource(subreddit: string, fetchImpl: FetchLike = fetch): TrendSource {
  const id = `reddit:r/${subreddit}`
  return {
    id,
    async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const url = `https://www.reddit.com/r/${subreddit}/.rss`
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': REDDIT_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new BrainrotError(`redditSource: r/${subreddit} responded ${res.status}`, {
          domain: 'scout',
          kind: 'transient',
        })
      }
      // The feed has no server-side limit parameter — cap client-side.
      const entries = parseFeedCandidates(await res.text(), id, `redditSource: r/${subreddit}`)
      return entries.slice(0, limit)
    },
  }
}
