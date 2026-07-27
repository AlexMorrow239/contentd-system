import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import { parseTokenKey } from '../publish/crypto.js'
import { publishMedia } from '../publish/media.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import {
  channelVideoCandidates,
  claimPublish,
  lastAttemptAt,
  markPublishDone,
  markPublishFailed,
  sweepInterrupted,
  uploadsUsedToday,
  videosPublishedToday,
} from '../publish/publishes.js'
import type { ChannelVideoCandidate } from '../publish/publishes.js'
import { channelNotDueReason, localDay, orderChannels } from '../publish/schedule.js'
import type { ChannelCandidate, NotDueReason } from '../publish/schedule.js'
import {
  PUBLISH_PLATFORMS,
  PublishError,
  PublishOutcomeUnknownError,
  resolvePlatformMeta,
} from '../publish/types.js'
import type { Platform, PublishAdapter } from '../publish/types.js'
import type { ObjectStore } from '../storage/types.js'
import { acquireLease, extendLease, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'

/** One platform's leg of the fan-out — one video, one `publishes` row. */
export interface PublishAttemptResult {
  platform: Platform
  /**
   * 'unknown' is the platform-accepted-but-unreadable case: the row stays
   * 'claimed' for the repair sweep, never 'failed', because marking it failed
   * would publish the same video twice.
   */
  status: 'published' | 'failed' | 'unknown'
  seq?: number
  postId?: string
  url?: string
  error?: string
}

export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?:
    | 'lease-held'
    | 'no-publish-channel'
    | 'not-in-window'
    | 'paced'
    | 'daily-count-met'
    | 'platform-quota'
    | 'no-ready-video'
    | 'no-video-file'
    | 'no-auth'
    | 'bad-env'
    | 'config-error'
  channel?: string
  jobId?: string
  /** One entry per platform attempted, in the channel's target order. */
  results?: PublishAttemptResult[]
  error?: string
  wouldPublish?: {
    channel: string
    jobId: string
    title: string
    platforms: Platform[]
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
 * Selects ONE video and fans it out to every platform that still wants it: env
 * check -> per-channel due gate (window, pacing gap, day count) -> fairness
 * order -> candidate scan (bytes reachable, then per-platform quota and
 * credential) -> per platform: claim -> resolveCredential -> upload ->
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

  // Built lazily, at the first upload attempt: a tick that publishes nothing
  // never needs a store, and constructing one would demand S3 credentials from
  // an otherwise-working YouTube-only deployment. A construction failure (no
  // credentials configured) degrades to "no store available" rather than
  // crashing the tick — it surfaces later as a legible per-video 'transient'
  // error only if an upload actually reaches through the media handle.
  //
  // Memoized, because a fan-out builds one media handle per platform and each
  // needs the store: without this, every leg of the fan-out would re-import and
  // re-construct an S3 client for the same bucket.
  let storeOnce: Promise<ObjectStore | null> | undefined
  const resolveStore = (): Promise<ObjectStore | null> => {
    storeOnce ??= (async () => {
      if (opts.store !== undefined) return opts.store
      try {
        const { storeFromEnv } = await import('../storage/s3.js')
        return storeFromEnv()
      } catch {
        return null
      }
    })()
    return storeOnce
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
    // Distinguishes "nothing to consider" from "considered and not due": a
    // channel only flips this once it clears the `publish === null` skip
    // below, so it stays false when the channels dir declares no [publish]
    // table at all (or is empty) — the pacing reasons below never fire in
    // that case, and without this flag the tick would fall through with no
    // reason at all.
    let anyChannelConsidered = false
    for (const channel of channels) {
      if (channel.publish === null) continue
      anyChannelConsidered = true
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
      // No channel considered at all (no [publish] table anywhere, or an
      // empty channels dir) outranks any pacing reason, because there is
      // none to report — notDue is only ever set inside the loop above,
      // which a channel must clear the `publish === null` skip to reach.
      const reason = anyChannelConsidered ? notDue : 'no-publish-channel'
      return dryRun ? { action: 'dry-run', wouldPublish: null, reason } : { action: 'noop', reason }
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
    // One video, plus the platforms it can actually reach this tick — the whole
    // fan-out is planned before anything is claimed. `tokenKey` rides along as a
    // plain Buffer (the credential gate below is what proves it is set) so the
    // upload loop never has to re-check it.
    let picked:
      | {
          channel: ChannelConfig
          video: ChannelVideoCandidate
          platforms: Platform[]
          tokenKey: Buffer
        }
      | undefined

    for (const candidate of ordered) {
      const channel = channels.find((c) => c.name === candidate.channel)
      if (channel === undefined || channel.publish === null) continue
      const declared = channel.publish.targets.map((t) => t.platform)
      // MAX_VIDEO_FILE_SCANS bounds the walk: a wholesale runs/ prune with no
      // stored objects is the only way to reach it, and giving up is harmless —
      // the next tick starts the scan over.
      for (const video of channelVideoCandidates(db, channel.name, MAX_VIDEO_FILE_SCANS)) {
        // Bytes-reachable pre-flight: a local file OR a stored object. A pruned
        // runs/ tree is normal (the bucket is the durable copy); a row with
        // NEITHER would burn a quota unit on a failure the adapter can only
        // report as 'rejected'.
        if (video.objectKey === null && !existsSync(video.videoPath)) {
          if (firstReason === undefined) firstReason = 'no-video-file'
          continue
        }
        const open: Platform[] = []
        for (const platform of declared) {
          if (video.blockedPlatforms.includes(platform)) continue
          if (!underQuota(platform, channel.name)) {
            if (firstReason === undefined) firstReason = 'platform-quota'
            continue
          }
          // hasCredential is a cheap, non-network check (env presence, a
          // decryptable stored token) — safe before any claim.
          if (
            tokenKey === undefined ||
            !adapters[platform].hasCredential(db, channel.name, tokenKey)
          ) {
            if (firstReason === undefined) firstReason = 'no-auth'
            continue
          }
          open.push(platform)
        }
        if (open.length === 0) continue
        // `open` is non-empty only if the credential gate above ran
        // hasCredential, which it can only do with a key in hand — so the cast
        // records an invariant the control flow already proved.
        picked = { channel, video, platforms: open, tokenKey: tokenKey as Buffer }
        break
      }
      if (picked !== undefined) break
      if (firstReason === undefined) firstReason = 'no-ready-video'
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason }
    }

    const { channel: pickedChannel, video, platforms, tokenKey: pickedTokenKey } = picked

    if (dryRun) {
      // The preview shows one title, so it shows the first platform's — each
      // platform normalizes the same script metadata to its own limits, and a
      // dry run is for confirming WHICH video goes out, not its exact copy.
      const meta = resolvePlatformMeta(video.metadataJson, platforms[0], video.topic)
      return {
        action: 'dry-run',
        wouldPublish: {
          channel: pickedChannel.name,
          jobId: video.jobId,
          title: meta.title,
          platforms,
        },
      }
    }

    const results: PublishAttemptResult[] = []
    for (const [index, platform] of platforms.entries()) {
      // Heartbeat before every platform after the first: Instagram's
      // container-create-then-poll can outlast the 30-minute lease, and losing
      // it mid-fan-out would let a second tick publish the same video again.
      if (index > 0) extendLease(db, 'publish', holder, PUBLISH_LEASE_TTL_MS)

      // Resolved BEFORE the claim: nothing may throw between the claim and the
      // upload, or a thrown row sits 'claimed' until the sweep heals it.
      const target = pickedChannel.publish?.targets.find((t) => t.platform === platform)
      if (target === undefined) {
        throw new Error(
          `publishNextTick: channel ${pickedChannel.name} missing ${platform} target at claim time`,
        )
      }
      const meta = resolvePlatformMeta(video.metadataJson, platform, video.topic)

      // The UNIQUE(channel, platform, day, seq) constraint is the real guard; a
      // conflict here means a racing tick won this ordinal.
      const claim = claimPublish(db, {
        jobId: video.jobId,
        platform,
        channel: pickedChannel.name,
        day,
      })
      if (claim === null) {
        // Unreachable under the lease, but a defensive skip rather than a crash
        // — the other platforms in the fan-out still have work to do.
        results.push({ platform, status: 'failed', error: 'claim conflict' })
        continue
      }

      // ONLY the platform calls (credential resolution + upload) sit inside the
      // failure-mapping catch. A throw from anything after them cannot be
      // mapped to a failure kind, because by then the post may already be live.
      let uploaded: { postId: string; url: string }
      try {
        const adapter = adapters[platform]
        const credential = await adapter.resolveCredential(
          db,
          pickedChannel.name,
          pickedTokenKey,
          now,
        )
        uploaded = await adapter.upload(
          {
            // Lazy handle: nothing is read or presigned until the adapter asks.
            // Built per platform so one platform's store failure cannot poison
            // the next — resolveStore() is memoized, so this costs one
            // construction per tick, not one per platform.
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
        if (err instanceof PublishOutcomeUnknownError) {
          // The platform ACCEPTED the post and only its answer was unreadable.
          // Marking it failed would return the video to the pool and publish it
          // twice, so it stays 'claimed' for the sweep.
          results.push({ platform, status: 'unknown', seq: claim.seq, error: message })
        } else {
          const kind = err instanceof PublishError ? err.kind : 'transient'
          markPublishFailed(db, claim.id, message, kind, nowFn())
          results.push({ platform, status: 'failed', seq: claim.seq, error: message })
        }
        continue
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
        results.push({
          platform,
          status: 'unknown',
          seq: claim.seq,
          error: `uploaded ${uploaded.postId} (${uploaded.url}) but recording it failed: ${message}`,
        })
        continue
      }
      results.push({
        platform,
        status: 'published',
        seq: claim.seq,
        postId: uploaded.postId,
        url: uploaded.url,
      })
    }

    return {
      // A partial fan-out still published a video, so it is not a failed tick —
      // the per-platform entries carry the failures, and the CLI exits 1 when
      // any of them is 'failed'.
      action: results.some((r) => r.status === 'published') ? 'published' : 'publish-failed',
      channel: pickedChannel.name,
      jobId: video.jobId,
      results,
    }
  } finally {
    if (!dryRun) releaseLease(db, 'publish', holder)
  }
}
