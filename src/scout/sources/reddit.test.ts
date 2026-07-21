import { afterEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash } from './types.js'
import { REDDIT_USER_AGENT, redditSource } from './reddit.js'

afterEach(() => {
  vi.restoreAllMocks()
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

// Trimmed /r/space/hot.json listing: one stickied mod post, two real posts.
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

// Injectable fetch: captures every call, answers with one canned JSON response.
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl, calls }
}

describe('redditSource', () => {
  it('GETs hot.json with the descriptive UA and a timeout signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { impl, calls } = fakeFetch(200, HOT_FIXTURE)
    const source = redditSource('space', impl)
    expect(source.id).toBe('reddit:r/space')
    await source.fetch({ limit: 25, timeoutMs: 9_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://www.reddit.com/r/space/hot.json?limit=25&raw_json=1')
    const init = calls[0].init!
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(REDDIT_USER_AGENT)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(9_000)
  })

  it('maps posts to TrendCandidates and skips stickied posts', async () => {
    const { impl } = fakeFetch(200, HOT_FIXTURE)
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

  it('throws with the HTTP status on a non-2xx response', async () => {
    const { impl } = fakeFetch(429, { message: 'Too Many Requests' })
    const source = redditSource('space', impl)
    await expect(source.fetch({ limit: 25, timeoutMs: 10_000 })).rejects.toThrow(
      /r\/space responded 429/,
    )
  })
})
