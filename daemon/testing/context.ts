import type { SourcePost } from '../src/context/types.js'
import type { JobContext } from '../src/jobs/types.js'
import { claimTopic, insertTopics, listTopics, type NewTopic } from '../src/scout/topics.js'

export function sourcePost(overrides: Partial<SourcePost> = {}): SourcePost {
  return {
    version: 1,
    title: 'Original revenue report',
    body: 'Revenue increased twelve percent.',
    author: 'reporter',
    publishedAt: '2026-09-28T00:00:00.000Z',
    sourceId: 'reddit:r/stocks',
    externalId: 't3_abc',
    url: 'https://www.reddit.com/r/stocks/comments/abc/',
    targetUrl: 'https://news.example/results',
    fetchedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

export function bindSourceTopic(ctx: JobContext, overrides: Partial<NewTopic> = {}): number {
  insertTopics(
    ctx.db,
    [
      {
        channel: ctx.channel.name,
        title: ctx.topic,
        rawTitle: 'Original revenue report',
        source: 'reddit:r/stocks',
        url: 'https://www.reddit.com/r/stocks/comments/abc/',
        targetUrl: 'https://news.example/results',
        sourceContext: sourcePost(),
        dedupeHash: ctx.jobId,
        score: 90,
        reason: 'relevant',
        status: 'candidate',
        ...overrides,
      },
    ],
    ctx.time,
  )
  const topic = listTopics(ctx.db).find((row) => row.dedupeHash === ctx.jobId)!
  claimTopic(ctx.db, topic.id, ctx.jobId)
  return topic.id
}
