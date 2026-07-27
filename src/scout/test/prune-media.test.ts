import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { memDb, seedTopic } from '../../testing/db.js'
import { permalinkFeedXml } from '../sources/_post-kind.fixtures.js'
import { dedupeHash } from '../sources/types.js'
import type { FetchLike } from '../sources/types.js'
import { listTopics } from '../topics.js'
import { PRUNE_REJECT_REASON, pruneMedia } from '../prune-media.js'

describe('pruneMedia', () => {
  const SOURCE = 'reddit:r/space'
  const PERMALINK = 'https://www.reddit.com/r/space/comments/aaa1/milky_way/'

  function seedRedditTopic(db: Database, t3Id = 't3_aaa1', overrides = {}): number {
    return seedTopic(db, {
      channel: 'chan-a',
      source: SOURCE,
      url: PERMALINK,
      dedupeHash: dedupeHash(SOURCE, t3Id),
      ...overrides,
    })
  }

  // Body-keyed fetch stub. Records every URL so a test can assert the .rss
  // variant was requested rather than the 403-ing .json.
  function stub(body: string | number): { impl: FetchLike; urls: string[] } {
    const urls: string[] = []
    const impl: FetchLike = async (input) => {
      urls.push(input instanceof Request ? input.url : String(input))
      return typeof body === 'number'
        ? new Response('', { status: body })
        : new Response(body, { status: 200 })
    }
    return { impl, urls }
  }

  const only = (db: Database) => listTopics(db, { channel: 'chan-a' })[0]

  it('rejects a candidate whose submission target is an image', async () => {
    const db = memDb()
    seedRedditTopic(db)
    const { impl } = stub(permalinkFeedXml('t3_aaa1', 'https://i.redd.it/x.jpeg'))

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result).toEqual({ checked: 1, rejected: 1, skipped: [] })
    expect(only(db).status).toBe('rejected')
    expect(only(db).targetUrl).toBe('https://i.redd.it/x.jpeg')
    expect(only(db).reason).toBe(PRUNE_REJECT_REASON)
    db.close()
  })

  it('fetches the permalink .rss, never the .json reddit 403s', async () => {
    const db = memDb()
    seedRedditTopic(db)
    const { impl, urls } = stub(permalinkFeedXml('t3_aaa1', 'https://i.redd.it/x.jpeg'))

    await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    // Trailing slash replaced, not appended to.
    expect(urls).toEqual(['https://www.reddit.com/r/space/comments/aaa1/milky_way.rss'])
    db.close()
  })

  it('leaves an article candidate alone but backfills its target', async () => {
    const db = memDb()
    seedRedditTopic(db)
    const { impl } = stub(permalinkFeedXml('t3_aaa1', 'https://www.theguardian.com/science/x'))

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result.rejected).toBe(0)
    expect(only(db).status).toBe('candidate')
    expect(only(db).targetUrl).toBe('https://www.theguardian.com/science/x')
    db.close()
  })

  it('skips a row whose recomputed hash does not match the feed', async () => {
    const db = memDb()
    const id = seedRedditTopic(db)
    // The feed reports a DIFFERENT submission than the row claims — a
    // redirected or recycled permalink. Attributing this target to this row
    // would be a silent mis-rejection.
    const { impl } = stub(permalinkFeedXml('t3_zzz9', 'https://i.redd.it/x.jpeg'))

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result.rejected).toBe(0)
    expect(result.skipped).toEqual([{ topicId: id, reason: 'identity-mismatch' }])
    expect(only(db).status).toBe('candidate')
    expect(only(db).targetUrl).toBeNull()
    db.close()
  })

  it('skips a rate-limited permalink rather than guessing', async () => {
    const db = memDb()
    const id = seedRedditTopic(db)

    const result = await pruneMedia(db, { fetchImpl: stub(429).impl, delayMs: 0 })

    expect(result.skipped).toEqual([{ topicId: id, reason: 'http-429' }])
    expect(only(db).status).toBe('candidate')
    db.close()
  })

  it('skips a feed carrying no submission entry', async () => {
    const db = memDb()
    const id = seedRedditTopic(db)
    const { impl } = stub('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>')

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result.skipped).toEqual([{ topicId: id, reason: 'no-submission-entry' }])
    expect(only(db).status).toBe('candidate')
    db.close()
  })

  it('skips a submission with no [link] anchor', async () => {
    const db = memDb()
    const id = seedRedditTopic(db)
    const { impl } = stub(permalinkFeedXml('t3_aaa1', undefined))

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result.skipped).toEqual([{ topicId: id, reason: 'no-link-anchor' }])
    expect(only(db).status).toBe('candidate')
    db.close()
  })

  it('reports a thrown fetch without aborting the run', async () => {
    const db = memDb()
    const first = seedRedditTopic(db, 't3_aaa1')
    seedRedditTopic(db, 't3_bbb2', { title: 'second', dedupeHash: dedupeHash(SOURCE, 't3_bbb2') })
    let call = 0
    const impl: FetchLike = async () => {
      call += 1
      if (call === 1) throw new Error('connect timeout')
      return new Response(permalinkFeedXml('t3_bbb2', 'https://i.redd.it/y.jpeg'), { status: 200 })
    }

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result.checked).toBe(2)
    expect(result.rejected).toBe(1)
    expect(result.skipped).toEqual([{ topicId: first, reason: 'connect timeout' }])
    db.close()
  })

  it('writes nothing in dry-run mode but still reports the verdict', async () => {
    const db = memDb()
    seedRedditTopic(db)
    const { impl } = stub(permalinkFeedXml('t3_aaa1', 'https://i.redd.it/x.jpeg'))

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0, dryRun: true })

    expect(result.rejected).toBe(1)
    expect(only(db).status).toBe('candidate')
    expect(only(db).targetUrl).toBeNull()
    db.close()
  })

  it('ignores non-reddit and non-candidate rows entirely', async () => {
    const db = memDb()
    seedTopic(db, { channel: 'chan-a', source: 'rss:phys.org', dedupeHash: 'rss-1' })
    seedTopic(db, {
      channel: 'chan-a',
      source: SOURCE,
      status: 'used',
      dedupeHash: dedupeHash(SOURCE, 't3_used'),
    })
    const impl: FetchLike = async () => {
      throw new Error('must not fetch')
    }

    const result = await pruneMedia(db, { fetchImpl: impl, delayMs: 0 })

    expect(result).toEqual({ checked: 0, rejected: 0, skipped: [] })
    db.close()
  })

  it('scopes to one channel when asked', async () => {
    const db = memDb()
    seedRedditTopic(db)
    seedTopic(db, {
      channel: 'chan-b',
      source: SOURCE,
      url: PERMALINK,
      dedupeHash: dedupeHash(SOURCE, 't3_other'),
    })
    const { impl } = stub(permalinkFeedXml('t3_aaa1', 'https://i.redd.it/x.jpeg'))

    const result = await pruneMedia(db, { channel: 'chan-a', fetchImpl: impl, delayMs: 0 })

    expect(result.checked).toBe(1)
    expect(listTopics(db, { channel: 'chan-b' })[0].status).toBe('candidate')
    db.close()
  })
})
