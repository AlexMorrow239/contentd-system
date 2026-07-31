/**
 * A Reddit Atom feed trimmed to four entries covering every post kind the
 * classifier distinguishes. The <content> bodies are entity-encoded exactly
 * as Reddit serves them; the `[link]` anchor is the submission target.
 *
 * Entry 4 deliberately has no [link] anchor at all, covering the undefined
 * path.
 */
function entry(id: string, title: string, contentInner: string, author = '/u/someone'): string {
  return (
    `<entry><author><name>${author}</name></author>` +
    `<id>${id}</id><title>${title}</title>` +
    `<link rel="alternate" href="https://www.reddit.com/r/space/comments/${id.replace('t3_', '')}/x/" />` +
    `<content type="html">${contentInner}</content></entry>`
  )
}

/** A recurring AutoModerator thread — new t3_ id every week, forever. */
export function autoModeratorFeedXml(id: string, title: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    entry(id, title, '&lt;p&gt;Ask away!&lt;/p&gt;', '/u/AutoModerator') +
    `</feed>`
  )
}

// &lt;a href="TARGET"&gt;[link]&lt;/a&gt; — encoded as reddit sends it.
function linkAnchor(target: string): string {
  return `&lt;span&gt;&lt;a href=&quot;${target}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;`
}

export const IMAGE_TARGET = 'https://i.redd.it/u0g9ashc6mfh1.jpeg'
export const SELF_TARGET = 'https://www.reddit.com/r/space/comments/1v87hz5/what_will/'
export const ARTICLE_TARGET = 'https://www.theguardian.com/science/2026/jul/27/jodrell'

export const REDDIT_FEED_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<feed xmlns="http://www.w3.org/2005/Atom">` +
  entry('t3_aaa1', 'Milky way over Yosemite', linkAnchor(IMAGE_TARGET)) +
  entry('t3_bbb2', 'What will the orbit of starship look like', linkAnchor(SELF_TARGET)) +
  entry('t3_ccc3', 'Jodrell Bank Observatory facing closure', linkAnchor(ARTICLE_TARGET)) +
  entry('t3_ddd4', 'An entry with no link anchor', '&lt;p&gt;body only&lt;/p&gt;') +
  `</feed>`

/**
 * A permalink's comment feed: the submission (t3_) first, then comments (t1_).
 * Only the submission carries a `[link]` anchor — this is what `prune-media`
 * re-fetches to recover a stored topic's submission target.
 */
export function permalinkFeedXml(t3Id: string, target: string | undefined): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    entry(t3Id, 'Milky way over Yosemite', target === undefined ? '&lt;p&gt;x&lt;/p&gt;' : linkAnchor(target)) +
    `<entry><id>t1_ozzv816</id><title>a comment</title>` +
    `<content type="html">&lt;p&gt;nice shot&lt;/p&gt;</content></entry>` +
    `</feed>`
  )
}
