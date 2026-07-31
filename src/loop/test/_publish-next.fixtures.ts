import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { parseTokenKey } from '../../publish/crypto.js'
import { PLATFORM_QUOTAS } from '../../publish/platforms/quota.js'
import { YT_UPLOAD_SCOPE } from '../../publish/platforms/youtube.js'
import { upsertToken } from '../../publish/tokens.js'
import type { Platform, PublishAdapter } from '../../publish/types.js'
import { channelToml as kitChannelToml } from '../../testing/channel.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../testing/db.js'
import { tmpDir } from '../../testing/tmp.js'

/**
 * Fixtures shared by the `publish-next.*.test.ts` files.
 *
 * Eleven of these used to sit in a 300-line preamble at the top of one
 * 1825-line file — the largest in the repo, and the reason it could not be
 * split. Row-level SQL now delegates to src/testing/db.ts; what stays here is
 * the publish-tick-specific shaping (adapters, the fan-out fixture, the
 * on-disk video the candidate scan pre-flights).
 */

/**
 * Local-time constructor (month is 0-based): 2026-07-22 14:05 machine-local.
 * Never string-parse datetimes in these tests — 'YYYY-MM-DDTHH:MM' parses
 * local while '...Z' parses UTC, and mixing the two makes assertions
 * timezone-dependent.
 */
export const NOW = () => new Date(2026, 6, 22, 14, 5)

/**
 * 10:00 local on the fixture day: no prior attempt for either channel, so
 * the PUBLISH_COOLDOWN_MS cooldown is clear and the fan-out tests are never
 * gated by pacing.
 */
export const FANOUT_NOW = () => new Date(2026, 6, 22, 10, 0)

export const TEST_TOKEN_KEY_HEX = 'ab'.repeat(32)

/**
 * Plan-1-shape channel TOML plus an optional [publish] table (spec §3.3).
 * `publish: true` declares [publish.youtube]; `instagram: true` adds a second
 * [publish.instagram] target, for the cross-platform/quota tests.
 *
 * Cadence carries no clock times at all now — `videosPerDay` is the whole
 * schedule, so it is what these fixtures tune.
 */
export function channelToml(opts: {
  name: string
  publish?: boolean
  instagram?: boolean
  videosPerDay?: number
}): string {
  const platforms: Platform[] = opts.publish
    ? opts.instagram
      ? ['youtube', 'instagram']
      : ['youtube']
    : []
  return kitChannelToml({
    name: opts.name,
    niche: ['space facts'],
    videosPerDay: opts.videosPerDay ?? 2,
    platforms,
    platformOptions: { instagram: ['ig_user_id = "ig-test"'] },
  })
}

export function writeChannel(
  dir: string,
  opts: { name: string; publish?: boolean; instagram?: boolean; videosPerDay?: number },
): void {
  writeFileSync(join(dir, `${opts.name}.toml`), channelToml(opts))
}

/**
 * The candidate scan pre-flights video_path with existsSync (a pruned runs/
 * tree must never burn a quota unit), so a publishable fixture needs a real
 * file on disk. `videoExists: false` seeds the pruned case: the library row
 * still points at a path, but nothing is there.
 *
 * Module state is per test FILE — vitest isolates the module graph — so the
 * job counter cannot collide across the split files.
 */
let videoRoot: string | undefined
let jobSeq = 0

export function seedReadyVideo(
  db: Database,
  opts: {
    channel: string
    metadataJson?: string
    topic?: string
    videoExists?: boolean
    createdAt?: string
  },
): string {
  jobSeq += 1
  const jobId = `job-${jobSeq}`
  seedJob(db, jobId, { channel: opts.channel, topic: opts.topic ?? 'A test topic' })
  videoRoot ??= tmpDir('brainrot-publish-videos-')
  const videoPath = join(videoRoot, `${jobId}.mp4`)
  if (opts.videoExists !== false) writeFileSync(videoPath, 'fake video bytes')
  // created_at is explicit only where a test pins the candidate scan's
  // newest-first tiebreak; otherwise the column default stands.
  seedLibrary(db, jobId, {
    videoPath,
    metadataJson: opts.metadataJson ?? '{}',
    state: 'ready',
    createdAt: opts.createdAt ?? new Date().toISOString(),
  })
  return jobId
}

/**
 * The library_objects row a real `store` pipeline stage would leave behind —
 * the durable-copy record channelVideoCandidates LEFT JOINs against.
 */
export function seedObjectKey(db: Database, jobId: string, objectKey: string): void {
  seedLibraryObject(db, jobId, { objectKey, bytes: 123, etag: 'etag-test' })
}

export function seedToken(db: Database, channel: string): void {
  const key = parseTokenKey(TEST_TOKEN_KEY_HEX)
  upsertToken(db, 'youtube', channel, 'rt-test-token', YT_UPLOAD_SCOPE, key)
}

/**
 * A pre-existing publish row, for tests that need the day count or the
 * last-attempt clock already populated. `createdAt` must be given whenever the
 * test asserts on pacing — the column's default is the real wall clock, which
 * an injected `now` does not control.
 */
