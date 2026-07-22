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
})
