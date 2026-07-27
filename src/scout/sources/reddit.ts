import { BrainrotError } from '../../errors.js'
import { parseFeedCandidates } from './feed.js'
import { classifyTarget } from './post-kind.js'
import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Reddit renders the submission target as an anchor whose text is literally
// "[link]", in both the subreddit feed and a permalink's comment feed. The
// href is the only place the target appears — the entry's own <link> is the
// comments permalink, which is identical for an image post and a text post.
//
// fast-xml-parser has already entity-decoded the <content> body, so this
// matches plain HTML, not the encoded form on the wire.
const LINK_ANCHOR = /href="([^"]+)"[^>]*>\s*\[link\]/

export function redditLinkTarget(contentHtml: string | undefined): string | undefined {
  if (contentHtml === undefined) return undefined
  return LINK_ANCHOR.exec(contentHtml)?.[1]
}

// Reddit blocks default library user agents; a descriptive UA is the
// documented convention for public feed access.
export const REDDIT_USER_AGENT =
  'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

// Reddit's rate limit on the public feed is effectively one request per
// window: a single GET drives `x-ratelimit-remaining` to 0.0, and three
// back-to-back GETs return 429 for all but the first (observed 2026-07-27,
// which also confirmed reddit sends no Retry-After — only x-ratelimit-*).
// ~20s spacing is what actually got through.
//
// So a 429 here is the ordinary case whenever anything else has touched
// reddit recently — another source in the same tick, a `topics prune-media`
// run, a second process — not an outage. Backing off and retrying once is
// what makes a multi-source tick work at all.
//
// This is a retry rather than an unconditional delay between sources on
// purpose: it costs nothing when the budget is free, and adapts when some
// other caller has spent it. A fixed inter-source sleep would pay the full
// delay every tick and still not cover the other-caller case.
export const REDDIT_RETRY_DELAY_MS = 20_000

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RedditFetchOpts {
  fetchImpl: FetchLike
  timeoutMs: number
  retryDelayMs?: number
}

/**
 * GET a reddit feed with the conventional UA, a timeout, and one 429 backoff.
 *
 * Returns the Response as-is — including a still-429 one after the retry — so
 * each caller decides what a failure means: `redditSource` throws a transient
 * scout error, `prune-media` records a skip and moves to the next row.
 */
export async function fetchRedditFeed(url: string, opts: RedditFetchOpts): Promise<Response> {
  const get = (): Promise<Response> =>
    opts.fetchImpl(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  const res = await get()
  if (res.status !== 429) return res
  await sleep(opts.retryDelayMs ?? REDDIT_RETRY_DELAY_MS)
  return get()
}

// Keyless only: the public Atom feed at /r/<sub>/.rss. Reddit 403s hot.json
// unauthenticated from most residential IPs (observed live 2026-07-21) AND
// gates Data API app creation behind manual approval under its Responsible
// Builder Policy, so the feed is the only path an operator can rely on.
export function redditSource(
  subreddit: string,
  fetchImpl: FetchLike = fetch,
  // Test seam only: production uses the measured backoff.
  opts: { retryDelayMs?: number } = {},
): TrendSource {
  const id = `reddit:r/${subreddit}`
  return {
    id,
    async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const url = `https://www.reddit.com/r/${subreddit}/.rss`
      const res = await fetchRedditFeed(url, {
        fetchImpl,
        timeoutMs,
        retryDelayMs: opts.retryDelayMs,
      })
      if (!res.ok) {
        throw new BrainrotError(`redditSource: r/${subreddit} responded ${res.status}`, {
          domain: 'scout',
          kind: 'transient',
        })
      }
      // The feed has no server-side limit parameter — cap client-side.
      const entries = parseFeedCandidates(await res.text(), id, `redditSource: r/${subreddit}`)
      // Annotate only — dropping is the scout's call, so it can count what it
      // dropped (a source returning a filtered array cannot report that).
      return entries.slice(0, limit).map((candidate) => {
        const targetUrl = redditLinkTarget(candidate.contentHtml)
        return { ...candidate, targetUrl, postKind: classifyTarget(targetUrl) }
      })
    },
  }
}
