import { describe, expect, it } from 'vitest'
import {
  PUBLISH_PLATFORMS,
  PublishError,
  PublishOutcomeUnknownError,
  resolvePlatformMeta,
} from './types.js'
import type { PublishErrorKind } from './types.js'
import { renderCaption, renderTags, TAGS_MAX_CHARS, tagsPayloadLength } from './platform-meta.js'

describe('PUBLISH_PLATFORMS', () => {
  it('is youtube and instagram', () => {
    expect(PUBLISH_PLATFORMS).toEqual(['youtube', 'instagram'])
  })
})

describe('PublishOutcomeUnknownError', () => {
  it('is a named Error subclass', () => {
    const err = new PublishOutcomeUnknownError('accepted but unreadable')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PublishOutcomeUnknownError')
    expect(err.message).toBe('accepted but unreadable')
  })
})

describe('PublishError', () => {
  it('carries its kind alongside the standard Error message', () => {
    const err = new PublishError('mintAccessToken: refresh rejected', 'auth')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('mintAccessToken: refresh rejected')
    expect(err.kind).toBe('auth')
  })

  it.each<PublishErrorKind>(['auth', 'quota', 'rejected', 'transient'])(
    'accepts kind %s',
    (kind) => {
      const err = new PublishError('boom', kind)
      expect(err.kind).toBe(kind)
    },
  )
})

describe('resolvePlatformMeta', () => {
  const fullMap = JSON.stringify({
    youtube: { title: 'YT Title', description: 'YT description', hashtags: ['#space', '#shorts'] },
    tiktok: { title: 'TT Title', description: 'TT description', hashtags: ['#tiktok'] },
    instagram: { title: 'IG Title', description: 'IG description', hashtags: ['#reels'] },
  })

  it('picks the youtube entry out of a full per-platform map', () => {
    const meta = resolvePlatformMeta(fullMap, 'youtube', 'fallback topic')
    expect(meta).toEqual({
      title: 'YT Title',
      description: 'YT description',
      hashtags: ['#space', '#shorts'],
    })
  })

  it('falls back on a legacy empty-object row', () => {
    const meta = resolvePlatformMeta('{}', 'youtube', 'fallback topic')
    expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
  })

  it('falls back on invalid JSON', () => {
    const meta = resolvePlatformMeta('not json at all', 'youtube', 'fallback topic')
    expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
  })

  it('falls back when the entry has the wrong types', () => {
    const badMap = JSON.stringify({
      youtube: { title: 'YT Title', description: 'YT description', hashtags: 'not-an-array' },
    })
    const meta = resolvePlatformMeta(badMap, 'youtube', 'fallback topic')
    expect(meta).toEqual({ title: 'fallback topic', description: '', hashtags: [] })
  })

  it('slices a fallback topic over 90 chars down to 90', () => {
    const longTopic = 'x'.repeat(120)
    const meta = resolvePlatformMeta('{}', 'youtube', longTopic)
    expect(meta.title).toBe('x'.repeat(90))
    expect(meta.title).toHaveLength(90)
  })

  // The bounds YouTube enforces (100-char title, no `<`/`>`, 5000 chars for the
  // description body it actually receives) live only in the script prompt, so a
  // model that overshoots by one word gets a deterministic 'rejected' at every
  // slot. resolvePlatformMeta is the single read-side choke point, so the
  // normalization lands here.
  describe('normalization', () => {
    // Mirrors what youtubeTarget.upload sends as `snippet.description`.
    const renderedDescription = (meta: { description: string; hashtags: string[] }) =>
      meta.hashtags.length > 0
        ? `${meta.description}\n\n${meta.hashtags.join(' ')}`
        : meta.description

    const mapOf = (entry: Record<string, unknown>) => JSON.stringify({ youtube: entry })

    it('passes well-formed metadata through byte-identical', () => {
      const entry = {
        title: 'Why Saturn Would Float',
        description: 'A 45-second tour of the least dense planet in the solar system.',
        hashtags: ['#space', '#saturn', '#shorts'],
      }
      const meta = resolvePlatformMeta(mapOf(entry), 'youtube', 'fallback topic')
      expect(meta).toEqual(entry)
    })

    it('caps a 108-char model title at the 100 chars YouTube accepts', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'y'.repeat(108), description: 'd', hashtags: [] }),
        'youtube',
        'fallback topic',
      )
      expect(meta.title).toBe('y'.repeat(100))
    })

    it('strips the angle brackets YouTube 400s on', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'The <b>weirdest</b> moon', description: 'd', hashtags: [] }),
        'youtube',
        'fallback topic',
      )
      expect(meta.title).toBe('The bweirdest/b moon')
    })

    it('falls back to the topic title when the title normalizes to nothing', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: '  <>  ', description: 'kept', hashtags: ['#kept'] }),
        'youtube',
        'fallback topic',
      )
      expect(meta).toEqual({ title: 'fallback topic', description: 'kept', hashtags: ['#kept'] })
    })

    it('bounds description plus rendered hashtags to the 5000 chars YouTube allows', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'ok', description: 'd'.repeat(5000), hashtags: ['#a', '#b'] }),
        'youtube',
        'fallback topic',
      )
      expect(meta.hashtags).toEqual(['#a', '#b'])
      expect(renderedDescription(meta)).toHaveLength(5000)
    })

    it('drops trailing hashtags when the hashtag block alone busts the limit', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'ok', description: 'd', hashtags: Array(700).fill('#aaaaaa') }),
        'youtube',
        'fallback topic',
      )
      expect(meta.hashtags.length).toBeLessThan(700)
      expect(renderedDescription(meta).length).toBeLessThanOrEqual(5000)
    })

    // The description bound alone does not cover this: YouTube rejects a
    // request whose `tags` array totals over 500 chars, and the description
    // has ten times that room, so a hashtag block well inside 5000 could
    // still 400 the upload at every attempt.
    it('bounds the tags payload to the 500 chars YouTube allows', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'ok', description: 'd', hashtags: Array(60).fill('#aaaaaaaaaa') }),
        'youtube',
        'fallback topic',
      )
      expect(meta.hashtags.length).toBeLessThan(60)
      expect(tagsPayloadLength(renderTags(meta.hashtags))).toBeLessThanOrEqual(TAGS_MAX_CHARS)
      // Trailing tags go; the leading ones survive intact.
      expect(meta.hashtags[0]).toBe('#aaaaaaaaaa')
    })

    it('leaves an ordinary hashtag set untouched by the tags bound', () => {
      const entry = { title: 'ok', description: 'd', hashtags: ['#space', '#saturn', '#shorts'] }
      const meta = resolvePlatformMeta(mapOf(entry), 'youtube', 'fallback topic')
      expect(meta.hashtags).toEqual(entry.hashtags)
    })

    it('drops empty and whitespace-bearing hashtags', () => {
      const meta = resolvePlatformMeta(
        mapOf({
          title: 'ok',
          description: 'd',
          hashtags: ['#space', '', '#two words', ' ', '#ok'],
        }),
        'youtube',
        'fallback topic',
      )
      expect(meta.hashtags).toEqual(['#space', '#ok'])
    })
  })
})

