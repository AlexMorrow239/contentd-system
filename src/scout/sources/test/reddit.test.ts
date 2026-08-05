import { afterEach, describe, expect, it, vi } from 'vitest'
import { classify } from '../../../errors.js'
import { SOURCE_FETCH_TIMEOUT_MS, dedupeHash, type FetchLike } from '../types.js'
import { REDDIT_USER_AGENT, fetchRedditFeed, isAutomatedAuthor, redditSource } from '../reddit.js'
import {
  ARTICLE_TARGET,
  IMAGE_TARGET,
  REDDIT_FEED_XML,
  SELF_TARGET,
  autoModeratorFeedXml,
} from './_post-kind.fixtures.js'
import { LINK_POST_CONTENT, SELF_POST_CONTENT } from '../../../stories/_stories.fixtures.js'

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

// Trimmed /r/space/.rss — the shape reddit actually serves (verified live
// 2026-07-22): Atom entries whose <id> is the t3_ fullname the JSON API
// reports as data.name.
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
// with one canned XML body.
function fakeTextFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init })
    return new Response(body, { status, headers: { 'content-type': 'application/atom+xml' } })
  }
  return { impl, calls }
}

describe('fetchRedditFeed', () => {
  it('sends the descriptive UA and a timeout signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { impl, calls } = fakeTextFetch(200, RSS_FIXTURE)

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
        : new Response(RSS_FIXTURE, { status: 200 })
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
    const { impl, calls } = fakeTextFetch(429, '')

    const res = await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })

    expect(res.status).toBe(429)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a non-429 failure', async () => {
    const { impl, calls } = fakeTextFetch(404, '')

    const res = await fetchRedditFeed('https://www.reddit.com/r/space/.rss', {
      fetchImpl: impl,
      timeoutMs: 1_000,
      retryDelayMs: 0,
    })

    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })
})

