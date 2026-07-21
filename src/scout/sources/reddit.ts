import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Reddit blocks default library user agents; a descriptive UA is the
// documented convention for unauthenticated JSON listing access.
export const REDDIT_USER_AGENT =
  'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

// Wire shape of the hot listing (same for the public and oauth endpoints).
// Every field is optional on the wire: a child that cannot yield a complete
// TrendCandidate is skipped, never crashed on.
interface RedditChild {
  data?: { name?: string; title?: string; permalink?: string; stickied?: boolean }
}
interface RedditListing {
  data?: { children?: RedditChild[] }
}

// App-only OAuth (script app, client_credentials grant): reddit 403s
// unauthenticated JSON listings from most residential IPs since the 2023 API
// changes (observed live 2026-07-21), so when REDDIT_CLIENT_ID and
// REDDIT_CLIENT_SECRET are set we token up and read oauth.reddit.com instead.
// Absent creds falls back to the public endpoint. The cache is module-level so
// one short-lived scout process tokens up once across all channels/sources;
// app-only tokens live ~1h, far beyond any run.
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
let cachedToken: { value: string; expiresAt: number } | null = null

// Test seam only: clears the module-level token cache between cases.
export function resetRedditTokenCache(): void {
  cachedToken = null
}

async function appOnlyToken(fetchImpl: FetchLike, timeoutMs: number): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID
  const secret = process.env.REDDIT_CLIENT_SECRET
  if (!id || !secret) return null
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`redditSource: token endpoint responded ${res.status}`)
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) {
    throw new Error('redditSource: token response carried no access_token')
  }
  // 60s slack under the advertised lifetime so a token is never used at its edge.
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (Math.max(120, body.expires_in ?? 3600) - 60) * 1000,
  }
  return cachedToken.value
}

export function redditSource(subreddit: string, fetchImpl: FetchLike = fetch): TrendSource {
  const id = `reddit:r/${subreddit}`
  return {
    id,
    async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const token = await appOnlyToken(fetchImpl, timeoutMs)
      // raw_json=1 stops reddit HTML-entity-escaping &, <, > inside titles.
      const url = token
        ? `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}&raw_json=1`
        : `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`
      const headers: Record<string, string> = { 'User-Agent': REDDIT_USER_AGENT }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        throw new Error(`redditSource: r/${subreddit} responded ${res.status}`)
      }
      const body = (await res.json()) as RedditListing
      const candidates: TrendCandidate[] = []
      for (const child of body.data?.children ?? []) {
        const post = child.data
        // Stickied posts are mod announcements, not trends.
        if (!post || post.stickied === true) continue
        if (!post.name || !post.title || !post.permalink) continue
        candidates.push({
          title: post.title,
          url: `https://www.reddit.com${post.permalink}`,
          sourceId: id,
          externalId: post.name,
        })
      }
      // Hard cap regardless of what the listing returned: the Σ per_source_limit
      // prompt bound (spec §8) must not rest on reddit honoring its query param.
      return candidates.slice(0, limit)
    },
  }
}