describe('resolvePlatformMeta — instagram normalization', () => {
  const mapOf = (entry: Record<string, unknown>) => JSON.stringify({ instagram: entry })

  it('passes a short caption through untouched', () => {
    const entry = { title: 'Saturn', description: 'It would float.', hashtags: ['#space'] }
    const meta = resolvePlatformMeta(mapOf(entry), 'instagram', 'fallback topic')
    expect(meta).toEqual(entry)
  })

  it('trims the composed caption to 2200 chars', () => {
    const meta = resolvePlatformMeta(
      mapOf({ title: 't', description: 'd'.repeat(2300), hashtags: [] }),
      'instagram',
      'fallback topic',
    )
    const composed = `${meta.title}\n\n${meta.description}`
    expect(composed.length).toBeLessThanOrEqual(2200)
  })

  it('caps hashtags at 30', () => {
    const meta = resolvePlatformMeta(
      mapOf({ title: 't', description: 'd', hashtags: Array(40).fill('#x') }),
      'instagram',
      'fallback topic',
    )
    expect(meta.hashtags.length).toBeLessThanOrEqual(30)
  })

  it('does not apply the youtube 100-char title cap to the display title', () => {
    // Instagram has no title field on the wire, but meta.title stays populated
    // for digest/dashboard display; it is still bounded to 100 for consistency.
    const meta = resolvePlatformMeta(
      mapOf({ title: 'y'.repeat(150), description: 'd', hashtags: [] }),
      'instagram',
      'fallback topic',
    )
    expect(meta.title).toHaveLength(100)
  })

  // Regression: the hashtag-trim loop used to measure the composed caption
  // against the RAW (un-normalized) title, which overestimates the length
  // and drops hashtags that fit comfortably once the title is normalized
  // down to 100 chars. With a 200-char title and a description sized so the
  // composed caption only clears 2200 chars once the title shrinks, all
  // hashtags should survive.
  it('normalizes the title before measuring the caption for hashtag trimming', () => {
    const hashtags = ['#one', '#two', '#three', '#four', '#five']
    const meta = resolvePlatformMeta(
      mapOf({ title: 'T'.repeat(200), description: 'd'.repeat(1980), hashtags }),
      'instagram',
      'fallback topic',
    )
    expect(meta.title).toHaveLength(100)
    expect(meta.hashtags).toEqual(hashtags)
    const composed = `${meta.title}\n\n${meta.description}\n\n${meta.hashtags.join(' ')}`
    expect(composed.length).toBeLessThanOrEqual(2200)
  })
})

describe('renderCaption', () => {
  it('joins title, description, and hashtags with blank lines', () => {
    const caption = renderCaption({
      title: 'Why Saturn Would Float',
      description: 'A 45-second tour of the least dense planet.',
      hashtags: ['#space', '#saturn'],
    })
    expect(caption).toBe(
      'Why Saturn Would Float\n\nA 45-second tour of the least dense planet.\n\n#space #saturn',
    )
  })

  it('omits the hashtag block when there are no hashtags', () => {
    const caption = renderCaption({ title: 'T', description: 'D', hashtags: [] })
    expect(caption).toBe('T\n\nD')
  })
})
