import type { Database } from 'better-sqlite3'
import type { InstagramOptions, YoutubeOptions } from './platforms/options.js'
import {
  normalizePlatformMeta,
  normalizeTitle,
  platformEntrySchema,
  type PlatformMeta,
} from './platform-meta.js'
import { BrainrotError, type ErrorInfo, errorMessage, isAbortLike } from '../errors.js'

export type { PlatformMeta }

export const PUBLISH_PLATFORMS = ['youtube', 'instagram'] as const
export type Platform = (typeof PUBLISH_PLATFORMS)[number]

export type PublishErrorKind = 'auth' | 'quota' | 'rejected' | 'transient'

export class PublishError extends BrainrotError {
  // `declare` is mandatory here: target is ES2022 so useDefineForClassFields
  // is true, and a real field re-declaration would emit a define that
  // overwrites the base constructor's assignment with undefined. This narrows
  // the type only — it emits nothing.
  declare readonly kind: PublishErrorKind

  constructor(message: string, kind: PublishErrorKind) {
    super(message, { domain: 'publish', kind })
    this.name = 'PublishError'
  }
}

// A thrown fetch (network failure, or an aborted/timed-out request) always
// maps to 'transient' — the retry happens at the next due tick (design spec
// decision 7). Shared by every adapter's HTTP call sites; `timeoutMs` is the
// caller's own per-call timeout so the message names the constant that
// actually fired.
export function networkError(op: string, timeoutMs: number, err: unknown): PublishError {
  if (isAbortLike(err)) {
    return new PublishError(`${op}: request timed out after ${timeoutMs}ms`, 'transient')
  }
  return new PublishError(`${op}: request failed: ${errorMessage(err)}`, 'transient')
}

// classify() returns the wide ErrorKind; a `publishes` row stores the narrow
// four-value PublishErrorKind. This is the one narrowing seam between them,
// and it reproduces exactly the previous
// `err instanceof PublishError ? err.kind : 'transient'` fallback.
export function toPublishFailureKind(info: ErrorInfo): PublishErrorKind {
  switch (info.kind) {
    case 'auth':
    case 'quota':
    case 'rejected':
    case 'transient':
      return info.kind
    default:
      return 'transient'
  }
}

// The platform ACCEPTED the post — it exists on the platform — but its
// outcome is unreadable (broken success body, no post id). Never a
// PublishError: no failure kind fits, and marking the row failed would make
// the same video eligible again at the next due tick, publishing it twice.
// The tick leaves the row 'claimed' so the repair sweep heals it to 'interrupted'.
// Shared across every adapter — moved here (was youtube.ts-only) once
// Instagram's media_publish step needed the identical contract.
export class PublishOutcomeUnknownError extends BrainrotError {
  constructor(message: string) {
    super(message, { domain: 'publish', kind: 'unknown-outcome' })
    this.name = 'PublishOutcomeUnknownError'
  }
}

// One platform's quota descriptor (design spec decision 7): 'global' counts
// usage across every channel (YouTube: per Google Cloud project); 'channel'
// counts one channel alone (Instagram: per IG account). cap() reads env at
// call time and may throw on a malformed value — callers surface that as a
// bad-env tick outcome, never a crash.
export interface PlatformQuota {
  scope: 'global' | 'channel'
  envVar: string
  cap(): number
}

// A lazy handle over one finished video, resolved differently per platform:
// YouTube sends bytes, Instagram sends Meta a URL to fetch. Laziness is
// load-bearing — YouTube never signs a URL, Instagram never downloads bytes it
// will not send, and a library row predating library_objects still publishes to
// YouTube from its local file while failing legibly on Instagram.
export interface PublishMedia {
  readonly localPath: string | null
  bytes(): Promise<Buffer<ArrayBuffer>>
  url(ttlSeconds: number): Promise<string>
}

// Everything platform-specific the publish tick needs, behind one seam
// (design spec §5, decision 8). hasCredential is a cheap, non-network check
// used inside the candidate scan, before any claim; resolveCredential is the
// network step (minting/refreshing), called once after the claim.
export interface PublishAdapter<O = unknown> {
  readonly platformId: Platform
  readonly quota: PlatformQuota
  hasCredential(db: Database, channel: string, key: Buffer): boolean
  resolveCredential(db: Database, channel: string, key: Buffer, now: Date): Promise<string>
  // The public post URL derivable from a post id alone, or null when the
  // platform has none (Instagram's permalink is fetched from the media id,
  // not built from it). The manual `publish mark-done` path reads this off
  // the recovered row's own platform, so it can never record one platform's
  // URL shape against another's post.
  postUrl(postId: string): string | null
  upload(
    req: { media: PublishMedia; meta: PlatformMeta; options: O },
    credential: string,
  ): Promise<{ postId: string; url: string }>
}

// Parsed [publish.<platform>] TOML sub-table for one channel
// (src/config/channel.ts). No schedule of its own: cadence comes from the
// channel's videos_per_day, and the window/gap are derived in schedule.ts.
export type PublishTargetConfig =
  | { platform: 'youtube'; options: YoutubeOptions }
  | { platform: 'instagram'; options: InstagramOptions }

// Parsed [publish] TOML table for a channel. A channel with no [publish]
// table at all is `null` on ChannelConfig and never enters the publish pool.
export interface PublishChannelConfig {
  targets: PublishTargetConfig[]
}

// library.metadata_json is the per-platform map the script stage writes
// (src/stages/script.ts platformMetaSchema): {youtube:{...}, tiktok:{...},
// instagram:{...}}, or legacy '{}' for library rows produced before platform
// metadata existed. Any way that map can fail to yield a valid entry for
// `platform` — corrupt JSON, a missing key, a malformed entry — falls back
// to a synthesized meta so old or broken library rows stay publishable
// instead of permanently blocking their place in the day.
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
  const meta = normalizePlatformMeta(result.data, platform)
  // A title that normalizes away to nothing (whitespace, or only the characters
  // the platform rejects) is a guaranteed 400 — keep the entry's copy, take the
  // topic-derived title.
  return meta.title === '' ? { ...meta, title: fallback.title } : meta
}
