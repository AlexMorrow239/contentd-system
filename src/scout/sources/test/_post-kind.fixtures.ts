import { arcticShiftJson } from '../../../testing/arctic-shift.js'
import { linkAnchor, redditEntry, redditFeedXml } from '../../../testing/reddit-feed.js'

/**
 * The post-kind classifier's own corpus, built from the shared wire-shape
 * builders in `src/testing/`. What is local here is the *selection* of posts —
 * one per `url` shape the source must turn into a target — not the wire shape.
 */

export const IMAGE_TARGET = 'https://i.redd.it/u0g9ashc6mfh1.jpeg'
export const SELF_TARGET = 'https://www.reddit.com/r/space/comments/1v87hz5/what_will/'
export const ARTICLE_TARGET = 'https://www.theguardian.com/science/2026/jul/27/jodrell'
export const GALLERY_TARGET = 'https://www.reddit.com/gallery/1wsl8to'
/** A crosspost's `url` is its parent's permalink, served relative. */
export const CROSSPOST_PATH = '/r/offmychest/comments/1wruk40/i_need_to_get_this_off/'

/**
 * One Arctic Shift post per `url` shape. The last two are a deleted post
 * (`url` is "") and a post with no `url` key at all — both the classifier's
 * fail-open ('link') path.
 */
export const POST_KIND_SEARCH_JSON = arcticShiftJson([
  { id: 'aaa1', title: 'Milky way over Yosemite', target: IMAGE_TARGET },
  { id: 'bbb2', title: 'What will the orbit of starship look like', target: SELF_TARGET },
  { id: 'ccc3', title: 'Jodrell Bank Observatory facing closure', target: ARTICLE_TARGET },
  { id: 'ddd4', title: 'Launch photos from the causeway', target: GALLERY_TARGET },
  { id: 'eee5', title: 'Crossposted confession', target: CROSSPOST_PATH },
  { id: 'fff6', title: 'A post whose url is empty', target: '' },
  { id: 'ggg7', title: 'A post with no url at all' },
])

// prune-media still re-fetches reddit.com's own Atom permalink feed. Its
// entries use reddit's `/comments/<id-without-t3_>/x/` permalink form; the
// shared builder's default is the `/comments/<id>/` form, so it is spelled
// out rather than inherited.
function entry(id: string, title: string, contentInner: string): string {
  return redditEntry({
    id,
    title,
    permalink: `https://www.reddit.com/r/space/comments/${id.replace('t3_', '')}/x/`,
    content: contentInner,
  })
}

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
