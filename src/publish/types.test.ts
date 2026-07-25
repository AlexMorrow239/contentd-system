import { describe, expect, it } from 'vitest'
import { PUBLISH_PLATFORMS, PublishError, resolvePlatformMeta } from './types.js'
import type { PublishErrorKind } from './types.js'

describe('PUBLISH_PLATFORMS', () => {
  it('is exactly youtube for v1', () => {
    expect(PUBLISH_PLATFORMS).toEqual(['youtube'])
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
      meta.hashtags.length > 0 ? `${meta.description}\n\n${meta.hashtags.join(' ')}` : meta.description

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

    it('drops empty and whitespace-bearing hashtags', () => {
      const meta = resolvePlatformMeta(
        mapOf({ title: 'ok', description: 'd', hashtags: ['#space', '', '#two words', ' ', '#ok'] }),
        'youtube',
        'fallback topic',
      )
      expect(meta.hashtags).toEqual(['#space', '#ok'])
    })
  })
})
