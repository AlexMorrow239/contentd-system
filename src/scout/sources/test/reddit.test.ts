import { afterEach, describe, expect, it, vi } from 'vitest'
import { classify } from '../../../errors.js'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash, type FetchLike } from '../types.js'
import {
  ARCTIC_SHIFT_BASE_URL,
  REDDIT_USER_AGENT,
  fetchRedditFeed,
  isAutomatedAuthor,
  redditSource,
} from '../reddit.js'
import {
  ARTICLE_TARGET,
  CROSSPOST_PATH,
  GALLERY_TARGET,
  IMAGE_TARGET,
  POST_KIND_SEARCH_JSON,
  SELF_TARGET,
} from './_post-kind.fixtures.js'
import { SELF_POST_CONTENT } from '../../../stories/_stories.fixtures.js'
import { arcticShiftError, arcticShiftJson } from '../../../testing/arctic-shift.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// Injectable fetch: captures every call, answers with one canned body.
function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init })
    return new Response(body, { status })
  }
  return { impl, calls }
}

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

describe('fetchRedditFeed', () => {
  it('sends the descriptive UA and a timeout signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { impl, calls } = fakeFetch(200, 'ok')

    await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 9_000,
      retryDelayMs: 0,
    })

    const init = calls[0].init!
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(REDDIT_USER_AGENT)
    expect(timeoutSpy).toHaveBeenCalledWith(9_000)
  })

  it('retries once after a 429 and returns the retry response', async () => {
    const calls: unknown[] = []
    const impl: FetchLike = async (input) => {
      calls.push(input)
      return calls.length === 1
        ? new Response('', { status: 429 })
        : new Response('ok', { status: 200 })
    }

    const res = await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('gives up after one retry rather than grinding', async () => {
    const { impl, calls } = fakeFetch(429, '')

    const res = await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })

    expect(res.status).toBe(429)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a non-429 failure', async () => {
    const { impl, calls } = fakeFetch(404, '')

    const res = await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })

    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })
})

const JWST_TARGET = 'https://www.nasa.gov/missions/webb/water-ice/'
const BOOSTER_PERMALINK = 'https://www.reddit.com/r/space/comments/def/starship_booster_catch/'

const SEARCH_JSON = arcticShiftJson([
  { id: 'abc', title: 'JWST finds water ice in a protoplanetary disk', target: JWST_TARGET },
  {
    id: 'def',
    title: 'Starship booster catch, third attempt',
    author: 'other',
    target: BOOSTER_PERMALINK,
  },
])

async function fetchAll(
  impl: FetchLike,
  subreddit = 'space',
  limit = 25,
): Promise<Awaited<ReturnType<ReturnType<typeof redditSource>['fetch']>>> {
  return redditSource(subreddit, impl).fetch({ limit, timeoutMs: 10_000 })
}

