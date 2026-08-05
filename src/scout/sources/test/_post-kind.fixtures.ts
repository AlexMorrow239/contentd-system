import { linkAnchor, redditEntry, redditFeedXml } from '../../../testing/reddit-feed.js'

/**
 * The post-kind classifier's own corpus, built from the shared reddit Atom
 * wire-shape builders in `src/testing/reddit-feed.ts`. What is local here is
 * the *selection* of posts — one per kind the classifier distinguishes — not
 * the wire shape.
 */

// This tree's entries use reddit's `/comments/<id-without-t3_>/x/` permalink
// form; the shared builder's default is the `/comments/<id>/` form the scout
// fixtures use, so it is spelled out rather than inherited.
function entry(id: string, title: string, contentInner: string, author = '/u/someone'): string {
  return redditEntry({
    id,
    title,
    author,
    permalink: `https://www.reddit.com/r/space/comments/${id.replace('t3_', '')}/x/`,
    content: contentInner,
  })
}

/** A recurring AutoModerator thread — new t3_ id every week, forever. */
export function autoModeratorFeedXml(id: string, title: string): string {
  return redditFeedXml([entry(id, title, '&lt;p&gt;Ask away!&lt;/p&gt;', '/u/AutoModerator')])
}

export const IMAGE_TARGET = 'https://i.redd.it/u0g9ashc6mfh1.jpeg'
export const SELF_TARGET = 'https://www.reddit.com/r/space/comments/1v87hz5/what_will/'
export const ARTICLE_TARGET = 'https://www.theguardian.com/science/2026/jul/27/jodrell'

/**
 * Four entries covering every post kind. Entry 4 deliberately has no [link]
 * anchor at all, covering the undefined path.
 */
export const REDDIT_FEED_XML = redditFeedXml([
  entry('t3_aaa1', 'Milky way over Yosemite', linkAnchor(IMAGE_TARGET)),
  entry('t3_bbb2', 'What will the orbit of starship look like', linkAnchor(SELF_TARGET)),
  entry('t3_ccc3', 'Jodrell Bank Observatory facing closure', linkAnchor(ARTICLE_TARGET)),
  entry('t3_ddd4', 'An entry with no link anchor', '&lt;p&gt;body only&lt;/p&gt;'),
])

/**
 * A permalink's comment feed: the submission (t3_) first, then comments (t1_).
 * Only the submission carries a `[link]` anchor — this is what `prune-media`
 * re-fetches to recover a stored topic's submission target.
 */
export function permalinkFeedXml(t3Id: string, target: string | undefined): string {
  return redditFeedXml([
    entry(
      t3Id,
      'Milky way over Yosemite',
      target === undefined ? '&lt;p&gt;x&lt;/p&gt;' : linkAnchor(target),
    ),
    `<entry><id>t1_ozzv816</id><title>a comment</title>` +
      `<content type="html">&lt;p&gt;nice shot&lt;/p&gt;</content></entry>`,
  ])
}
