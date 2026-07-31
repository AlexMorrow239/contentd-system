// Reddit self-post bodies, extracted from the Atom <content> element.
//
// Reddit wraps selftext in an SC_OFF/SC_ON comment pair and appends a
// "submitted by /u/x [link] [comments]" anchor run OUTSIDE it. Slicing the
// marked span therefore extracts the body and drops the boilerplate in one
// step — and the span's ABSENCE is exactly the bodyless case (a link post,
// or r/AskReddit's title-only posts, which carry anchors and nothing else).

/**
 * Below this many words a "body" is a title restated, not a story worth
 * narrating. A code constant rather than channel config, same as
 * SCOUT_MIN_SCORE.
 */
export const STORY_MIN_BODY_WORDS = 40

const SC_SPAN = /<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/

// The named entities reddit actually emits, plus numeric forms. A map rather
// than a dependency: the set is small, closed, and this module must stay pure.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * ONE HTML-entity decode. fast-xml-parser has already performed the XML-level
 * decode by the time content reaches here (see src/scout/sources/reddit.ts),
 * so `&amp;#39;` on the wire arrives as `&#39;` and resolves to an apostrophe
 * in a single pass. A second pass would turn an author's literal `&lt;` into
 * live markup.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isNaN(code) ? whole : String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * The narratable text of a reddit self post, or undefined when the post has
 * no selftext or too little of it to be a story.
 *
 * `minWords` is a parameter only so tests can exercise the formatting rules on
 * short inputs; production always takes the default.
 */
export function storyBody(
  contentHtml: string | undefined,
  minWords: number = STORY_MIN_BODY_WORDS,
): string | undefined {
  if (contentHtml === undefined) return undefined
  const span = SC_SPAN.exec(contentHtml)
  if (span === null) return undefined

  const text = decodeEntities(
    span[1]
      // Block boundaries become paragraph breaks before tags are stripped;
      // afterwards the information is gone.
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|li|h[1-6]|blockquote)\s*>/gi, '\n\n')
      .replace(/<[^>]*>/g, ''),
  )
    // Collapse runs of spaces/tabs WITHIN a line, leaving newlines alone.
    .replace(/[^\S\n]+/g, ' ')
    // A paragraph break is exactly two newlines, however many arrived.
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (countWords(text) < minWords) return undefined
  return text
}
