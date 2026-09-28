/**
 * Reddit Atom wire-shape fixtures — reddit.com's own feed, which only
 * `topics prune-media` still reads (redditSource reads through Arctic Shift;
 * see `./arctic-shift.ts`).
 *
 * The shape reddit actually serves (verified live 2026-07-22): an `<entry>`
 * whose `<id>` is the t3_ fullname the JSON API reports as `data.name`, whose
 * `<link>` is the comments permalink, and whose `<content>` carries the
 * submission target as an entity-encoded `[link]` anchor.
 */

/** `&lt;a href="TARGET"&gt;[link]&lt;/a&gt;` — encoded as reddit sends it. */
export function linkAnchor(target: string): string {
  return `&lt;span&gt;&lt;a href=&quot;${target}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;`
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
  /** Wire-shaped `<content>` inner text, verbatim, when `target` does not fit. */
  content?: string
  /** Extra child elements (e.g. `<updated>…</updated>`), verbatim. */
  extra?: string
}

/**
 * One `<entry>`. `content` wins over `target`; omitting both omits `<content>`
 * entirely.
 */
export function redditEntry(spec: RedditEntrySpec): string {
  const contentInner =
    spec.content ?? (spec.target === undefined ? undefined : linkAnchor(spec.target))
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
