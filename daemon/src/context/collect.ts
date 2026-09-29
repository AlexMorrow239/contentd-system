import type { JobContext } from '../jobs/types.js'
import { topicForJob } from '../scout/topics.js'
import {
  ARCTIC_SHIFT_BASE_URL,
  ARCTIC_SHIFT_FIELDS,
  REDDIT_USER_AGENT,
  sourcePostFromArchive,
} from '../scout/sources/reddit.js'
import type { FetchLike } from '../scout/sources/types.js'
import { createDeadline } from '../time.js'
import { checkpoint } from '../stages/ownership.js'
import { BrainrotError, errorMessage } from '../errors.js'
import { sanitizeStory } from '../stories/sanitize.js'
import { fetchArticle, isRedditUrl, type Article, type PageRequest } from './article.js'
import { buildContextPrompt } from './prompt.js'
import { contextSnapshotSchema, type ContextSnapshot, type SourcePost } from './types.js'

export interface ContextDependencies {
  request?: PageRequest
  fetchImpl?: FetchLike
}

async function recoverPost(
  source: SourcePost,
  ctx: JobContext,
  fetchImpl: FetchLike,
): Promise<SourcePost> {
  const url = new URL(source.url)
  if (!['reddit.com', 'www.reddit.com', 'old.reddit.com'].includes(url.hostname))
    throw new Error('No recoverable Reddit post ID')
  const id = /^\/r\/[^/]+\/comments\/([a-z0-9]+)(?:\/|$)/.exec(url.pathname)?.[1]
  if (!id) throw new Error('No recoverable Reddit post ID')
  const params = new URLSearchParams({ ids: id, md2html: 'true', fields: ARCTIC_SHIFT_FIELDS })
  const deadline = createDeadline(ctx.time, 10_000, ctx.signal)
  try {
    const res = await fetchImpl(`${ARCTIC_SHIFT_BASE_URL}/api/posts/ids?${params}`, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
      signal: deadline.signal,
      redirect: 'error',
    })
    if (!res.ok) throw new Error(`Archive responded HTTP ${res.status}`)
    const body: unknown = await res.json()
    deadline.signal.throwIfAborted()
    const rows =
      typeof body === 'object' && body !== null && 'data' in body && Array.isArray(body.data)
        ? body.data
        : []
    const post = rows
      .map((raw: unknown) =>
        sourcePostFromArchive(raw, source.sourceId, source.url, ctx.time.now().toISOString()),
      )
      .find((p) => p?.externalId === `t3_${id}`)
    if (!post) throw new Error('Post missing or removed from the archive')
    return post
  } finally {
    deadline.dispose()
  }
}

function articleTarget(source: SourcePost): string | null {
  const target = source.targetUrl ?? (source.sourceId.startsWith('rss:') ? source.url : null)
  if (!target) return null
  try {
    // Never try to scrape Reddit, its short links, or its media endpoints.
    if (isRedditUrl(new URL(target))) return null
  } catch {
    /* Let the article client record an invalid URL as a retrieval gap. */
  }
  return target
}

export async function collectContext(
  ctx: JobContext,
  dependencies: ContextDependencies = {},
): Promise<ContextSnapshot> {
  checkpoint(ctx)
  const job = ctx.db.prepare('SELECT source_context_json FROM jobs WHERE id = ?').get(ctx.jobId) as
    { source_context_json: string | null } | undefined
  if (job?.source_context_json != null) {
    try {
      return contextSnapshotSchema.parse(JSON.parse(job.source_context_json))
    } catch {
      throw new BrainrotError(
        'Invalid saved source context; refusing to replace the job snapshot',
        { domain: 'job', kind: 'invalid' },
      )
    }
  }
  const topic = topicForJob(ctx.db, ctx.jobId)
  let source: SourcePost | null =
    topic?.sourceContext ??
    (topic
      ? {
          version: 1,
          title: topic.rawTitle,
          body: null,
          author: null,
          publishedAt: null,
          sourceId: topic.source,
          externalId: null,
          url: topic.url,
          targetUrl: topic.targetUrl,
          fetchedAt: ctx.time.now().toISOString(),
        }
      : null)
  const warnings: string[] = []
  if (source && !topic?.sourceContext && source.sourceId.startsWith('reddit:') && !ctx.story) {
    try {
      source = await recoverPost(source, ctx, dependencies.fetchImpl ?? fetch)
    } catch (err) {
      checkpoint(ctx)
      warnings.push(`Reddit post retrieval failed: ${errorMessage(err)}`)
    }
  }
  checkpoint(ctx)
  let article: Article | null = null
  const target = source && !ctx.story ? articleTarget(source) : null
  if (target) {
    try {
      article = await fetchArticle(target, {
        time: ctx.time,
        signal: ctx.signal,
        request: dependencies.request,
      })
      if (!article.body)
        warnings.push('Linked article has no readable body; only metadata was recovered.')
    } catch (err) {
      checkpoint(ctx)
      warnings.push(`Linked article retrieval failed: ${errorMessage(err)}`)
    }
  }
  checkpoint(ctx)
  // Only the current part informs story metadata; narration still comes from ctx.story.
  const promptSource = ctx.story
    ? {
        ...(source ?? {
          version: 1 as const,
          title: ctx.topic,
          author: null,
          publishedAt: null,
          sourceId: 'story',
          externalId: null,
          url: ctx.story.sourceUrl,
          targetUrl: null,
          fetchedAt: ctx.time.now().toISOString(),
        }),
        title: sanitizeStory(source?.title ?? ctx.topic),
        body: sanitizeStory(ctx.story.bodyText),
      }
    : source
  const { promptContext, bodies } = buildContextPrompt(promptSource, article, warnings)
  const snapshot: ContextSnapshot = {
    version: 1,
    collectedAt: ctx.time.now().toISOString(),
    topic: ctx.topic,
    source: promptSource,
    article,
    warnings,
    promptContext,
    truncation: { post: bodies.postTruncated, article: bodies.articleTruncated },
  }
  ctx.db
    .transaction(() => {
      checkpoint(ctx)
      const updated = ctx.db
        .prepare(
          'UPDATE jobs SET source_context_json = ? WHERE id = ? AND source_context_json IS NULL',
        )
        .run(JSON.stringify(snapshot), ctx.jobId)
      if (updated.changes !== 1)
        throw new Error('Could not persist source context for the owned job')
    })
    .immediate()
  for (const warning of warnings) ctx.log.warn({ jobId: ctx.jobId }, warning)
  return snapshot
}
