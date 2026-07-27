import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { parseTokenKey } from '../publish/crypto.js'
import { publishMedia } from '../publish/media.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import {
  claimPublish,
  eligibleVideo,
  lastAttemptAt,
  markPublishDone,
  markPublishFailed,
  sweepInterrupted,
  uploadsUsedToday,
  videosPublishedToday,
} from '../publish/publishes.js'
import type { EligibleVideo } from '../publish/publishes.js'
import { channelNotDueReason, localDay, orderChannels } from '../publish/schedule.js'
import type { ChannelCandidate, NotDueReason } from '../publish/schedule.js'
import {
  PUBLISH_PLATFORMS,
  PublishError,
  PublishOutcomeUnknownError,
  resolvePlatformMeta,
} from '../publish/types.js'
import type { Platform, PublishAdapter, PublishTargetConfig } from '../publish/types.js'
import type { ObjectStore } from '../storage/types.js'
import { acquireLease, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'

export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?:
    | 'lease-held'
    | 'not-in-window'
    | 'paced'
    | 'daily-count-met'
    | 'platform-quota'
    | 'no-ready-video'
    | 'no-video-file'
    | 'no-auth'
    | 'claim-conflict'
    | 'bad-env'
    | 'config-error'
  channel?: string
  platform?: Platform
  jobId?: string
  seq?: number
  postId?: string
  url?: string
  error?: string
  wouldPublish?: {
    channel: string
    platform: Platform
    jobId: string
    title: string
  } | null
}

// Checks BRAINROT_TOKEN_KEY and every registered platform's quota env var —
// whose malformed values would otherwise throw from deep inside the tick
// (exit 1, no JSON line, every firing, no DB trace). Never names a platform
// literal: it iterates the quota descriptors generically, so a third
// platform's own env var is covered for free.
function badEnvMessage(): string | undefined {
  const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
  if (tokenKeyHex) {
    try {
      parseTokenKey(tokenKeyHex)
    } catch {
      return 'BRAINROT_TOKEN_KEY is malformed (expected 64 hex characters)'
    }
  }
  for (const quota of Object.values(PLATFORM_QUOTAS)) {
    try {
      quota.cap()
    } catch {
      return `${quota.envVar} is malformed (expected a positive integer number of uploads)`
    }
  }
  return undefined
}

// How many pruned ready videos one candidate may step over before the tick
// gives up on its channel. Reaching it is pathological (a wholesale runs/
// prune), and giving up is harmless: the next tick starts the scan over.
const MAX_VIDEO_FILE_SCANS = 50

/**
 * Selects and executes one upload: env check -> per-channel due gate (window,
 * pacing gap, day count) -> fairness order -> candidate scan (quota,
 * credential, video and its bytes) -> claim -> resolveCredential -> upload ->
 * finalize. The publish lease and repair sweep wrap this in the next cycle.
 * Names no platform literal anywhere in this file — guarded by a structural
 * test.
 */
