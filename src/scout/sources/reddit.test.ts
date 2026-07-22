import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash, type FetchLike } from './types.js'
import { REDDIT_USER_AGENT, redditSource, resetRedditTokenCache } from './reddit.js'

beforeEach(() => {
  // The default contract for every test in this file is the unauthenticated
  // public endpoint: clear any real creds the runner env carries, and reset
  // the module-level token cache so OAuth tests never leak into each other.
  vi.stubEnv('REDDIT_CLIENT_ID', undefined)
  vi.stubEnv('REDDIT_CLIENT_SECRET', undefined)
  resetRedditTokenCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('dedupeHash', () => {
  it('is the sha256 hex of sourceId + newline + externalId', () => {
    // printf 'reddit:r/space\nt3_abc' | shasum -a 256
    expect(dedupeHash('reddit:r/space', 't3_abc')).toBe(
      '543177266c3fc519b4f49513548b8109762f1e86010a941570d86885ac5b0f0a',
    )
  })

  it('is stable across calls, distinct across items, and lowercase hex', () => {
    expect(dedupeHash('rss:example.com', 'guid-1')).toBe(dedupeHash('rss:example.com', 'guid-1'))
    expect(dedupeHash('rss:example.com', 'guid-1')).not.toBe(
      dedupeHash('rss:example.com', 'guid-2'),
    )
    expect(dedupeHash('rss:example.com', 'guid-1')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('SOURCE_FETCH_TIMEOUT_MS', () => {
  it('defaults to 10 seconds', () => {
    expect(SOURCE_FETCH_TIMEOUT_MS).toBe(10_000)
  })
})

// Trimmed oauth.reddit.com hot listing (the authenticated JSON path): one
// stickied mod post, two real posts.
const HOT_FIXTURE = {
  kind: 'Listing',
  data: {
    children: [
      {
        kind: 't3',
        data: {
          name: 't3_sticky',
          title: 'Monthly launch discussion thread',
          permalink: '/r/space/comments/sticky/monthly/',
          stickied: true,
        },
      },
      {
        kind: 't3',
        data: {
          name: 't3_abc',
          title: 'JWST finds water ice in a protoplanetary disk',
          permalink: '/r/space/comments/abc/jwst_finds_water_ice/',
          stickied: false,
        },
      },
      {
        kind: 't3',
        data: {
          name: 't3_def',
          title: 'Starship booster catch, third attempt',
          permalink: '/r/space/comments/def/starship_booster_catch/',
          stickied: false,
        },
      },
    ],
  },
}

// Trimmed /r/space/.rss — the shape reddit actually serves (verified live
// 2026-07-22): Atom entries whose <id> is the t3_ fullname the JSON API
// reports as data.name, so externalId matches across both paths.
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>/r/space/.rss</id>
  <title>/r/space: news, articles and discussion</title>
  <link rel="self" href="https://www.reddit.com/r/space/.rss" type="application/atom+xml" />
  <link rel="alternate" href="https://www.reddit.com/r/space/" type="text/html" />
  <entry>
    <author><name>/u/someone</name></author>
    <id>t3_abc</id>
    <link href="https://www.reddit.com/r/space/comments/abc/jwst_finds_water_ice/" />
    <title>JWST finds water ice in a protoplanetary disk</title>
    <updated>2026-07-22T10:00:00+00:00</updated>
  </entry>
  <entry>
    <author><name>/u/other</name></author>
    <id>t3_def</id>
    <link href="https://www.reddit.com/r/space/comments/def/starship_booster_catch/" />
    <title>Starship booster catch, third attempt</title>
    <updated>2026-07-22T11:00:00+00:00</updated>
  </entry>
</feed>`

// Injectable fetch for the keyless feed path: captures every call, answers
// with one canned XML body. The OAuth path uses routedFetch (JSON) below.
function fakeTextFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(body, { status, headers: { 'content-type': 'application/atom+xml' } })
  }
  return { impl, calls }
}

describe('redditSource', () => {
  it('GETs the public .rss feed with the descriptive UA and a timeout signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { impl, calls } = fakeTextFetch(200, RSS_FIXTURE)
    const source = redditSource('space', impl)
    expect(source.id).toBe('reddit:r/space')
    await source.fetch({ limit: 25, timeoutMs: 9_000 })
    expect(calls).toHaveLength(1)
    // reddit 403s hot.json unauthenticated and gates Data API app creation
    // behind manual approval, so the keyless path reads the public feed.
    expect(calls[0].url).toBe('https://www.reddit.com/r/space/.rss')
    const init = calls[0].init!
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(REDDIT_USER_AGENT)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(9_000)
  })

  it('maps feed entries to TrendCandidates keyed by the t3_ fullname', async () => {
    const { impl } = fakeTextFetch(200, RSS_FIXTURE)
    const source = redditSource('space', impl)
    const candidates = await source.fetch({ limit: 25, timeoutMs: 10_000 })
    expect(candidates).toEqual([
      {
        title: 'JWST finds water ice in a protoplanetary disk',
        url: 'https://www.reddit.com/r/space/comments/abc/jwst_finds_water_ice/',
        sourceId: 'reddit:r/space',
        externalId: 't3_abc',
      },
      {
        title: 'Starship booster catch, third attempt',
        url: 'https://www.reddit.com/r/space/comments/def/starship_booster_catch/',
        sourceId: 'reddit:r/space',
        externalId: 't3_def',
      },
    ])
  })

  it('caps feed entries at the requested limit', async () => {
    const { impl } = fakeTextFetch(200, RSS_FIXTURE)
    const candidates = await redditSource('space', impl).fetch({ limit: 1, timeoutMs: 10_000 })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].externalId).toBe('t3_abc')
  })

  it('throws with the HTTP status on a non-2xx feed response', async () => {
    const { impl } = fakeTextFetch(429, '')
    const source = redditSource('space', impl)
    await expect(source.fetch({ limit: 25, timeoutMs: 10_000 })).rejects.toThrow(
      /r\/space responded 429/,
    )
  })

  it('skips entries missing a title or an id, and an entryless feed yields []', async () => {
    const { impl } = fakeTextFetch(
      200,
      `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><id>t3_x1</id><link href="https://www.reddit.com/x1/" /></entry>
        <entry><title>No id and no link</title></entry>
        <entry>
          <id>t3_ok</id>
          <link href="https://www.reddit.com/r/space/comments/ok/c/" />
          <title>Intact post</title>
        </entry>
      </feed>`,
    )
    expect(await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })).toEqual([
      {
        title: 'Intact post',
        url: 'https://www.reddit.com/r/space/comments/ok/c/',
        sourceId: 'reddit:r/space',
        externalId: 't3_ok',
      },
    ])

    const empty = fakeTextFetch(200, '<feed xmlns="http://www.w3.org/2005/Atom"></feed>')
    expect(await redditSource('space', empty.impl).fetch({ limit: 25, timeoutMs: 10_000 })).toEqual(
      [],
    )
  })

  it('throws when the response is not a feed at all', async () => {
    // e.g. reddit serving an HTML interstitial instead of the feed
    const { impl } = fakeTextFetch(200, '<html><body>over 18?</body></html>')
    await expect(
      redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 }),
    ).rejects.toThrow(/not a recognized RSS 2.0 or Atom feed/)
  })

  it('rejects when the fetch times out, so the orchestrator can isolate it', async () => {
    const impl: FetchLike = () =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const source = redditSource('space', impl)
    await expect(source.fetch({ limit: 25, timeoutMs: 10 })).rejects.toThrow(/timeout/i)
  })
})

describe('redditSource app-only OAuth', () => {
  // Multi-endpoint stub: routes by URL prefix so one impl serves the token
  // POST and the oauth listing GET in order.
  function routedFetch(routes: Record<string, { status: number; body: unknown }>) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const impl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      const route = Object.entries(routes).find(([prefix]) => String(input).startsWith(prefix))
      if (!route) throw new Error(`unrouted fetch: ${String(input)}`)
      return new Response(JSON.stringify(route[1].body), {
        status: route[1].status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return { impl, calls }
  }

  it('skips stickied and malformed children in the oauth JSON listing', async () => {
    vi.stubEnv('REDDIT_CLIENT_ID', 'test-id')
    vi.stubEnv('REDDIT_CLIENT_SECRET', 'test-secret')
    const { impl } = routedFetch({
      'https://www.reddit.com/api/v1/access_token': {
        status: 200,
        body: { access_token: 'tok-1', expires_in: 3600 },
      },
      'https://oauth.reddit.com/': {
        status: 200,
        body: {
          data: {
            children: [
              { kind: 't3' }, // no data object at all
              {
                kind: 't3',
                data: { name: 't3_x1', permalink: '/r/space/comments/x1/a/', stickied: false },
              }, // no title
              {
                kind: 't3',
                data: {
                  name: 't3_sticky',
                  title: 'Monthly thread',
                  permalink: '/r/space/comments/s/m/',
                  stickied: true,
                },
              },
              {
                kind: 't3',
                data: {
                  name: 't3_ok',
                  title: 'Intact post',
                  permalink: '/r/space/comments/ok/c/',
                  stickied: false,
                },
              },
            ],
          },
        },
      },
    })
    expect(await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })).toEqual([
      {
        title: 'Intact post',
        url: 'https://www.reddit.com/r/space/comments/ok/c/',
        sourceId: 'reddit:r/space',
        externalId: 't3_ok',
      },
    ])
  })

  it('tokens up once and queries oauth.reddit.com with the bearer', async () => {
    vi.stubEnv('REDDIT_CLIENT_ID', 'test-id')
    vi.stubEnv('REDDIT_CLIENT_SECRET', 'test-secret')
    const { impl, calls } = routedFetch({
      'https://www.reddit.com/api/v1/access_token': {
        status: 200,
        body: { access_token: 'tok-1', expires_in: 3600 },
      },
      'https://oauth.reddit.com/': { status: 200, body: HOT_FIXTURE },
    })
    const source = redditSource('space', impl)
    const first = await source.fetch({ limit: 25, timeoutMs: 10_000 })
    expect(first.map((c) => c.externalId)).toEqual(['t3_abc', 't3_def'])

    const tokenCall = calls[0]
    expect(tokenCall.url).toBe('https://www.reddit.com/api/v1/access_token')
    expect(tokenCall.init?.method).toBe('POST')
    const tokenHeaders = tokenCall.init?.headers as Record<string, string>
    expect(tokenHeaders.Authorization).toBe(
      `Basic ${Buffer.from('test-id:test-secret').toString('base64')}`,
    )
    expect(tokenHeaders['User-Agent']).toBe(REDDIT_USER_AGENT)
    expect(tokenCall.init?.body).toBe('grant_type=client_credentials')

    const listingCall = calls[1]
    expect(listingCall.url).toBe('https://oauth.reddit.com/r/space/hot?limit=25&raw_json=1')
    const listingHeaders = listingCall.init?.headers as Record<string, string>
    expect(listingHeaders.Authorization).toBe('Bearer tok-1')
    expect(listingHeaders['User-Agent']).toBe(REDDIT_USER_AGENT)

    // cached: a second fetch reuses the token — still exactly one token call
    await source.fetch({ limit: 25, timeoutMs: 10_000 })
    expect(calls.filter((c) => c.url.includes('access_token'))).toHaveLength(1)
  })

  it('a failing token endpoint rejects with its status', async () => {
    vi.stubEnv('REDDIT_CLIENT_ID', 'test-id')
    vi.stubEnv('REDDIT_CLIENT_SECRET', 'test-secret')
    const { impl } = routedFetch({
      'https://www.reddit.com/api/v1/access_token': { status: 401, body: {} },
    })
    const source = redditSource('space', impl)
    await expect(source.fetch({ limit: 25, timeoutMs: 10_000 })).rejects.toThrow(
      /token endpoint responded 401/,
    )
  })

  it('without creds no token call is made and the public feed is used', async () => {
    const { impl, calls } = fakeTextFetch(200, RSS_FIXTURE)
    await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://www.reddit.com/r/space/.rss')
  })
})
