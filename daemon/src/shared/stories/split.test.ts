import { describe, expect, it } from 'vitest'
import { STORY_MIN_TAIL_WORDS, STORY_WORDS_PER_PART, splitStory } from './split.js'

// Ten words per sentence keeps the arithmetic obvious: a 30-word budget takes
// exactly three sentences per part.
const S = (n: number): string => `Sentence ${n} has exactly ten words in it right here.`

describe('splitStory', () => {
  it('returns one part when the text fits the budget', () => {
    const result = splitStory(`${S(1)} ${S(2)}`, 30, 4)
    expect(result.parts).toEqual([`${S(1)} ${S(2)}`])
    expect(result.truncated).toBe(false)
  })

  it('packs whole sentences up to the budget', () => {
    // A 100-word budget (not this file's usual 30) so the second part (60w)
    // clears STORY_MIN_TAIL_WORDS and this test stays about packing, not
    // about the tail merge covered separately below.
    const text = Array.from({ length: 16 }, (_, i) => S(i + 1)).join(' ')
    const result = splitStory(text, 100, 4)
    expect(result.parts).toEqual([
      Array.from({ length: 10 }, (_, i) => S(i + 1)).join(' '),
      Array.from({ length: 6 }, (_, i) => S(i + 11)).join(' '),
    ])
    expect(result.truncated).toBe(false)
  })

  it('never cuts mid-sentence', () => {
    const text = [S(1), S(2), S(3), S(4), S(5)].join(' ')
    for (const part of splitStory(text, 25, 4).parts) {
      expect(part).toMatch(/\.$/)
      expect(part.startsWith('Sentence')).toBe(true)
    }
  })

  it('flags truncation and emits exactly maxParts', () => {
    // 60-word budget (6 sentences/part, 60w) so the 4th (last) part clears
    // STORY_MIN_TAIL_WORDS and this test stays about the maxParts cap, not
    // the tail merge covered separately below.
    const text = Array.from({ length: 30 }, (_, i) => S(i + 1)).join(' ')
    const result = splitStory(text, 60, 4)
    expect(result.parts).toHaveLength(4)
    expect(result.truncated).toBe(true)
  })

  it('does not flag truncation when the text ends exactly at maxParts', () => {
    // 60-word budget so both parts (60w each) clear STORY_MIN_TAIL_WORDS.
    const text = Array.from({ length: 12 }, (_, i) => S(i + 1)).join(' ')
    const result = splitStory(text, 60, 2)
    expect(result.parts).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('honours maxParts of 1', () => {
    const text = [S(1), S(2), S(3), S(4)].join(' ')
    const result = splitStory(text, 20, 1)
    expect(result.parts).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('word-splits a single sentence longer than the budget', () => {
    // No sentence boundary to cut on: falls back to a word boundary rather
    // than emitting one enormous part or looping forever. 180 words at a
    // 60-word budget divides evenly into three 60-word pieces so none of
    // them is a sub-threshold tail — this test is about the word fallback,
    // not the tail merge covered separately below.
    const runOn = Array.from({ length: 180 }, (_, i) => `word${i + 1}`).join(' ')
    const result = splitStory(runOn, 60, 4)
    expect(result.parts).toHaveLength(3)
    expect(result.parts[0].split(/\s+/)).toHaveLength(60)
    expect(result.parts.join(' ')).toBe(runOn)
    expect(result.truncated).toBe(false)
  })

  it('prefers a paragraph boundary near the end of the budget', () => {
    // Two sentences (20w), a paragraph break, then enough trailing content
    // that the final part clears STORY_MIN_TAIL_WORDS — this test is only
    // about the preference cut winning on part 0, not the tail merge covered
    // separately below. At a 30-word budget the greedy cut would take three
    // sentences; the paragraph break at 20 words is inside the preference
    // window, so it wins.
    const text = `${S(1)} ${S(2)}\n\n${Array.from({ length: 9 }, (_, i) => S(i + 3)).join(' ')}`
    const result = splitStory(text, 30, 4)
    expect(result.parts[0]).toBe(`${S(1)} ${S(2)}`)
  })

  it('returns no parts for empty text', () => {
    expect(splitStory('   ', 30, 4)).toEqual({ parts: [], truncated: false })
  })

  it('exports a 160-word default part budget', () => {
    expect(STORY_WORDS_PER_PART).toBe(160)
  })

  it('exports a 50-word minimum tail', () => {
    expect(STORY_MIN_TAIL_WORDS).toBe(50)
  })

  it('preserves an interior paragraph break with a blank-line join', () => {
    // The break after S(1) (10 words) is well before the 60% preference
    // window (18 words of a 30-word budget), so packing continues through it
    // into the second paragraph — but the joined text must still show where
    // the break was, or storySegments' paragraph split downstream sees one
    // unbroken run instead of two.
    const text = `${S(1)}\n\n${S(2)} ${S(3)}`
    const result = splitStory(text, 30, 4)
    expect(result.parts).toEqual([`${S(1)}\n\n${S(2)} ${S(3)}`])
  })

  it('prefers the LAST qualifying paragraph break in range, not the first', () => {
    // Two paragraph breaks both fall inside the preference window (after
    // S(4) at 40 words, and after S(5) at 50, against a 60-word budget whose
    // window starts at 36). Six more sentences follow so the tail this test
    // isn't about (STORY_MIN_TAIL_WORDS) never enters into it. Taking the
    // first break cost 8% more parts and 19% more truncated stories across
    // the real corpus this rule was tuned against — the break after S(5)
    // must win.
    const text =
      `${S(1)} ${S(2)} ${S(3)} ${S(4)}\n\n${S(5)}\n\n` +
      `${S(6)} ${S(7)} ${S(8)} ${S(9)} ${S(10)} ${S(11)}`
    const result = splitStory(text, 60, 4)
    expect(result.parts[0]).toBe(`${S(1)} ${S(2)} ${S(3)} ${S(4)}\n\n${S(5)}`)
    expect(result.parts[1]).toBe(`${S(6)} ${S(7)} ${S(8)} ${S(9)} ${S(10)} ${S(11)}`)
    expect(result.truncated).toBe(false)
  })

  it('merges a sub-threshold final part into the predecessor, preserving all text', () => {
    const text = Array.from({ length: 20 }, (_, i) => S(i + 1)).join(' ')
    // Budget 90 packs 9 ten-word sentences per part: S(1..9), S(10..18), then
    // a two-sentence, 20-word tail (S19, S20) — well under STORY_MIN_TAIL_WORDS.
    // Without the merge this would ship as its own runt part.
    const result = splitStory(text, 90, 10)
    expect(result.parts).toHaveLength(2)
    expect(result.parts.join(' ')).toBe(text)
    expect(result.parts[1].split(/\s+/).length).toBeGreaterThanOrEqual(STORY_MIN_TAIL_WORDS)
    expect(result.truncated).toBe(false)
  })

  it('leaves a lone below-threshold part alone', () => {
    // The whole story is one part under STORY_MIN_TAIL_WORDS: there is no
    // predecessor to merge it into, so it ships as-is.
    const result = splitStory(S(1), 160, 4)
    expect(result.parts).toEqual([S(1)])
  })
})