export async function publishNextTick(
  db: Database,
  opts: {
    channelsDir: string
    adapters?: Partial<Record<Platform, PublishAdapter>>
    fetchImpl?: typeof fetch
    now?: () => Date
    dryRun?: boolean
    force?: boolean
    // Injectable for tests (a fakeStore); production leaves this undefined
    // and resolveStore() below builds the real s3Store lazily, once per tick.
    store?: ObjectStore
  },
): Promise<PublishTickResult> {
  const nowFn = opts.now ?? (() => new Date())
  const dryRun = opts.dryRun ?? false
  const force = opts.force ?? false
  const adapters = Object.fromEntries(
    PUBLISH_PLATFORMS.map((p) => [p, opts.adapters?.[p] ?? ADAPTERS[p](opts.fetchImpl)]),
  ) as Record<Platform, PublishAdapter>

  // Built lazily, at the single upload attempt: a tick that publishes nothing
  // never needs a store, and constructing one would demand S3 credentials from
  // an otherwise-working YouTube-only deployment. A construction failure (no
  // credentials configured) degrades to "no store available" rather than
  // crashing the tick — it surfaces later as a legible per-video 'rejected'
  // error only if an Instagram upload actually calls media.url().
  const resolveStore = async (): Promise<ObjectStore | null> => {
    if (opts.store !== undefined) return opts.store
    try {
      const { storeFromEnv } = await import('../storage/s3.js')
      return storeFromEnv()
    } catch {
      return null
    }
  }

  // Env validation comes BEFORE the lease and any candidate work: a bad value
  // blocks the whole tick either way, and nothing should be claimed or leased
  // on its behalf. Same shape as every other blocked-tick outcome — one JSON
  // line, exit 0, a named cause — matching how these vars behave when unset.
  const envError = badEnvMessage()
  if (envError !== undefined) {
    return { action: 'noop', reason: 'bad-env', error: envError }
  }
  // Same rule for the channels dir, and for the same reason it sits ahead of
  // the lease: a broken channel TOML (or a missing dir) blocks every candidate,
  // so nothing should be leased on its behalf.
  const loaded = tryLoadChannelsDir(opts.channelsDir)
  if (loaded.error !== undefined) {
    console.error(`publish-next: ${loaded.error}`)
    return { action: 'noop', reason: 'config-error', error: loaded.error }
  }
  const channels = loaded.channels
  // A held lease is the NORMAL case while a previous firing's upload is still
  // in flight — benign no-op, exit 0 at the CLI. Dry-run never touches the
  // lease: it is a pure read-only preview, never a competing writer.
  const holder = `pid:${process.pid}`
  if (!dryRun && !acquireLease(db, 'publish', holder, PUBLISH_LEASE_TTL_MS)) {
    return { action: 'noop', reason: 'lease-held' }
  }
  try {
    const now = nowFn()
    if (!dryRun) {
      // Repair sweep (publish-analog of produce-next's topic sweep): a tick
      // that died mid-upload leaves a stale 'claimed' row — heal it to
      // 'interrupted' before planning this tick's attempt.
      sweepInterrupted(db, PUBLISH_LEASE_TTL_MS, now)
    }
    const day = localDay(now)

    // Which channels are due, and why the rest are not. Pacing is per
    // CHANNEL, not per (channel, platform): videos_per_day counts videos, and
    // a video goes to every platform the channel declares.
    const candidates: ChannelCandidate[] = []
    let notDue: NotDueReason | undefined
    for (const channel of channels) {
      if (channel.publish === null) continue
      const publishedToday = videosPublishedToday(db, channel.name, day)
      // --force is the local-testing bypass: it skips the window, the min
      // gap, and the day count so ticks can be fired back to back. It never
      // skips quota, credentials, or eligibility — a forced test must not be
      // able to overrun a platform's real daily cap.
      const reason = force
        ? undefined
        : channelNotDueReason({
            videosPerDay: channel.videosPerDay,
            publishedToday,
            lastAttemptAt: lastAttemptAt(db, channel.name),
            now,
          })
      if (reason !== undefined) {
        // The first skipped channel's reason wins the report — channels arrive
        // name-ordered, so with one channel this is exact and with several it
        // is indicative. Same convention as firstReason below: the tick reports
        // ONE cause, not a per-channel breakdown (that is the digest's job).
        if (notDue === undefined) notDue = reason
        continue
      }
      candidates.push({
        channel: channel.name,
        publishedToday,
        videosPerDay: channel.videosPerDay,
      })
    }
    if (candidates.length === 0) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: notDue }
        : { action: 'noop', reason: notDue }
    }

    const ordered = orderChannels(candidates)
    const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
    const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

    // Quota gate (design spec §7, decision 7): usage is computed once per
    // distinct (scope-appropriate) key rather than per candidate.
    const usageCache = new Map<string, number>()
    function underQuota(platform: Platform, channel: string): boolean {
      const adapter = adapters[platform]
      const key = adapter.quota.scope === 'global' ? platform : `${platform}:${channel}`
      let used = usageCache.get(key)
      if (used === undefined) {
        used = uploadsUsedToday(
          db,
          platform,
          day,
          adapter.quota.scope === 'channel' ? channel : undefined,
        )
        usageCache.set(key, used)
      }
      return used < adapter.quota.cap()
    }

    let firstReason: 'no-ready-video' | 'no-video-file' | 'no-auth' | 'platform-quota' | undefined
    // `target` (not a bare options object) so the option type stays narrowed to
    // its platform all the way to the upload call. `tokenKey` rides along
    // already narrowed to Buffer: the credential gate below is what proves it
    // is set, and carrying it here is what lets the upload block use it with
    // no non-null assertion.
    let picked:
      | { channel: string; target: PublishTargetConfig; video: EligibleVideo; tokenKey: Buffer }
      | undefined

    for (const candidate of ordered) {
      const channel = channels.find((c) => c.name === candidate.channel)
      if (channel === undefined || channel.publish === null) continue
      for (const target of channel.publish.targets) {
        if (!underQuota(target.platform, channel.name)) {
          if (firstReason === undefined) firstReason = 'platform-quota'
          continue
        }
        // hasCredential is a cheap, non-network check (env presence, a
        // decryptable stored token) — safe to run per-target before any claim.
        if (
          tokenKey === undefined ||
          !adapters[target.platform].hasCredential(db, channel.name, tokenKey)
        ) {
          if (firstReason === undefined) firstReason = 'no-auth'
          continue
        }
        // Video pre-flight, unchanged from today: a candidate qualifies if the
        // bytes are reachable AT ALL — a local file OR a stored object. A pruned
        // runs/ tree is normal (the bucket is the durable copy), so requiring the
        // local file would skip every archived video. A row with neither would
        // burn a quota unit on a failure the adapter can only call 'rejected'.
        // eligibleVideo returns only the TOP row, so an unreachable one must be
        // excluded and the query re-run.
        const prunedJobIds: string[] = []
        let video: EligibleVideo | null = null
        for (let scan = 0; scan < MAX_VIDEO_FILE_SCANS; scan++) {
          const row = eligibleVideo(db, channel.name, target.platform, prunedJobIds)
          if (row === null) break
          if (row.objectKey !== null || existsSync(row.videoPath)) {
            video = row
            break
          }
          prunedJobIds.push(row.jobId)
        }
        if (video === null) {
          if (firstReason === undefined) {
            firstReason = prunedJobIds.length === 0 ? 'no-ready-video' : 'no-video-file'
          }
          continue
        }
        picked = { channel: channel.name, target, video, tokenKey }
        break
      }
      if (picked !== undefined) break
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason }
    }

    const { channel: pickedChannel, target, video, tokenKey: pickedTokenKey } = picked
    const pickedPlatform = target.platform
    const meta = resolvePlatformMeta(video.metadataJson, pickedPlatform, video.topic)

    if (dryRun) {
      return {
        action: 'dry-run',
        wouldPublish: {
          channel: pickedChannel,
          platform: pickedPlatform,
          jobId: video.jobId,
          title: meta.title,
        },
      }
    }

    // The UNIQUE(channel, platform, day, seq) constraint is the real guard; a
    // conflict here means a racing tick won this ordinal — unreachable under
    // the publish lease, but a defensive exit rather than a crash.
    const claim = claimPublish(db, {
      jobId: video.jobId,
      platform: pickedPlatform,
      channel: pickedChannel,
      day,
    })
    if (claim === null) {
      return { action: 'noop', reason: 'claim-conflict' }
    }

    // ONLY the platform calls (credential resolution + upload) sit inside the
    // failure-mapping catch. A throw from anything after them cannot be
    // mapped to a failure kind, because by then the post may already be live.
    let uploaded: { postId: string; url: string }
    try {
      const adapter = adapters[pickedPlatform]
      const credential = await adapter.resolveCredential(db, pickedChannel, pickedTokenKey, now)
      uploaded = await adapter.upload(
        {
          media: publishMedia({
            objectKey: video.objectKey,
            localPath: video.videoPath,
            store: await resolveStore(),
          }),
          meta,
          options: target.options,
        },
        credential,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // PublishOutcomeUnknownError means the platform ACCEPTED the post and
      // only its answer was unreadable. Marking that row failed would return
      // the video to the eligibility pool and publish it a second time, so it
      // stays 'claimed' for the sweep — same operator path as a crashed tick.
      if (!(err instanceof PublishOutcomeUnknownError)) {
        const kind = err instanceof PublishError ? err.kind : 'transient'
        markPublishFailed(db, claim.id, message, kind, nowFn())
      }
      return {
        action: 'publish-failed',
        channel: pickedChannel,
        platform: pickedPlatform,
        jobId: video.jobId,
        seq: claim.seq,
        error: message,
      }
    }

    // The video is live from here on. A failing finalize write (SQLITE_BUSY
    // past the timeout, disk full) must NOT mark the row failed — that is the
    // duplicate-upload path. Left 'claimed', the next tick's sweep heals it to
    // 'interrupted', which the digest routes to Studio + `publish mark-done`;
    // the post facts ride out in the error text so the operator has them.
    // `nowFn()` again, not the tick's start: finished_at records the write.
    try {
      markPublishDone(db, claim.id, uploaded.postId, uploaded.url, nowFn())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        action: 'publish-failed',
        channel: pickedChannel,
        platform: pickedPlatform,
        jobId: video.jobId,
        seq: claim.seq,
        error: `uploaded ${uploaded.postId} (${uploaded.url}) but recording it failed: ${message}`,
      }
    }
    return {
      action: 'published',
      channel: pickedChannel,
      platform: pickedPlatform,
      jobId: video.jobId,
      seq: claim.seq,
      postId: uploaded.postId,
      url: uploaded.url,
    }
  } finally {
    if (!dryRun) releaseLease(db, 'publish', holder)
  }
}
