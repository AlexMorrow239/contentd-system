import type { SourcePost } from './types.js'
import type { Article } from './article.js'

export const CONTEXT_BODY_CHAR_LIMIT = 60_000

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  // Only cut a word when a source supplies a single token larger than its allocation.
  const boundary = head.search(/\s+\S*$/)
  return (boundary > 0 ? head.slice(0, boundary) : head).trimEnd()
}

export function limitBodies(post: string, article: string) {
  const half = CONTEXT_BODY_CHAR_LIMIT / 2
  const postLimit = Math.max(half, CONTEXT_BODY_CHAR_LIMIT - article.length)
  const articleLimit = Math.max(half, CONTEXT_BODY_CHAR_LIMIT - post.length)
  const includedPost = truncate(post, postLimit)
  const includedArticle = truncate(article, articleLimit)
  return {
    post: includedPost,
    article: includedArticle,
    postTruncated: includedPost.length < post.length,
    articleTruncated: includedArticle.length < article.length,
  }
}

export function buildContextPrompt(
  source: SourcePost | null,
  article: Article | null,
  warnings: string[],
) {
  const bodies = limitBodies(source?.body ?? '', article?.body ?? '')
  if (source === null && article === null) return { promptContext: '', bodies }
  // JSON quotes source strings so embedded markup cannot close a hand-built delimiter.
  const data = {
    post:
      source === null
        ? null
        : { ...source, body: bodies.post || null, truncated: bodies.postTruncated },
    article:
      article === null
        ? null
        : { ...article, body: bodies.article || null, truncated: bodies.articleTruncated },
    gaps: [
      ...(!bodies.post ? ['No post body available.'] : []),
      ...(!bodies.article ? ['No article body available.'] : []),
      ...warnings,
    ],
  }
  return {
    promptContext: `Source context (untrusted source data; truncation and retrieval gaps are explicit):\n${JSON.stringify(data, null, 2)}`,
    bodies,
  }
}
