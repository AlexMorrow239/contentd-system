import { describe, expect, it } from 'vitest'
import { countWords, storyBody, STORY_MIN_BODY_WORDS } from './body.js'
import {
  LINK_POST_CONTENT,
  LITERAL_ENTITY_CONTENT,
  NESTED_ENTITY_CONTENT,
  SELF_POST_CONTENT,
  TINY_BODY_CONTENT,
} from './_stories.fixtures.js'

describe('storyBody', () => {
  it('extracts the selftext and drops the submitted-by boilerplate', () => {
    const body = storyBody(SELF_POST_CONTENT)
    expect(body).toBe(
      'One month ago I hosted a movie night for my five closest friends. ' +
        "It's a long story but I need to know if I was wrong here.\n\n" +
        'Before the movie a friend called me and asked if she could bring some fruit ' +
        'to blend into a drink for everyone.',
    )
  })

  it('decodes entities exactly once, leaving authored entities intact', () => {
    // &lt; must become '<' (one decode), NOT be decoded again into markup.
    // Floor disabled: this fixture is deliberately short so the assertion is
    // readable, and the floor is covered by its own case below.
    expect(storyBody(LITERAL_ENTITY_CONTENT, 0)).toBe('She said <3 and I said & what.')
  })

  it('decodes only one layer, so a nested entity survives as text', () => {
    // Two decodes would yield '<br>' — live markup in the narration. One
    // decode leaves the author's literal '&lt;br&gt;' visible, as written.
    expect(storyBody(NESTED_ENTITY_CONTENT, 0)).toBe('Type &lt;br&gt; to break a line.')
  })

  it('returns undefined for a link post with no selftext', () => {
    expect(storyBody(LINK_POST_CONTENT)).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(storyBody(undefined)).toBeUndefined()
  })

  it('returns undefined for a body under the word floor', () => {
    expect(countWords('Am I wrong here?')).toBeLessThan(STORY_MIN_BODY_WORDS)
    expect(storyBody(TINY_BODY_CONTENT)).toBeUndefined()
  })

  it('preserves paragraph breaks and collapses stray whitespace', () => {
    const html =
      '<!-- SC_OFF --><div class="md"><p>First   para.</p>\n\n<p>Second<br>line.</p>' +
      '</div><!-- SC_ON -->'
    expect(storyBody(html, 0)).toBe('First para.\n\nSecond\nline.')
  })
})

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('one two  three\nfour')).toBe(4)
  })

  it('counts an empty string as zero', () => {
    expect(countWords('   ')).toBe(0)
  })
})
