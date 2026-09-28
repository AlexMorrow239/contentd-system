import type { FetchLike } from '../scout/sources/types.js'

/**
 * Arctic Shift `/api/posts/search` wire-shape fixtures.
 *
 * The shape the API actually serves (verified live 2026-09-28): a
 * `{"data":[…]}` envelope of posts whose `id` is the bare base-36 id (no
 * `t3_`), whose `url` is the submission target (a self post's own permalink),
 * and — with md2html=true — whose `selftext_html` is a `<div class="md">` of
 * `<p>` paragraphs with entities encoded once. `selftext_html` is absent when
 * `selftext` is empty. An error is `{"data":null,"error":"…"}`.
 *
 * Lives here rather than in a scout-tree `_*.fixtures.ts` because
 * `src/jobs/test/golden-path-loop.test.ts` is a consumer too.
 */

export interface ArcticShiftPostSpec {
  /** The post id. A `t3_` prefix is stripped, so a reddit fullname converts as-is. */
  id: string
  title: string
  /** Bare account name. Default `someone`. */
  author?: string
  /** The wire `url`: the submission target. The key is omitted when unset. */
  target?: string
  /** Self-post body as plain text; blank lines separate paragraphs. */
  body?: string
  /** Wire `selftext`, verbatim — e.g. `[removed]`. Overrides `body`. */
  selftext?: string
  /** Wire `selftext_html`, verbatim. Overrides the rendering of `body`. */
  selftextHtml?: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** `body` rendered the way md2html renders a plain-text selftext. */
function selftextHtml(body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>\n')}</p>`)
  return `<div class="md">${paragraphs.join('\n\n')}</div>`
}

/** One post object, in the API's own key names. */
function arcticShiftPost(spec: ArcticShiftPostSpec): Record<string, unknown> {
  const post: Record<string, unknown> = {
    author: spec.author ?? 'someone',
    id: spec.id.replace(/^t3_/, ''),
    selftext: spec.selftext ?? spec.body ?? '',
    title: spec.title,
  }
  const html = spec.selftextHtml ?? (spec.body === undefined ? undefined : selftextHtml(spec.body))
  if (html !== undefined) post.selftext_html = html
  if (spec.target !== undefined) post.url = spec.target
  return post
}

/** A whole search response body wrapping `posts`. */
export function arcticShiftJson(posts: ArcticShiftPostSpec[]): string {
  return JSON.stringify({ data: posts.map(arcticShiftPost) })
}

/** An error response body, as the API sends with a 400 (and sometimes a 200). */
export function arcticShiftError(message: string): string {
  return JSON.stringify({ data: null, error: message })
}

/**
 * URL-substring-keyed fetch stub: a string body becomes a 200 response, an
 * Error is thrown. An unmatched URL throws, so a test can never silently
 * reach a source it did not stub — or the live network.
 *
 * Key a subreddit's search by `subreddit=<name>`: the source builds its query
 * with URLSearchParams, which keeps the name as written.
 */
export function fetchStub(bodyBySubstring: Record<string, string | Error>): FetchLike {
  return async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    for (const [needle, body] of Object.entries(bodyBySubstring)) {
      if (url.includes(needle)) {
        if (body instanceof Error) throw body
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}
