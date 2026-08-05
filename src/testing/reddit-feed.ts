import type { FetchLike } from '../scout/sources/types.js'

/**
 * Reddit Atom wire-shape fixtures.
 *
 * The shape reddit actually serves (verified live 2026-07-22): an `<entry>`
 * whose `<id>` is the t3_ fullname the JSON API reports as `data.name`, whose
 * `<link>` is the comments permalink, and whose `<content>` carries the
 * submission target as an entity-encoded `[link]` anchor (a link/image post)
 * or an entity-encoded SC_OFF/SC_ON span (a self post).
 *
 * This was re-derived in four places — scout.test.ts, golden-path-loop.test.ts,
 * _post-kind.fixtures.ts and prune-media's feed — so a change to what reddit
 * serves had to be found in as many. It lives here rather than in a scout-tree
 * `_*.fixtures.ts` because `src/jobs/test/golden-path-loop.test.ts` is a
 * consumer, and CLAUDE.md reserves `_*.fixtures.ts` for what only one module
 * needs.
 */

/** `&lt;a href="TARGET"&gt;[link]&lt;/a&gt;` — encoded as reddit sends it. */
export function linkAnchor(target: string): string {
  return `&lt;span&gt;&lt;a href=&quot;${target}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;`
}

/**
 * A self post's body as reddit serves it: the SC_OFF/SC_ON span's HTML is
 * entity-escaped inside `<content>`, so a fixture built this way exercises
 * fast-xml-parser's decode step exactly like a live self post does rather
 * than bypassing it with CDATA.
 */
export function selftextContent(body: string): string {
  const raw = `<!-- SC_OFF --><div class="md"><p>${body}</p></div><!-- SC_ON -->`
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface RedditEntrySpec {
  /** The t3_ fullname, verbatim. */
  id: string
  title: string
  /** Author handle including the `/u/` prefix. Default `/u/someone`. */
  author?: string
  /** Comments permalink. Default `https://www.reddit.com/r/space/comments/<id>/`. */
  permalink?: string
  /** Submission target — rendered as a `[link]` anchor inside `<content>`. */
  target?: string
  /** Self-post body — rendered as an escaped SC_OFF/SC_ON span. */
  body?: string
  /** Wire-shaped `<content>` inner text, verbatim, when neither derived shape fits. */
  content?: string
  /** Extra child elements (e.g. `<updated>…</updated>`), verbatim. */
  extra?: string
}

/**
 * One `<entry>`. `content`/`body`/`target` are checked in that order; omitting
 * all three omits `<content>` entirely, which is the classifier's fail-open
 * ('link') path.
 */
export function redditEntry(spec: RedditEntrySpec): string {
  const contentInner = ((): string | undefined => {
    if (spec.content !== undefined) return spec.content
    if (spec.body !== undefined) return selftextContent(spec.body)
    if (spec.target !== undefined) return linkAnchor(spec.target)
    return undefined
  })()
  const permalink = spec.permalink ?? `https://www.reddit.com/r/space/comments/${spec.id}/`
  return `<entry>
      <author><name>${spec.author ?? '/u/someone'}</name></author>
      <id>${spec.id}</id>
      <link href="${permalink}" />
      <title>${spec.title}</title>
      ${spec.extra ?? ''}
      ${contentInner === undefined ? '' : `<content type="html">${contentInner}</content>`}
    </entry>`
}

/** A whole Atom document wrapping `entries`. */
export function redditFeedXml(
  entries: (RedditEntrySpec | string)[],
  opts: { feedId?: string; feedTitle?: string } = {},
): string {
  const rendered = entries.map((e) => (typeof e === 'string' ? e : redditEntry(e))).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <id>${opts.feedId ?? '/r/space/.rss'}</id>
      <title>${opts.feedTitle ?? '/r/space'}</title>
      ${rendered}
    </feed>`
}

/**
 * URL-substring-keyed fetch stub: a string body becomes a 200 response, an
 * Error is thrown. An unmatched URL throws, so a test can never silently
 * reach a source it did not stub — or the live network.
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
