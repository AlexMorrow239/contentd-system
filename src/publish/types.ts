import {
  normalizePlatformMeta,
  normalizeTitle,
  platformEntrySchema,
  type PlatformMeta,
} from './platform-meta.js'

// One platform's entry out of library.metadata_json's per-platform map —
// re-exported so this module stays the whole publish type surface.
export type { PlatformMeta }

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
  constructor(
    message: string,
    public kind: PublishErrorKind,
  ) {
    super(message)
    this.name = 'PublishError'
  }
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

// library.metadata_json is the per-platform map the script stage writes
// (src/stages/script.ts platformMetaSchema): {youtube:{...}, tiktok:{...},
// instagram:{...}}, or legacy '{}' for library rows produced before platform
// metadata existed. Any way that map can fail to yield a valid entry for
// `platform` — corrupt JSON, a missing key, a malformed entry — falls back
// to a synthesized meta so old or broken library rows stay publishable
// instead of blocking their slot forever.
//
// This is also the single read-side choke point for platform limits, so every
// entry leaves here normalized (normalizePlatformMeta): the schema has no
// length caps, and metadata is never rewritten between attempts, so an
// over-long model title would otherwise be rejected identically at all three.
export function resolvePlatformMeta(
  metadataJson: string,
  platform: Platform,
  fallbackTopic: string,
): PlatformMeta {
  const fallback: PlatformMeta = {
    title: normalizeTitle(fallbackTopic.slice(0, 90)),
    description: '',
    hashtags: [],
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(metadataJson)
  } catch {
    return fallback
  }
  if (parsed === null || typeof parsed !== 'object') return fallback
  const entry = (parsed as Record<string, unknown>)[platform]
  const result = platformEntrySchema.safeParse(entry)
  if (!result.success) return fallback
  const meta = normalizePlatformMeta(result.data)
  // A title that normalizes away to nothing (whitespace, or only the characters
  // the platform rejects) is a guaranteed 400 — keep the entry's copy, take the
  // topic-derived title.
  return meta.title === '' ? { ...meta, title: fallback.title } : meta
}
