// Splitting one story into Short-length parts.
//
// Pure and parameterized: production always passes STORY_WORDS_PER_PART, but
// taking the budget as an argument is what lets the boundary arithmetic be
// tested at sizes small enough to read.

import { countWords } from './body.js'

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

/**
 * Floor for a series' final part. qc.ts's `minMs` is 15000 (15s); at this
 * codebase's narration pace of ~2.5-3 words/sec that is ~38-45 words, so 50
 * leaves margin for the spoken hook ("Part two.") that precedes the body. A
 * final part under this is merged into its predecessor rather than shipped
 * (and QC-failed) on its own — see the merge step in splitStory below.
 */
export const STORY_MIN_TAIL_WORDS = 50

interface Chunk {
  text: string
  words: number
  /** Whether a paragraph break followed this chunk in the source. */
  endsParagraph: boolean
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
        words: countWords(sentence),
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
  // Unreachable in production (STORY_WORDS_PER_PART is a positive code
  // constant), but a zero or negative budget would otherwise step the loop
  // below by 0 or backwards and never terminate.
  if (wordsPerPart <= 0) return [chunk]
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

// A part's chunks joined back into prose: a blank line where the source had a
// paragraph break, a plain space between sentences of the same paragraph.
// `endsParagraph` survives explode() and the packing loop untouched, so this
// is the one place it is finally consumed.
function joinChunks(chunks: Chunk[]): string {
  let out = chunks[0]?.text ?? ''
  for (let k = 1; k < chunks.length; k += 1) {
    out += (chunks[k - 1].endsParagraph ? '\n\n' : ' ') + chunks[k].text
  }
  return out
}

function chunkWords(chunks: Chunk[]): number {
  return chunks.reduce((sum, c) => sum + c.words, 0)
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

  const partChunks: Chunk[][] = []
  let i = 0
  while (i < chunks.length && partChunks.length < maxParts) {
    let taken = 0
    let count = 0
    // Always take at least one chunk, so a chunk at exactly the budget cannot
    // stall the loop.
    while (
      i + count < chunks.length &&
      (count === 0 || taken + chunks[i + count].words <= wordsPerPart)
    ) {
      taken += chunks[i + count].words
      count += 1
    }
    // Prefer ending on a paragraph break, if one falls late enough in the part
    // that cutting there does not waste most of the budget. Scans the WHOLE
    // packed range and keeps the LAST qualifying break, not the first: on 122
    // real story bodies, taking the first break inside the window cost 8% more
    // parts and 19% more truncated stories than taking the last one, because it
    // gives up budget the greedy pack had already earned. This can only shrink
    // `count` from the greedy value above, never grow it past what was packed.
    let cut = -1
    let running = 0
    for (let k = 0; k < count; k += 1) {
      running += chunks[i + k].words
      if (chunks[i + k].endsParagraph && running >= wordsPerPart * PARAGRAPH_PREFERENCE) {
        cut = k
      }
    }
    if (cut !== -1) count = cut + 1
    partChunks.push(chunks.slice(i, i + count))
    i += count
  }
  const truncated = i < chunks.length

  // A final part under STORY_MIN_TAIL_WORDS reads as a runt: on 122 real story
  // bodies, 19% ended with a final part under 40 words (tails as short as 1
  // word observed), which passes voice synthesis's own duration floor but
  // fails qc.ts's `minMs` (15s) — the job lands 'needs-review' and never
  // publishes. Merging it into its predecessor instead lets that last part run
  // over budget. Only when there IS a predecessor: a single part below the
  // threshold is the entire story and has nothing to merge into.
  //
  // Bound: every packed part above is <= wordsPerPart (explode() already
  // guarantees no single chunk exceeds it), so the merged part is at most
  // STORY_WORDS_PER_PART + STORY_MIN_TAIL_WORDS - 1 = 160 + 50 - 1 = 209 words
  // (~70-84s at 2.5-3 words/sec), comfortably under qc.ts's `maxMs` (180s). If
  // either constant changes, re-check that this sum still clears `maxMs`.
  if (partChunks.length > 1) {
    const last = partChunks[partChunks.length - 1]
    if (chunkWords(last) < STORY_MIN_TAIL_WORDS) {
      const prev = partChunks[partChunks.length - 2]
      partChunks.splice(partChunks.length - 2, 2, [...prev, ...last])
    }
  }

  return { parts: partChunks.map(joinChunks), truncated }
}
