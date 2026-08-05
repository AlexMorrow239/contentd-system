import { z } from 'zod'
import type { Platform } from './types.js'

// The shape of one platform's entry in library.metadata_json's per-platform
// map — written by the script stage (src/stages/script.ts) and read back by
// the dashboard's /post page (src/dashboard/queries/post.ts, via
// normalizePlatformMeta below). Both sides share this one definition: a
// one-sided tighten would silently route valid rows to the
// synthesized-fallback title path instead of failing loudly.
export const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
})

export type PlatformMeta = z.infer<typeof platformEntrySchema>

// YouTube 400s a title over 100 chars or carrying `<`/`>`, and a description
// body over 5000 chars. Those bounds live only in the script prompt, so a model
// that overshoots by one word would be rejected identically at all three
// attempts — three burnt attempts and a good video retired by the poison cap.
// Normalizing on the read side keeps a near-miss publishable.
export const TITLE_MAX_CHARS = 100
export const DESCRIPTION_MAX_CHARS = 5000
// YouTube also 400s a request whose `tags` array totals over 500 characters —
// a separate, far tighter budget than the description's, and one a hashtag
// block comfortably inside 5000 chars can still blow.
export const TAGS_MAX_CHARS = 500

// A Reel has one caption, no title field — the platform never receives
// meta.title on its own. 2200 is Instagram's caption limit; 30 is its
// hashtag-count limit (a distinct kind of bound from YouTube's char-count
// tags budget, since Instagram counts hashtags, not characters).
export const INSTAGRAM_CAPTION_MAX_CHARS = 2200
export const INSTAGRAM_MAX_HASHTAGS = 30

// TikTok's caption budget. Same composed shape as Instagram (one caption, no
// separate title field) but it bounds CHARACTERS only — there is no
// hashtag-count cap to mirror INSTAGRAM_MAX_HASHTAGS.
export const TIKTOK_CAPTION_MAX_CHARS = 2200

export function normalizeTitle(title: string): string {
  return title.replace(/[<>]/g, '').trim().slice(0, TITLE_MAX_CHARS)
}

// The exact description the dashboard's /post page shows the operator to
// paste into YouTube: hashtags are appended to the description body, so the
// 5000-char limit applies to this combined form rather than to the
// description alone. The page composes it by calling here, so the bounded
// form and the pasted form are the same string by construction.
export function renderDescription(description: string, hashtags: string[]): string {
  return hashtags.length > 0 ? `${description}\n\n${hashtags.join(' ')}` : description
}