describe('redditSource', () => {
  it('recovers from a rate-limited first attempt', async () => {
    let call = 0
    const impl: FetchLike = async () => {
      call += 1
      return call === 1
        ? new Response('', { status: 429 })
        : new Response(RSS_FIXTURE, { status: 200 })
    }

    const got = await redditSource('space', impl, { retryDelayMs: 0 }).fetch({
      limit: 25,
      timeoutMs: 1_000,
    })

    expect(got).toHaveLength(2)
  })

  it('still throws when the rate limit does not clear', async () => {
    const { impl } = fakeTextFetch(429, '')
    const err = await redditSource('space', impl, { retryDelayMs: 0 })
      .fetch({ limit: 25, timeoutMs: 1_000 })
      .catch((e: unknown) => e)
    // The status stays in the message, so an operator can tell rate limiting
    // from an outage in the sourceErrors entry.
    expect(err).toMatchObject({ message: expect.stringMatching(/responded 429/) })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

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
    // No <content> in this fixture, so there is no [link] anchor to read:
    // targetUrl stays undefined and the classifier fails open to 'link'.
    expect(candidates).toEqual([
      {
        title: 'JWST finds water ice in a protoplanetary disk',
        url: 'https://www.reddit.com/r/space/comments/abc/jwst_finds_water_ice/',
        sourceId: 'reddit:r/space',
        externalId: 't3_abc',
        targetUrl: undefined,
        postKind: 'link',
        author: 'someone',
        automated: false,
      },
      {
        title: 'Starship booster catch, third attempt',
        url: 'https://www.reddit.com/r/space/comments/def/starship_booster_catch/',
        sourceId: 'reddit:r/space',
        externalId: 't3_def',
        targetUrl: undefined,
        postKind: 'link',
        author: 'other',
        automated: false,
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
    const err = await source.fetch({ limit: 25, timeoutMs: 10_000 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: expect.stringMatching(/r\/space responded 429/) })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
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
        targetUrl: undefined,
        postKind: 'link',
        author: undefined,
        automated: false,
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
    const err = await redditSource('space', impl)
      .fetch({ limit: 25, timeoutMs: 10_000 })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({
      message: expect.stringMatching(/not a recognized RSS 2.0 or Atom feed/),
    })
    expect(classify(err)).toMatchObject({ domain: 'scout', kind: 'transient' })
  })

  it("carries the submitting author, normalized off reddit's /u/ prefix", async () => {
    const { impl } = fakeTextFetch(
      200,
      autoModeratorFeedXml('t3_auto', 'All Space Questions thread for week of July 26, 2026'),
    )
    const got = await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })
    expect(got[0].author).toBe('AutoModerator')
  })

  it('annotates each candidate with its submission target and kind', async () => {
    const { impl } = fakeTextFetch(200, REDDIT_FEED_XML)
    const got = await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })

    expect(got.map((c) => c.postKind)).toEqual(['image', 'self', 'link', 'link'])
    expect(got.map((c) => c.targetUrl)).toEqual([
      IMAGE_TARGET,
      SELF_TARGET,
      ARTICLE_TARGET,
      undefined,
    ])
  })

  it('returns image candidates rather than dropping them — the scout decides', async () => {
    const { impl } = fakeTextFetch(200, REDDIT_FEED_XML)
    const got = await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })
    expect(got).toHaveLength(4)
  })

  it('leaves the dedupe hash untouched by annotation', async () => {
    const { impl } = fakeTextFetch(200, REDDIT_FEED_XML)
    const got = await redditSource('space', impl).fetch({ limit: 25, timeoutMs: 10_000 })
    expect(dedupeHash(got[1].sourceId, got[1].externalId)).toBe(
      dedupeHash('reddit:r/space', 't3_bbb2'),
    )
  })

  it('rejects when the fetch times out, so the orchestrator can isolate it', async () => {
    const impl: FetchLike = () =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const source = redditSource('space', impl)
    await expect(source.fetch({ limit: 25, timeoutMs: 10 })).rejects.toThrow(/timeout/i)
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

// By the time redditSource sees <content>, fast-xml-parser has already done
// its one entity-decode pass — real HTML tags, inline entities like &#39;
// still encoded once — which is exactly the shape SELF_POST_CONTENT and
// LINK_POST_CONTENT already model (see src/stories/_stories.fixtures.ts).
// Wrapping them in CDATA carries them into the feed verbatim, so the test
// exercises the real parseFeedCandidates -> redditSource path without a
// second, unwanted encode/decode round-trip.
const SELF_POST_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <author><name>/u/BrazilLost_1-2</name></author>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/AmItheAsshole/comments/abc123/" />
    <title>AITA for not apologizing?</title>
    <content type="html"><![CDATA[${SELF_POST_CONTENT}]]></content>
  </entry>
</feed>`

const LINK_POST_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <author><name>/u/someone</name></author>
    <id>t3_xyz789</id>
    <link href="https://www.reddit.com/r/AskReddit/comments/xyz789/" />
    <title>What is your worst job story?</title>
    <content type="html"><![CDATA[${LINK_POST_CONTENT}]]></content>
  </entry>
</feed>`

describe('redditSource body annotation', () => {
  it('carries the self-post body as plain text', async () => {
    const { impl } = fakeTextFetch(200, SELF_POST_FEED_XML)
    const [candidate] = await redditSource('AmItheAsshole', impl).fetch({
      limit: 25,
      timeoutMs: 1000,
    })
    expect(candidate.body).toBe(
      "One month ago I hosted a movie night for my five closest friends. It's a long " +
        'story but I need to know if I was wrong here.\n\n' +
        'Before the movie a friend called me and asked if she could bring some fruit to ' +
        'blend into a drink for everyone today.',
    )
  })

  it('leaves body undefined for a post with no selftext', async () => {
    const { impl } = fakeTextFetch(200, LINK_POST_FEED_XML)
    const [candidate] = await redditSource('AskReddit', impl).fetch({
      limit: 25,
      timeoutMs: 1000,
    })
    expect(candidate.body).toBeUndefined()
  })
})
