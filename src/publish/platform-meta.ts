import { z } from 'zod'

// The shape of one platform's entry in library.metadata_json's per-platform
// map — written by the script stage (src/stages/script.ts) and read back by
// the publish tick (resolvePlatformMeta in ./types.ts). Both sides share this
// one definition: a one-sided tighten would silently route valid rows to the
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
// attempts — three burnt slots and a good video retired by the poison cap.
// Normalizing on the read side keeps a near-miss publishable.
export const TITLE_MAX_CHARS = 100
export const DESCRIPTION_MAX_CHARS = 5000

export function normalizeTitle(title: string): string {
  return title.replace(/[<>]/g, '').trim().slice(0, TITLE_MAX_CHARS)
}

// The exact description youtubeTarget.upload sends: hashtags are appended to
// the description body, so the 5000-char limit applies to this combined form
// rather than to the description alone. The adapter composes it by calling
// here, so the bounded form and the sent form are the same string by
// construction.
export function renderDescription(description: string, hashtags: string[]): string {
  return hashtags.length > 0 ? `${description}\n\n${hashtags.join(' ')}` : description
}

/**
 * Bound one platform entry to what the platform will actually accept.
 * Well-formed metadata passes through unchanged; only the over-long or
 * malformed parts are rewritten. An emptied title is the caller's cue to fall
 * back to a topic-derived one.
 */
export function normalizePlatformMeta(meta: PlatformMeta): PlatformMeta {
  // A hashtag with whitespace inside is two tags glued together (or a stray
  // fragment) — it renders as garbage in the description and as a bogus tag.
  const hashtags = meta.hashtags.filter((h) => h !== '' && !/\s/.test(h))
  // Trim the description first: it carries the copy. Trailing hashtags only go
  // when the block alone still busts the limit.
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
