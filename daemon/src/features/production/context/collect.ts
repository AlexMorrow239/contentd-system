import { fetchArticle, isRedditUrl, type PageRequest } from '../../../infra/sources/article.js'
import { recoverPost } from '../../../infra/sources/reddit.js'
import type { FetchLike } from '../../../infra/sources/types.js'
import {
  contextSnapshotSchema,
  type Article,
  type ContextSnapshot,
  type SourcePost,
} from '../../../shared/contracts/source-context.js'
import { BrainrotError, errorMessage } from '../../../shared/errors.js'
import { sanitizeStory } from '../../../shared/stories/sanitize.js'
import { topicForJob } from '../../topics/queries.js'
import type { JobContext } from '../contracts.js'
import { checkpoint } from '../ownership.js'
import { buildContextPrompt } from './prompt.js'

export interface ContextDependencies {
  request?: PageRequest
  fetchImpl?: FetchLike
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
