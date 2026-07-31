// Splitting one story into Short-length parts.
//
// Pure and parameterized: production always passes STORY_WORDS_PER_PART, but
// taking the budget as an argument is what lets the boundary arithmetic be
// tested at sizes small enough to read.

/**
 * Words per part. ~160 words is ~60 seconds at a typical narration pace, which
 * is one Short. A code constant, not channel config — the only story dial an
 * operator gets is max_parts.
 */
export const STORY_WORDS_PER_PART = 160

/**
 * How close to the budget a paragraph break has to be before it is preferred
 * over the greedy sentence cut. 0.6 means a break at or past 60% of the budget
 * wins; anything earlier would waste too much of the part. A part ending on a
 * paragraph break reads as a deliberate beat, which matters most on the last
 * part of a truncated series.
 */
const PARAGRAPH_PREFERENCE = 0.6

interface Chunk {
  text: string
  words: number
  /** Whether a paragraph break followed this chunk in the source. */
  endsParagraph: boolean
}

function words(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * Sentences, tagged with whether a paragraph break followed. Paragraphs are
 * split first so the break survives; sentences within a paragraph are split on
 * terminal punctuation followed by whitespace.
 */
function sentences(text: string): Chunk[] {
  const out: Chunk[] = []
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  paragraphs.forEach((paragraph, pIndex) => {
    const parts = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    parts.forEach((sentence, sIndex) => {
      out.push({
        text: sentence,
        words: words(sentence),
        endsParagraph: sIndex === parts.length - 1 && pIndex < paragraphs.length - 1,
      })
    })
  })
  return out
}

/**
 * A sentence that alone exceeds the budget has no boundary to cut on, so it is
 * broken on word boundaries into budget-sized pieces. Rare in practice (a
 * run-on with no terminal punctuation), but without it one such sentence would
 * produce a single part many minutes long.
 */
function explode(chunk: Chunk, wordsPerPart: number): Chunk[] {
  if (chunk.words <= wordsPerPart) return [chunk]
  const tokens = chunk.text.split(/\s+/)
  const out: Chunk[] = []
  for (let i = 0; i < tokens.length; i += wordsPerPart) {
    const slice = tokens.slice(i, i + wordsPerPart)
    out.push({
      text: slice.join(' '),
      words: slice.length,
      endsParagraph: chunk.endsParagraph && i + wordsPerPart >= tokens.length,
    })
  }
  return out
}

/**
 * Split `text` into at most `maxParts` parts of about `wordsPerPart` words,
 * cutting only at sentence (preferably paragraph) boundaries.
 *
 * `truncated` is true when the text needed more than `maxParts` — the caller
 * ships the parts it got and appends a pointer to the source (spec: "cap,
 * publish first N parts").
 */
export function splitStory(
  text: string,
  wordsPerPart: number,
  maxParts: number,
): { parts: string[]; truncated: boolean } {
  const chunks = sentences(text).flatMap((c) => explode(c, wordsPerPart))
  if (chunks.length === 0) return { parts: [], truncated: false }

  const parts: string[] = []
  let i = 0
  while (i < chunks.length && parts.length < maxParts) {
    let taken = 0
    let count = 0
    // Always take at least one chunk, so a chunk at exactly the budget cannot
    // stall the loop.
    while (i + count < chunks.length && (count === 0 || taken + chunks[i + count].words <= wordsPerPart)) {
      taken += chunks[i + count].words
      count += 1
    }
    // Prefer ending on a paragraph break, if one falls late enough in the part
    // that cutting there does not waste most of the budget.
    let running = 0
    for (let k = 0; k < count; k += 1) {
      running += chunks[i + k].words
      if (chunks[i + k].endsParagraph && running >= wordsPerPart * PARAGRAPH_PREFERENCE) {
        count = k + 1
        break
      }
    }
    parts.push(
      chunks
        .slice(i, i + count)
        .map((c) => c.text)
        .join(' '),
    )
    i += count
  }
  return { parts, truncated: i < chunks.length }
}
