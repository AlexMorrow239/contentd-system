import { z } from 'zod'

// Deliberately NOT .strict() here — channel.ts's per-platform target schema
// extends this with an optional `slots` override and applies .strict() to
// the EXTENDED shape, so an unknown key under [publish.instagram] (e.g. a
// stray category_id) fails there, not here.
export const youtubeOptionsSchema = z.object({
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
  category_id: z.number().int().positive().default(24),
  made_for_kids: z.boolean().default(false),
})
export type YoutubeOptionsRaw = z.infer<typeof youtubeOptionsSchema>

export const instagramOptionsSchema = z.object({
  ig_user_id: z.string().min(1, 'ig_user_id must not be empty'),
  share_to_feed: z.boolean().default(true),
})
export type InstagramOptionsRaw = z.infer<typeof instagramOptionsSchema>

export interface YoutubeOptions {
  privacy: 'public' | 'unlisted' | 'private'
  categoryId: number
  madeForKids: boolean
}

export interface InstagramOptions {
  igUserId: string
  shareToFeed: boolean
}

export function normalizeYoutubeOptions(raw: YoutubeOptionsRaw): YoutubeOptions {
  return { privacy: raw.privacy, categoryId: raw.category_id, madeForKids: raw.made_for_kids }
}

export function normalizeInstagramOptions(raw: InstagramOptionsRaw): InstagramOptions {
  return { igUserId: raw.ig_user_id, shareToFeed: raw.share_to_feed }
}
