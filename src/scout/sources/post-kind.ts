// What a Reddit submission actually points at. The scorer cannot tell a
// photograph from a story by title alone — "Milky way over Yosemite with a
// climber on El Capitan" reads as a strong topic and scored 89 — so the
// submission target is the signal that separates them.
export type PostKind = 'image' | 'self' | 'link'

// Hosts that serve only media. v.redd.it is here with the image hosts on
// purpose: a reddit-hosted clip is the same "look at this thing I made"
// artifact as a reddit-hosted photo. A third-party video (youtu.be) is not,
// and stays 'link' so an explainer can still win on merit.
const MEDIA_HOSTS = new Set([
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'imgur.com',
  'i.imgur.com',
])

const MEDIA_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.gifv',
  '.webp',
  '.bmp',
  '.mp4',
  '.webm',
  '.mov',
]

// Reddit serves its own image galleries off the main host, so a host check
// alone misses them.
const GALLERY_PATH = /^\/gallery\//

const REDDIT_HOSTS = new Set(['www.reddit.com', 'reddit.com', 'old.reddit.com'])

const COMMENTS_PATH = /^\/r\/[^/]+\/comments\//

/**
 * Classify a Reddit submission target.
 *
 * Fails OPEN: an absent or unparseable target is 'link', never 'image', so an
 * unrecognized shape gets scored rather than silently discarded. Dropping is
 * the destructive outcome, so it requires positive evidence.
 */
export function classifyTarget(targetUrl: string | undefined): PostKind {
  if (targetUrl === undefined) return 'link'
  let url: URL
  try {
    url = new URL(targetUrl)
  } catch {
    return 'link'
  }
  const host = url.hostname.toLowerCase()
  if (MEDIA_HOSTS.has(host)) return 'image'
  // pathname excludes the query, so ?width=640 cannot defeat the check.
  const path = url.pathname.toLowerCase()
  if (MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext))) return 'image'
  if (REDDIT_HOSTS.has(host)) {
    if (GALLERY_PATH.test(url.pathname)) return 'image'
    if (COMMENTS_PATH.test(url.pathname)) return 'self'
  }
  return 'link'
}