describe('redditSource', () => {
  it("GETs the subreddit's newest posts from Arctic Shift with the UA and a timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { impl, calls } = fakeFetch(200, SEARCH_JSON)
    const source = redditSource('space', impl)
    expect(source.id).toBe('reddit:r/space')

    await source.fetch({ limit: 25, timeoutMs: 9_000 })

    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(`${url.origin}${url.pathname}`).toBe(`${ARCTIC_SHIFT_BASE_URL}/api/posts/search`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      subreddit: 'space',
      sort: 'desc',
      limit: '25',
      md2html: 'true',
      fields: 'id,title,author,selftext,url',
    })
    const init = calls[0].init!
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(REDDIT_USER_AGENT)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(9_000)
  })

  it('maps posts to TrendCandidates keyed by the t3_ fullname, url = comments permalink', async () => {
    const { impl } = fakeFetch(200, SEARCH_JSON)
    expect(await fetchAll(impl)).toEqual([
      {
        title: 'JWST finds water ice in a protoplanetary disk',
        url: 'https://www.reddit.com/r/space/comments/abc/',
        sourceId: 'reddit:r/space',
        externalId: 't3_abc',
        targetUrl: JWST_TARGET,
        postKind: 'link',
        author: 'someone',
        automated: false,
        body: undefined,
      },
      {
        title: 'Starship booster catch, third attempt',
        url: 'https://www.reddit.com/r/space/comments/def/',
        sourceId: 'reddit:r/space',
        externalId: 't3_def',
        targetUrl: BOOSTER_PERMALINK,
        postKind: 'self',
        author: 'other',
        automated: false,
        body: undefined,
      },
    ])
  })

  it('keeps the dedupe identity the reddit.com feed produced', async () => {
    // The vector pinned in dedupeHash's own test is r/space's t3_abc as the
    // Atom feed keyed it: topics scouted before the transport change must
    // still dedupe against what Arctic Shift returns for the same post.
    const { impl } = fakeFetch(200, SEARCH_JSON)
    const [first] = await fetchAll(impl)
    expect(dedupeHash(first.sourceId, first.externalId)).toBe(
      '543177266c3fc519b4f49513548b8109762f1e86010a941570d86885ac5b0f0a',
    )
  })

  it('asks for the requested limit and caps what it returns at it', async () => {
    const { impl, calls } = fakeFetch(200, SEARCH_JSON)
    const candidates = await fetchAll(impl, 'space', 1)
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('1')
    expect(candidates.map((c) => c.externalId)).toEqual(['t3_abc'])
  })

  it('annotates each candidate with its submission target and kind', async () => {
    const { impl } = fakeFetch(200, POST_KIND_SEARCH_JSON)
    const got = await fetchAll(impl)

    expect(got.map((c) => c.postKind)).toEqual([
      'image',
      'self',
      'link',
      'image',
      'self',
      'link',
      'link',
    ])
    expect(got.map((c) => c.targetUrl)).toEqual([
      IMAGE_TARGET,
      SELF_TARGET,
      ARTICLE_TARGET,
      GALLERY_TARGET,
      `https://www.reddit.com${CROSSPOST_PATH}`,
      undefined,
      undefined,
    ])
  })

  it('returns image candidates rather than dropping them — the scout decides', async () => {
    const { impl } = fakeFetch(200, POST_KIND_SEARCH_JSON)
    expect(await fetchAll(impl)).toHaveLength(7)
  })

  it("flags automated authors, and forgets a deleted account's name without dropping the post", async () => {
    const { impl } = fakeFetch(
      200,
      arcticShiftJson([
        {
          id: 'auto',
          title: 'All Space Questions thread for week of July 26, 2026',
          author: 'AutoModerator',
        },
        // The account is gone but the post is still up: reddit's listing
        // shows it, so the source keeps it.
        { id: 'orphan', title: 'A post whose author deleted their account', author: '[deleted]' },
      ]),
    )
    const got = await fetchAll(impl)
    expect(got.map((c) => [c.author, c.automated])).toEqual([
      ['AutoModerator', true],
      [undefined, false],
    ])
  })

  it('drops posts removed by moderators, by their authors, or by reddit', async () => {
    const { impl } = fakeFetch(
      200,
      arcticShiftJson([
        { id: 'mod', title: 'Removed by a moderator', selftext: '[removed]' },
        { id: 'ok', title: 'Still up' },
        { id: 'own', title: 'Deleted by its author', author: '[deleted]', selftext: '[deleted]' },
        { id: 'site', title: '[ Removed by Reddit ]' },
        {
          id: 'policy',
          title: 'Removed for content policy',
          selftext:
            '[ Removed by Reddit on account of violating the [content policy](/help/contentpolicy). ]',
        },
      ]),
    )
    expect((await fetchAll(impl)).map((c) => c.externalId)).toEqual(['t3_ok'])
  })

  it('carries the self-post body as plain text', async () => {
    const { impl } = fakeFetch(
      200,
      arcticShiftJson([
        {
          id: 'abc123',
          title: 'AITA for not apologizing?',
          author: 'BrazilLost_1-2',
          target: 'https://www.reddit.com/r/AmItheAsshole/comments/abc123/aita/',
          selftext: 'One month ago…',
          selftextHtml: SELF_POST_CONTENT,
        },
      ]),
    )
    const [candidate] = await fetchAll(impl, 'AmItheAsshole')
    expect(candidate.body).toBe(
      "One month ago I hosted a movie night for my five closest friends. It's a long " +
        'story but I need to know if I was wrong here.\n\n' +
        'Before the movie a friend called me and asked if she could bring some fruit to ' +
        'blend into a drink for everyone today.',
    )
  })

  it('leaves body undefined for a post with no selftext', async () => {
    const { impl } = fakeFetch(200, SEARCH_JSON)
    expect((await fetchAll(impl)).map((c) => c.body)).toEqual([undefined, undefined])
  })

  it("throws with the HTTP status and the API's own message on a non-2xx response", async () => {
    const { impl } = fakeFetch(400, arcticShiftError("'limit' must be between 1 and 100"))
    const err = await fetchAll(impl).catch((e: unknown) => e)
    expect(err).toMatchObject({
      message: "redditSource: r/space responded 400: 'limit' must be between 1 and 100",
    })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

  it('does not retry a 429 — the next scout attempt is the retry', async () => {
    const { impl, calls } = fakeFetch(429, '')
    const err = await fetchAll(impl).catch((e: unknown) => e)
    // The status stays in the message, so an operator can tell rate limiting
    // from an outage in the sourceErrors entry.
    expect(err).toMatchObject({ message: 'redditSource: r/space responded 429' })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
    expect(calls).toHaveLength(1)
  })

  it('throws on an error body even when the status is 200', async () => {
    const { impl } = fakeFetch(200, arcticShiftError('Timeout. Maybe slow down a bit'))
    const err = await fetchAll(impl).catch((e: unknown) => e)
    expect(err).toMatchObject({
      message: 'redditSource: r/space returned an error: Timeout. Maybe slow down a bit',
    })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

  it('throws when the response is not JSON', async () => {
    // e.g. a proxy's HTML error page in front of the API
    const { impl } = fakeFetch(200, '<html><body>502 Bad Gateway</body></html>')
    const err = await fetchAll(impl).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'redditSource: r/space returned a non-JSON response' })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

  it('throws when the envelope is not a post list', async () => {
    const { impl } = fakeFetch(200, JSON.stringify({ data: { id: 'abc' } }))
    const err = await fetchAll(impl).catch((e: unknown) => e)
    expect(err).toMatchObject({
      message: expect.stringMatching(/^redditSource: r\/space returned an unrecognized response/),
    })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

  it('skips posts missing an id or a title, and an empty result yields []', async () => {
    const { impl } = fakeFetch(
      200,
      JSON.stringify({
        data: [{ title: 'No id' }, { id: 'x1', title: '  ' }, { id: 'ok', title: 'Intact post' }],
      }),
    )
    expect((await fetchAll(impl)).map((c) => c.externalId)).toEqual(['t3_ok'])

    // An unknown subreddit answers exactly like a quiet one.
    const empty = fakeFetch(200, arcticShiftJson([]))
    expect(await fetchAll(empty.impl)).toEqual([])
  })

  it('throws when no post in a non-empty response is recognizable', async () => {
    // Every post failing the schema is API drift, not a run of odd posts —
    // surfacing it beats a source that quietly returns nothing forever.
    const { impl } = fakeFetch(200, JSON.stringify({ data: [{ name: 't3_abc' }] }))
    const err = await fetchAll(impl).catch((e: unknown) => e)
    expect(err).toMatchObject({
      message: expect.stringMatching(/^redditSource: r\/space returned an unrecognized response/),
    })
  })

  it('rejects a malformed subreddit name before any request', () => {
    // Arctic Shift answers a malformed name with 200 and an empty list, so
    // without this a `r/space` typo would read as a quiet subreddit forever.
    const { impl, calls } = fakeFetch(200, SEARCH_JSON)
    let err: unknown
    try {
      redditSource('r/space', impl)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ message: expect.stringMatching(/"r\/space"/) })
    expect(classify(err)).toMatchObject({ domain: 'config', kind: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('rejects when the fetch times out, so the orchestrator can isolate it', async () => {
    const impl: FetchLike = () =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(fetchAll(impl)).rejects.toThrow(/timeout/i)
  })
})

describe('isAutomatedAuthor moderator accounts', () => {
  it('matches subreddit moderator accounts', () => {
    expect(isAutomatedAuthor('AITAMod')).toBe(true)
    expect(isAutomatedAuthor('AskHistorians-Mods')).toBe(true)
    expect(isAutomatedAuthor('ModTeam')).toBe(true)
  })

  it('still matches AutoModerator', () => {
    expect(isAutomatedAuthor('AutoModerator')).toBe(true)
    expect(isAutomatedAuthor('automoderator')).toBe(true)
  })

  it('does not match ordinary accounts', () => {
    expect(isAutomatedAuthor('Innumerablegibbon')).toBe(false)
    expect(isAutomatedAuthor('modest_proposal')).toBe(false)
    expect(isAutomatedAuthor('BrazilLost_1-2')).toBe(false)
    expect(isAutomatedAuthor(undefined)).toBe(false)
  })
})
