import { describe, expect, it } from 'vitest'
import { rssSource } from './rss.js'

// Injectable fetch: captures every call, answers with one canned XML response.
function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
  }
  return { impl, calls }
}

const OPTS = { limit: 25, timeoutMs: 10_000 }

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Space News</title>
    <link>https://feeds.example.com/space</link>
    <item>
      <title>Astronomers spot a rogue planet</title>
      <link>https://feeds.example.com/releases/a.htm</link>
      <guid>ex-a-2026</guid>
    </item>
    <item>
      <title>New telescope sees first light</title>
      <link>https://feeds.example.com/releases/b.htm</link>
      <guid>https://feeds.example.com/releases/b.htm</guid>
    </item>
    <item>
      <title>Rover finds layered ice</title>
      <link>https://feeds.example.com/releases/c.htm</link>
      <guid>ex-c-2026</guid>
    </item>
  </channel>
</rss>`

describe('rssSource', () => {
  it('derives its id from the feed hostname', () => {
    expect(rssSource('https://feeds.example.com/space.xml').id).toBe('rss:feeds.example.com')
  })

  it('fetches the feed with a timeout signal and maps RSS 2.0 items', async () => {
    const { impl, calls } = fakeFetch(200, RSS_FEED)
    const source = rssSource('https://feeds.example.com/space.xml', impl)
    const candidates = await source.fetch(OPTS)

    // Request shape: the feed URL itself, with an abort signal attached.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://feeds.example.com/space.xml')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)

    expect(candidates).toEqual([
      {
        title: 'Astronomers spot a rogue planet',
        url: 'https://feeds.example.com/releases/a.htm',
        sourceId: 'rss:feeds.example.com',
        externalId: 'ex-a-2026',
      },
      {
        title: 'New telescope sees first light',
        url: 'https://feeds.example.com/releases/b.htm',
        sourceId: 'rss:feeds.example.com',
        externalId: 'https://feeds.example.com/releases/b.htm',
      },
      {
        title: 'Rover finds layered ice',
        url: 'https://feeds.example.com/releases/c.htm',
        sourceId: 'rss:feeds.example.com',
        externalId: 'ex-c-2026',
      },
    ])
  })

  it('caps results at opts.limit client-side', async () => {
    const { impl } = fakeFetch(200, RSS_FEED)
    const source = rssSource('https://feeds.example.com/space.xml', impl)
    const candidates = await source.fetch({ ...OPTS, limit: 2 })
    expect(candidates.map((c) => c.externalId)).toEqual([
      'ex-a-2026',
      'https://feeds.example.com/releases/b.htm',
    ])
  })
})

const RSS_EDGE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Attributed guid</title>
      <link>https://feeds.example.com/1</link>
      <guid isPermaLink="false">g-1</guid>
    </item>
    <item>
      <title>Guid-less falls back to link</title>
      <link>https://feeds.example.com/2</link>
    </item>
    <item>
      <link>https://feeds.example.com/3</link>
      <guid>g-3</guid>
    </item>
    <item>
      <title>No identity at all</title>
    </item>
  </channel>
</rss>`

describe('rssSource identity resolution', () => {
  it('reads attributed guids, falls back to the link, and skips unusable items', async () => {
    const { impl } = fakeFetch(200, RSS_EDGE_FEED)
    const candidates = await rssSource('https://feeds.example.com/edge.xml', impl).fetch(OPTS)
    // Item 3 has no title, item 4 has neither guid nor link: both skipped.
    expect(candidates).toEqual([
      {
        title: 'Attributed guid',
        url: 'https://feeds.example.com/1',
        sourceId: 'rss:feeds.example.com',
        externalId: 'g-1',
      },
      {
        title: 'Guid-less falls back to link',
        url: 'https://feeds.example.com/2',
        sourceId: 'rss:feeds.example.com',
        externalId: 'https://feeds.example.com/2',
      },
    ])
  })
})