export function seedAttempt(
  db: Database,
  opts: {
    jobId: string
    channel: string
    platform: Platform
    day: string
    seq?: number
    status?: string
    createdAt?: string
  },
): void {
  seedJob(db, opts.jobId, { channel: opts.channel, topic: 'seeded attempt' })
  db.prepare(
    'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 1, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  ).run(
    opts.jobId,
    opts.platform,
    opts.channel,
    opts.day,
    opts.seq ?? 1,
    opts.status ?? 'done',
    opts.createdAt ?? null,
  )
}

// Own counter (not jobSeq/seedReadyVideo's) so a quota-failure row's disposable
// job id can never collide with a real seeded video's job id in the same test.
let quotaFailureSeq = 0

/**
 * A quota-kind publish failure `msAgo` before `now` — the runtime backoff
 * marker publish-next's platformOpen reads (quotaBackedOff, src/publish/
 * publishes.ts). The job id is a disposable placeholder: quotaBackedOff never
 * joins against jobs/library, it only asks "does a recent quota-kind failed
 * row exist for this platform (and, for a channel-scoped platform, this
 * channel)". `seq` rides the same counter so repeated calls for the same
 * (channel, platform) never collide on UNIQUE(channel, platform, day, seq).
 *
 * Only `created_at` is derived from the caller's clock — `day` keeps
 * seedPublish's default ('2026-07-20'), deliberately off any tick's real day,
 * so the row never counts toward videosPublishedToday or the pacing clock.
 * The backoff marker gates the platform without consuming the channel's day.
 */
export function seedQuotaFailure(
  db: Database,
  opts: { channel: string; platform: Platform; now: Date; msAgo: number },
): void {
  quotaFailureSeq += 1
  seedPublish(db, `quota-failure-${quotaFailureSeq}`, {
    platform: opts.platform,
    channel: opts.channel,
    status: 'failed',
    errorKind: 'quota',
    seq: quotaFailureSeq,
    createdAt: new Date(opts.now.getTime() - opts.msAgo).toISOString(),
  })
}

export function fakeAdapter(upload: PublishAdapter['upload']): PublishAdapter {
  return {
    platformId: 'youtube',
    quota: { scope: 'global' },
    postUrl: (postId) => `https://youtube.com/shorts/${postId}`,
    hasCredential: () => true,
    resolveCredential: async () => 'fake-access-token',
    upload,
  }
}

/**
 * The Instagram-shaped sibling of fakeAdapter: a channel-scoped quota and the
 * platform id the tick keys its per-platform work off.
 */
export function fakeIgAdapter(upload: PublishAdapter['upload']): PublishAdapter {
  return {
    platformId: 'instagram',
    quota: { scope: 'channel' },
    postUrl: () => null,
    hasCredential: () => true,
    resolveCredential: async () => 'ig-token',
    upload,
  }
}

/**
 * An Instagram-shaped adapter whose upload resolves `req.media.url()` the same
 * way instagramUploadTarget does (media.ts requires an object key + a store for
 * url() to succeed) — used to exercise the store-resolution path the
 * local-file-only fakeAdapter never touches.
 */
export function urlResolvingAdapter(): PublishAdapter {
  return fakeIgAdapter(async (req) => {
    const url = await req.media.url(7200)
    return { postId: 'ig-post-1', url }
  })
}

/**
 * One channel declaring BOTH [publish.youtube] and [publish.instagram], one
 * ready video with a real local file, and a stub adapter per platform.
 */
export function fanOutFixture(prefix: string): {
  db: Database
  dir: string
  jobId: string
  adapters: Record<Platform, PublishAdapter>
} {
  const db = memDb()
  const dir = tmpDir(prefix)
  writeChannel(dir, { name: 'test', publish: true, instagram: true, videosPerDay: 1 })
  const jobId = seedReadyVideo(db, { channel: 'test', topic: 'Fan-out topic' })
  const adapters: Record<Platform, PublishAdapter> = {
    youtube: {
      ...fakeAdapter(async () => ({ postId: 'yt-1', url: 'https://youtu.be/yt-1' })),
      quota: PLATFORM_QUOTAS.youtube,
    },
    instagram: {
      ...fakeIgAdapter(async () => ({
        postId: 'ig-1',
        url: 'https://instagram.test/ig-1',
      })),
      quota: PLATFORM_QUOTAS.instagram,
    },
  }
  return { db, dir, jobId, adapters }
}

/**
 * The env every publish tick test needs. Storage is left UNCONFIGURED so
 * s3ConfigFromEnv() throws and resolveStore() falls back to null — tests that
 * need a real store inject a fakeStore via opts.store instead.
 */
export function stubPublishEnv(vi: { stubEnv: (k: string, v: string) => void }): void {
  vi.stubEnv('YT_CLIENT_ID', 'test-client-id')
  vi.stubEnv('YT_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('BRAINROT_TOKEN_KEY', TEST_TOKEN_KEY_HEX)
  vi.stubEnv('BRAINROT_S3_ENDPOINT', '')
  vi.stubEnv('BRAINROT_S3_BUCKET', '')
  vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', '')
  vi.stubEnv('BRAINROT_S3_SECRET_ACCESS_KEY', '')
}
