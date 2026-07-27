import { describe, expect, it } from 'vitest'
import {
  instagramOptionsSchema,
  normalizeInstagramOptions,
  normalizeYoutubeOptions,
  youtubeOptionsSchema,
} from '../options.js'

describe('youtubeOptionsSchema', () => {
  it('defaults privacy, category_id, made_for_kids when absent', () => {
    const raw = youtubeOptionsSchema.parse({})
    expect(raw).toEqual({ privacy: 'public', category_id: 24, made_for_kids: false })
  })

  it('parses an explicit table', () => {
    const raw = youtubeOptionsSchema.parse({
      privacy: 'private',
      category_id: 22,
      made_for_kids: true,
    })
    expect(normalizeYoutubeOptions(raw)).toEqual({
      privacy: 'private',
      categoryId: 22,
      madeForKids: true,
    })
  })

  it('rejects a non-positive category_id', () => {
    expect(() => youtubeOptionsSchema.parse({ category_id: 0 })).toThrow()
  })
})

describe('instagramOptionsSchema', () => {
  it('requires ig_user_id and defaults share_to_feed to true', () => {
    const raw = instagramOptionsSchema.parse({ ig_user_id: '17841400000000000' })
    expect(normalizeInstagramOptions(raw)).toEqual({
      igUserId: '17841400000000000',
      shareToFeed: true,
    })
  })

  it('rejects an empty ig_user_id', () => {
    expect(() => instagramOptionsSchema.parse({ ig_user_id: '' })).toThrow()
  })

  it('rejects a missing ig_user_id', () => {
    expect(() => instagramOptionsSchema.parse({})).toThrow()
  })
})
