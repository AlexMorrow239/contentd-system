import { describe, expect, it } from 'vitest'
import {
  INSTAGRAM_CAPTION_MAX_CHARS,
  INSTAGRAM_MAX_HASHTAGS,
  normalizePlatformMeta,
  normalizeTitle,
  platformEntrySchema,
  renderCaption,
  renderDescription,
  renderTags,
  TAGS_MAX_CHARS,
  tagsPayloadLength,
  TIKTOK_CAPTION_MAX_CHARS,
} from '../meta.js'

describe('normalizePlatformMeta', () => {
  describe('platformEntrySchema', () => {
    it('accepts a well-formed entry', () => {
      const entry = { title: 'T', description: 'D', hashtags: ['#a'] }
      expect(platformEntrySchema.safeParse(entry).success).toBe(true)
    })

    it('rejects an entry with the wrong shape', () => {
      expect(
        platformEntrySchema.safeParse({ title: 'T', description: 'D', hashtags: 'not-an-array' })
          .success,
      ).toBe(false)
    })
  })

  describe('normalizeTitle', () => {
    it('strips angle brackets and trims to 100 chars', () => {
      expect(normalizeTitle('The <b>weirdest</b> moon')).toBe('The bweirdest/b moon')
      expect(normalizeTitle('y'.repeat(108))).toBe('y'.repeat(100))
    })
  })

  describe('renderDescription', () => {
    it('appends hashtags to the description body', () => {
      expect(renderDescription('D', ['#a', '#b'])).toBe('D\n\n#a #b')
    })

    it('leaves the description untouched with no hashtags', () => {
      expect(renderDescription('D', [])).toBe('D')
    })
  })

  describe('renderTags', () => {
    it('strips the leading # from each tag', () => {
      expect(renderTags(['#a', '#b'])).toEqual(['a', 'b'])
    })
  })

  describe('tagsPayloadLength', () => {
    it('counts tag characters plus one separator per gap', () => {
      expect(tagsPayloadLength(['aa', 'bb'])).toBe(5)
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
      expect(renderCaption({ title: 'T', description: 'D', hashtags: [] })).toBe('T\n\nD')
    })
  })

  describe('youtube', () => {
    it('passes well-formed metadata through byte-identical', () => {
      const entry = {
        title: 'Why Saturn Would Float',
        description: 'A 45-second tour of the least dense planet in the solar system.',
        hashtags: ['#space', '#saturn', '#shorts'],
      }
      expect(normalizePlatformMeta(entry, 'youtube')).toEqual(entry)
    })

    it('caps a 108-char model title at the 100 chars YouTube accepts', () => {
      const meta = normalizePlatformMeta(
        { title: 'y'.repeat(108), description: 'd', hashtags: [] },
        'youtube',
      )
      expect(meta.title).toBe('y'.repeat(100))
    })

    it('bounds description plus rendered hashtags to the 5000 chars YouTube allows', () => {
      const meta = normalizePlatformMeta(
        { title: 'ok', description: 'd'.repeat(5000), hashtags: ['#a', '#b'] },
        'youtube',
      )
      expect(meta.hashtags).toEqual(['#a', '#b'])
      expect(renderDescription(meta.description, meta.hashtags)).toHaveLength(5000)
    })

    it('drops trailing hashtags when the hashtag block alone busts the limit', () => {
      const meta = normalizePlatformMeta(
        { title: 'ok', description: 'd', hashtags: Array(700).fill('#aaaaaa') },
        'youtube',
      )
      expect(meta.hashtags.length).toBeLessThan(700)
      expect(renderDescription(meta.description, meta.hashtags).length).toBeLessThanOrEqual(5000)
    })

    it('bounds the tags payload to the 500 chars YouTube allows', () => {
      const meta = normalizePlatformMeta(
        { title: 'ok', description: 'd', hashtags: Array(60).fill('#aaaaaaaaaa') },
        'youtube',
      )
      expect(meta.hashtags.length).toBeLessThan(60)
      expect(tagsPayloadLength(renderTags(meta.hashtags))).toBeLessThanOrEqual(TAGS_MAX_CHARS)
      expect(meta.hashtags[0]).toBe('#aaaaaaaaaa')
    })

    it('drops empty and whitespace-bearing hashtags', () => {
      const meta = normalizePlatformMeta(
        { title: 'ok', description: 'd', hashtags: ['#space', '', '#two words', ' ', '#ok'] },
        'youtube',
      )
      expect(meta.hashtags).toEqual(['#space', '#ok'])
    })
  })

  describe('instagram', () => {
    it('passes a short caption through untouched', () => {
      const entry = { title: 'Saturn', description: 'It would float.', hashtags: ['#space'] }
      expect(normalizePlatformMeta(entry, 'instagram')).toEqual(entry)
    })

    it('trims the composed caption to 2200 chars', () => {
      const meta = normalizePlatformMeta(
        { title: 't', description: 'd'.repeat(2300), hashtags: [] },
        'instagram',
      )
      expect(renderCaption(meta).length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_CHARS)
    })

    it('caps hashtags at 30', () => {
      const meta = normalizePlatformMeta(
        { title: 't', description: 'd', hashtags: Array(40).fill('#x') },
        'instagram',
      )
      expect(meta.hashtags.length).toBeLessThanOrEqual(INSTAGRAM_MAX_HASHTAGS)
    })

    // Regression: the hashtag-trim loop used to measure the composed caption
    // against the RAW (un-normalized) title, which overestimates the length
    // and drops hashtags that fit comfortably once the title is normalized
    // down to 100 chars.
    it('normalizes the title before measuring the caption for hashtag trimming', () => {
      const hashtags = ['#one', '#two', '#three', '#four', '#five']
      const meta = normalizePlatformMeta(
        { title: 'T'.repeat(200), description: 'd'.repeat(1980), hashtags },
        'instagram',
      )
      expect(meta.title).toHaveLength(100)
      expect(meta.hashtags).toEqual(hashtags)
      expect(renderCaption(meta).length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_CHARS)
    })

    // Regression (M1): the hashtag-trim loop used to measure the composed
    // caption against the FULL, untruncated description — so a long
    // description ate every hashtag before the description itself was ever
    // trimmed.
    it('trims a long description rather than dropping hashtags that would otherwise fit', () => {
      const hashtags = ['#a', '#b', '#c']
      const meta = normalizePlatformMeta(
        { title: 't', description: 'd'.repeat(3000), hashtags },
        'instagram',
      )
      expect(meta.hashtags).toEqual(hashtags)
      expect(meta.description.length).toBeLessThan(3000)
      expect(renderCaption(meta).length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_CHARS)
    })

    // Regression (M1, combined-limits interaction): both bounds fire on the
    // same input — over 30 hashtags forces the count cap, AND the
    // description alone is long enough that the composed caption would
    // still exceed 2200 after the count cap alone.
    it('trims the description, not further hashtags, when both the count cap and the char budget are in play', () => {
      const hashtags = Array(40).fill('#tag')
      const meta = normalizePlatformMeta(
        { title: 't', description: 'd'.repeat(3000), hashtags },
        'instagram',
      )
      expect(meta.hashtags.length).toBe(30)
      expect(meta.description.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeLessThan(3000)
      expect(renderCaption(meta).length).toBeLessThanOrEqual(INSTAGRAM_CAPTION_MAX_CHARS)
    })
  })

  describe('tiktok', () => {
    it('composes title and description into one caption, like instagram', () => {
      const meta = { title: 'A title', description: 'A body', hashtags: ['#one', '#two'] }
      expect(normalizePlatformMeta(meta, 'tiktok')).toEqual(meta)
      expect(renderCaption(meta)).toBe('A title\n\nA body\n\n#one #two')
    })

    it('trims the description to fit the 2200-char caption budget', () => {
      const meta = {
        title: 'T',
        description: 'x'.repeat(3000),
        hashtags: ['#tag'],
      }
      const out = normalizePlatformMeta(meta, 'tiktok')
      expect(renderCaption(out).length).toBe(TIKTOK_CAPTION_MAX_CHARS)
      expect(out.hashtags).toEqual(['#tag'])
    })

    it('drops whitespace-bearing hashtags', () => {
      const out = normalizePlatformMeta(
        { title: 'T', description: 'd', hashtags: ['#ok', '#not ok', ''] },
        'tiktok',
      )
      expect(out.hashtags).toEqual(['#ok'])
    })

    // TikTok counts characters, not hashtags — unlike Instagram's cap of 30.
    it('keeps more than 30 hashtags when they fit', () => {
      const hashtags = Array.from({ length: 35 }, (_, i) => `#t${i}`)
      const out = normalizePlatformMeta({ title: 'T', description: '', hashtags }, 'tiktok')
      expect(out.hashtags).toHaveLength(35)
    })
  })
})