// The exact tags array the dashboard's /post page shows for pasting into
// YouTube: the leading '#' is not part of a YouTube tag. Same construction
// rule as renderDescription — the page composes through here, so the bounded
// form and the pasted form are one string list by construction.
export function renderTags(hashtags: string[]): string[] {
  return hashtags.map((h) => h.replace(/^#/, ''))
}

// What the 500-char budget is measured against: the tag characters plus one
// separator between adjacent tags. The separator term is how YouTube accounts
// for the list, and counting it here keeps the bound conservative rather than
// landing exactly on a limit the API might measure a byte differently.
export function tagsPayloadLength(tags: string[]): number {
  return tags.reduce((n, t) => n + t.length, 0) + Math.max(0, tags.length - 1)
}

// The exact string the dashboard's /post page shows the operator to paste as
// the Reel caption — title doubles as a display-only headline Instagram never
// receives on its own, so composing it in is how the model's title still
// reaches the post. Same construction rule as renderDescription: the bounded
// form (below) and the pasted form are one string by construction.
export function renderCaption(meta: PlatformMeta): string {
  return `${meta.title}\n\n${renderDescription(meta.description, meta.hashtags)}`
}

// A hashtag with whitespace inside is two tags glued together (or a stray
// fragment) — it renders as garbage in a description or caption and as a
// bogus tag. Every platform drops those before applying its own bounds.
function sanitizeHashtags(hashtags: string[]): string[] {
  return hashtags.filter((h) => h !== '' && !/\s/.test(h))
}

function normalizeForYoutube(meta: PlatformMeta): PlatformMeta {
  const hashtags = sanitizeHashtags(meta.hashtags)
  // Tags budget first: the tighter of the two, and drops from the same tail
  // a set that fits here can still need description trimming below.
  while (hashtags.length > 0 && tagsPayloadLength(renderTags(hashtags)) > TAGS_MAX_CHARS) {
    hashtags.pop()
  }
  while (hashtags.length > 0 && renderDescription('', hashtags).length > DESCRIPTION_MAX_CHARS) {
    hashtags.pop()
  }
  const room = DESCRIPTION_MAX_CHARS - renderDescription('', hashtags).length
  return {
    title: normalizeTitle(meta.title),
    description: meta.description.slice(0, room),
    hashtags,
  }
}

/**
 * The composed-caption shape: one caption carrying title, description and
 * hashtags, bounded by a character budget. Instagram and TikTok differ only
 * in that budget and in whether the platform caps hashtag COUNT — TikTok
 * does not, so `maxHashtags` is optional rather than a sentinel number.
 *
 * YouTube deliberately does not go through here: it has a real title field,
 * a separate tags array, and its own tighter tags budget.
 */
function normalizeComposedCaption(
  meta: PlatformMeta,
  bounds: { maxChars: number; maxHashtags?: number },
): PlatformMeta {
  // Normalize the title BEFORE the trim loop below: normalizeTitle only ever
  // shrinks, so trimming hashtags against the raw (longer) title would
  // overestimate the composed length and drop hashtags that fit once the
  // title is actually normalized.
  const title = normalizeTitle(meta.title)
  const sanitized = sanitizeHashtags(meta.hashtags)
  const hashtags =
    bounds.maxHashtags === undefined ? sanitized : sanitized.slice(0, bounds.maxHashtags)
  // The description is the least load-bearing part and gets trimmed first
  // (below, via `room`), not the hashtags. This loop only pops hashtags from
  // the tail when the hashtag block ALONE — title + hashtags, description
  // entirely absent — still can't fit; it must not measure against the
  // untruncated meta.description, or a long description would eat every
  // hashtag before the description itself is ever trimmed.
  while (
    hashtags.length > 0 &&
    renderCaption({ title, description: '', hashtags }).length > bounds.maxChars
  ) {
    hashtags.pop()
  }
  const fixedLength = renderCaption({ title, description: '', hashtags }).length
  const room = Math.max(0, bounds.maxChars - fixedLength)
  return { title, description: meta.description.slice(0, room), hashtags }
}

function normalizeForInstagram(meta: PlatformMeta): PlatformMeta {
  return normalizeComposedCaption(meta, {
    maxChars: INSTAGRAM_CAPTION_MAX_CHARS,
    maxHashtags: INSTAGRAM_MAX_HASHTAGS,
  })
}

// No hashtag-count cap: TikTok bounds characters only.
function normalizeForTiktok(meta: PlatformMeta): PlatformMeta {
  return normalizeComposedCaption(meta, { maxChars: TIKTOK_CAPTION_MAX_CHARS })
}

/**
 * Bound one platform entry to what the platform will actually accept.
 * Well-formed metadata passes through unchanged; only the over-long or
 * malformed parts are rewritten. An emptied title is the caller's cue to fall
 * back to a topic-derived one.
 */
// An exhaustive map, not a ternary with a YouTube default: adding a platform
// to PLATFORMS without giving it bounds here is a compile error
// rather than a silent inheritance of YouTube's limits.
const NORMALIZERS: Record<Platform, (meta: PlatformMeta) => PlatformMeta> = {
  youtube: normalizeForYoutube,
  instagram: normalizeForInstagram,
  tiktok: normalizeForTiktok,
}

export function normalizePlatformMeta(meta: PlatformMeta, platform: Platform): PlatformMeta {
  return NORMALIZERS[platform](meta)
}

/**
 * One platform's paste blocks: a `title` only where the platform has a title
 * field of its own, the body it takes, and `tags` only where it takes a
 * separate tags list. Null is the field's absence, not an empty value — the
 * dashboard reads it to decide what to render and what to call the body.
 */
export interface PasteFields {
  title: string | null
  body: string
  tags: string | null
}

// Exhaustive for the same reason NORMALIZERS is, and it is the same decision:
// paste SHAPE and paste BOUNDS both answer "what fields does this platform
// have". Adding a platform to PLATFORMS without giving it a shape here is a
// compile error rather than a silent inheritance of the composed-caption one.
//
// Composed from the render helpers above, so the pasted form stays the form
// the bounds were measured against. `meta` is expected already normalized
// (normalizePlatformMeta) — these compose, they do not bound.
export const PASTE_FIELDS: Record<Platform, (meta: PlatformMeta) => PasteFields> = {
  youtube: (meta) => ({
    title: meta.title,
    body: renderDescription(meta.description, meta.hashtags),
    tags: renderTags(meta.hashtags).join(', '),
  }),
  instagram: (meta) => ({ title: null, body: renderCaption(meta), tags: null }),
  tiktok: (meta) => ({ title: null, body: renderCaption(meta), tags: null }),
}
