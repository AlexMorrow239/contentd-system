import { describe, expect, it } from 'vitest'
import { ALGOSPEAK, sanitizeStory } from './sanitize.js'

describe('sanitizeStory', () => {
  it('substitutes a flagged word', () => {
    expect(sanitizeStory('he said he would kill me')).toBe('he said he would unalive me')
  })

  it('respects word boundaries', () => {
    // 'skilled' contains 'kill' — substituting inside a word is the classic
    // bug this test exists to prevent.
    expect(sanitizeStory('she is highly skilled')).toBe('she is highly skilled')
  })

  it('preserves leading capitalisation', () => {
    expect(sanitizeStory('Killed by the news.')).toBe('Unalived by the news.')
  })

  it('handles an all-caps occurrence without shouting the replacement', () => {
    expect(sanitizeStory('KILL')).toBe('Unalive')
  })

  it('substitutes every occurrence', () => {
    expect(sanitizeStory('kill and kill again')).toBe('unalive and unalive again')
  })

  it('leaves unflagged text byte-identical', () => {
    const text = 'One month ago I hosted a movie night.\n\nIt went badly.'
    expect(sanitizeStory(text)).toBe(text)
  })

  it('round-trips every entry in the map', () => {
    for (const [term, replacement] of Object.entries(ALGOSPEAK)) {
      expect(sanitizeStory(`before ${term} after`)).toBe(`before ${replacement} after`)
    }
  })

  // The round-trip test above cannot tell a good substitution from a bad one —
  // it would pass just as happily for `abuse -> mistreatment`, which turns
  // "he would abuse me" into "he would mistreatment me". This one reads the
  // output as English: every kept entry is exercised in a sentence it actually
  // occurs in, and the result must still be a sentence.
  it('produces grammatical English in real sentences', () => {
    const cases: [string, string][] = [
      ['He said he would kill me.', 'He said he would unalive me.'],
      ['That kills the mood.', 'That unalives the mood.'],
      ['She killed the plant.', 'She unalived the plant.'],
      ['He was killing time.', 'He was unaliving time.'],
      ['He murdered the character.', 'He unalived the character.'],
      ['She mentioned suicide once.', 'She mentioned self-deletion once.'],
      ['He was accused of rape.', 'He was accused of SA.'],
      ['She said he raped her.', 'She said he SA-ed her.'],
      ['He is a known rapist.', 'He is a known SA-er.'],
      ['My grandfather died last year.', 'My grandfather passed last year.'],
      ['We never talk about sex.', 'We never talk about seggs.'],
      ['It was a sexual comment.', 'It was a seggsual comment.'],
      ['He was watching porn.', 'He was watching adult content.'],
      ['She was doing drugs.', 'She was doing substances.'],
      ['He abused her for years.', 'He mistreated her for years.'],
    ]
    for (const [input, expected] of cases) {
      expect(sanitizeStory(input)).toBe(expected)
    }
    // Every entry in the map is covered by a sentence above, so a new entry
    // cannot be added without also proving it reads correctly.
    const covered = new Set(
      cases.flatMap(([input]) => input.toLowerCase().match(/[a-z]+/g) ?? []),
    )
    for (const term of Object.keys(ALGOSPEAK)) {
      expect(covered.has(term), `ALGOSPEAK entry "${term}" has no sentence case`).toBe(true)
    }
  })

  it('leaves the rejected terms alone', () => {
    // These were considered and rejected for mangling ordinary sentences.
    // Reinstating one silently would break narration, so the exclusion is
    // pinned rather than left to a comment.
    expect(sanitizeStory('It was a dead end.')).toBe('It was a dead end.')
    expect(sanitizeStory('I got a flu shot.')).toBe('I got a flu shot.')
    expect(sanitizeStory('He owns a gun.')).toBe('He owns a gun.')
    expect(sanitizeStory('He would abuse me.')).toBe('He would abuse me.')
    // 'unalive' has no noun form, so the bare noun is left alone; the verb
    // form is still covered by the 'murdered' entry.
    expect(sanitizeStory('The police investigated the murder.')).toBe(
      'The police investigated the murder.',
    )
    // 'passing threats' would mean something different from 'death threats'.
    expect(sanitizeStory('He sent me death threats.')).toBe('He sent me death threats.')
  })

  it('keys the map in lowercase so the boundary regex stays predictable', () => {
    for (const term of Object.keys(ALGOSPEAK)) {
      expect(term).toBe(term.toLowerCase())
    }
  })
})
