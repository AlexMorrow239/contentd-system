// v1 ships YouTube Shorts only; PublishTarget, the publishes table, and the
// scheduler stay platform-agnostic so TikTok/Instagram are additive later
// (design spec decision 1).
export const PUBLISH_PLATFORMS = ['youtube'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]

export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'

// Thrown only for platform-call failures (mintAccessToken, PublishTarget.upload)
// — config/validation errors stay plain `Error` per house style. `kind` drives
// the tick's attempt-failure handling and the digest's per-kind messaging.
export class PublishError extends Error {
  constructor(message: string, public kind: PublishErrorKind) {
    super(message)
    this.name = 'PublishError'
  }
}

// One platform's entry out of library.metadata_json's per-platform map.
export interface PlatformMeta {
  title: string
  description: string
  hashtags: string[]
}

// Parsed [publish] TOML table for a channel (src/config/channel.ts, Task 5).
export interface PublishChannelConfig {
  slots: string[]
  platforms: Platform[]
  privacy: 'public' | 'unlisted' | 'private'
  categoryId: number
  madeForKids: boolean
}

export interface PublishTarget {
  readonly platformId: Platform
  upload(
    req: { videoPath: string; meta: PlatformMeta; publish: PublishChannelConfig },
    accessToken: string,
  ): Promise<{ postId: string; url: string }>
}
