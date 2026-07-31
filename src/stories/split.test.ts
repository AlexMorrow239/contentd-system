import { describe, expect, it } from 'vitest'
import { splitStory, STORY_WORDS_PER_PART } from './split.js'

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
    const text = [S(1), S(2), S(3), S(4)].join(' ')
    const result = splitStory(text, 30, 4)
    expect(result.parts).toEqual([[S(1), S(2), S(3)].join(' '), S(4)])
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
    const text = Array.from({ length: 20 }, (_, i) => S(i + 1)).join(' ')
    const result = splitStory(text, 30, 4)
    expect(result.parts).toHaveLength(4)
    expect(result.truncated).toBe(true)
  })

  it('does not flag truncation when the text ends exactly at maxParts', () => {
    const text = [S(1), S(2), S(3), S(4), S(5), S(6)].join(' ')
    const result = splitStory(text, 30, 2)
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
    // than emitting one enormous part or looping forever.
    const runOn = Array.from({ length: 50 }, (_, i) => `word${i + 1}`).join(' ')
    const result = splitStory(runOn, 20, 4)
    expect(result.parts).toHaveLength(3)
    expect(result.parts[0].split(/\s+/)).toHaveLength(20)
    expect(result.parts.join(' ')).toBe(runOn)
    expect(result.truncated).toBe(false)
  })

  it('prefers a paragraph boundary near the end of the budget', () => {
    // Two sentences (20w), a paragraph break, then two more. At a 30-word
    // budget the greedy cut would take three sentences; the paragraph break
    // at 20 words is inside the preference window, so it wins.
    const text = `${S(1)} ${S(2)}\n\n${S(3)} ${S(4)}`
    const result = splitStory(text, 30, 4)
    expect(result.parts[0]).toBe(`${S(1)} ${S(2)}`)
    expect(result.parts[1]).toBe(`${S(3)} ${S(4)}`)
  })

  it('returns no parts for empty text', () => {
    expect(splitStory('   ', 30, 4)).toEqual({ parts: [], truncated: false })
  })

  it('exports a 160-word default part budget', () => {
    expect(STORY_WORDS_PER_PART).toBe(160)
  })
})
