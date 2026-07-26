import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { parseTokenKey } from '../publish/crypto.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import {
  claimPublish,
  consumedSlots,
  eligibleVideo,
  markPublishDone,
  markPublishFailed,
  sweepInterrupted,
  uploadsUsedToday,
} from '../publish/publishes.js'
import { dueSlotsForChannel, localDay, orderCandidates } from '../publish/slots.js'
import type { SlotCandidate } from '../publish/slots.js'
import {
  PUBLISH_PLATFORMS,
  PublishError,
  PublishOutcomeUnknownError,
  resolvePlatformMeta,
} from '../publish/types.js'
import type { Platform, PublishAdapter } from '../publish/types.js'
import { acquireLease, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'

export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?:
    | 'lease-held'
    | 'no-due-slot'
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
  slot?: string
  postId?: string
  url?: string
  error?: string
  wouldPublish?: {
    channel: string
    platform: Platform
    slot: string
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
 * Selects and executes one upload: env check -> due slots (per target) ->
 * quota pre-filter -> fairness order -> candidate scan (video, its file,
 * credential) -> claim -> resolveCredential -> upload -> finalize.
 * The publish lease and repair sweep wrap this in the next cycle. Names no
 * platform literal anywhere in this file — guarded by a structural test.
 */
export async function publishNextTick(
  db: Database,
  opts: {
    channelsDir: string
    adapters?: Partial<Record<Platform, PublishAdapter>>
    fetchImpl?: typeof fetch
    now?: () => Date
    dryRun?: boolean
  },
): Promise<PublishTickResult> {
  const nowFn = opts.now ?? (() => new Date())
  const dryRun = opts.dryRun ?? false
  const adapters = Object.fromEntries(
    PUBLISH_PLATFORMS.map((p) => [p, opts.adapters?.[p] ?? ADAPTERS[p](opts.fetchImpl)]),
  ) as Record<Platform, PublishAdapter>

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
      // 'interrupted' before planning this tick's slot.
      sweepInterrupted(db, PUBLISH_LEASE_TTL_MS, now)
    }
    const day = localDay(now)

    const candidates: SlotCandidate[] = []
    for (const channel of channels) {
      if (channel.publish === null) continue
      for (const target of channel.publish.targets) {
        const consumed = consumedSlots(db, channel.name, target.platform, day)
        const due = dueSlotsForChannel(target.slots, consumed, now)
        for (const slot of due) {
          candidates.push({
            channel: channel.name,
            platform: target.platform,
            slot,
            filledCount: consumed.size,
            totalSlots: target.slots.length,
          })
        }
      }
    }
    if (candidates.length === 0) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: 'no-due-slot' }
        : { action: 'noop', reason: 'no-due-slot' }
    }

    // Quota pre-filter (design spec §7, decision 7): usage is computed once
    // per distinct (scope-appropriate) key rather than per candidate. A
    // candidate whose platform is at or over its cap is dropped before
    // fairness ordering ever sees it.
    const usageCache = new Map<string, number>()
    const underQuota = candidates.filter((c) => {
      const adapter = adapters[c.platform]
      const key = adapter.quota.scope === 'global' ? c.platform : `${c.platform}:${c.channel}`
      let used = usageCache.get(key)
      if (used === undefined) {
        used = uploadsUsedToday(
          db,
          c.platform,
          day,
          adapter.quota.scope === 'channel' ? c.channel : undefined,
        )
        usageCache.set(key, used)
      }
      return used < adapter.quota.cap()
    })
    if (underQuota.length === 0) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: 'platform-quota' }
        : { action: 'noop', reason: 'platform-quota' }
    }

    const ordered = orderCandidates(underQuota)
    const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
    const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

    let firstReason: 'no-ready-video' | 'no-video-file' | 'no-auth' | undefined
    let picked:
      | {
          candidate: SlotCandidate
          video: { jobId: string; videoPath: string; metadataJson: string; topic: string }
          tokenKey: Buffer
        }
      | undefined

    for (const candidate of ordered) {
      // Video-file pre-flight: a pruned runs/ tree leaves a 'ready'/'published'
      // library row pointing at nothing, and claiming it first would burn the
      // slot plus a quota unit on an ENOENT the adapter can only report as
      // 'rejected'. eligibleVideo returns only the TOP row, so a pruned one
      // must be excluded and the query re-run.
      const prunedJobIds: string[] = []
      let video: { jobId: string; videoPath: string; metadataJson: string; topic: string } | null =
        null
      for (let scan = 0; scan < MAX_VIDEO_FILE_SCANS; scan++) {
        const row = eligibleVideo(db, candidate.channel, candidate.platform, prunedJobIds)
        if (row === null) break
        if (existsSync(row.videoPath)) {
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
      // hasCredential is a cheap, non-network check (env presence, a
      // decryptable stored token) — safe to run per-candidate before any claim.
      if (
        tokenKey === undefined ||
        !adapters[candidate.platform].hasCredential(db, candidate.channel, tokenKey)
      ) {
        if (firstReason === undefined) firstReason = 'no-auth'
        continue
      }
      picked = { candidate, video, tokenKey }
      break
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason }
    }

    const { candidate, video, tokenKey: pickedTokenKey } = picked
    const meta = resolvePlatformMeta(video.metadataJson, candidate.platform, video.topic)

    if (dryRun) {
      return {
        action: 'dry-run',
        wouldPublish: {
          channel: candidate.channel,
          platform: candidate.platform,
          slot: candidate.slot,
          jobId: video.jobId,
          title: meta.title,
        },
      }
    }

    // Resolve the channel and its target BEFORE the claim: nothing may throw
    // between the claim and the upload, or a thrown row would sit 'claimed'
    // until the sweep heals it.
    const channel = channels.find((c) => c.name === candidate.channel)
    if (channel === undefined || channel.publish === null) {
      throw new Error(
        `publishNextTick: channel ${candidate.channel} missing publish config at claim time`,
      )
    }
    const target = channel.publish.targets.find((t) => t.platform === candidate.platform)
    if (target === undefined) {
      throw new Error(
        `publishNextTick: channel ${candidate.channel} missing ${candidate.platform} target at claim time`,
      )
    }

    // The UNIQUE(channel, platform, day, slot) constraint is the real guard;
    // a conflict here means a racing tick won this slot — unreachable under
    // the publish lease, but a defensive exit rather than a crash.
    const claimId = claimPublish(db, {
      jobId: video.jobId,
      platform: candidate.platform,
      channel: candidate.channel,
      day,
      slot: candidate.slot,
    })
    if (claimId === null) {
      return { action: 'noop', reason: 'claim-conflict' }
    }

    // ONLY the platform calls (credential resolution + upload) sit inside the
    // failure-mapping catch. A throw from anything after them cannot be
    // mapped to a failure kind, because by then the post may already be live.
    let uploaded: { postId: string; url: string }
    try {
      const adapter = adapters[candidate.platform]
      const credential = await adapter.resolveCredential(db, candidate.channel, pickedTokenKey, now)
      uploaded = await adapter.upload(
        { videoPath: video.videoPath, meta, options: target.options },
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
        markPublishFailed(db, claimId, message, kind, nowFn())
      }
      return {
        action: 'publish-failed',
        channel: candidate.channel,
        platform: candidate.platform,
        jobId: video.jobId,
        slot: candidate.slot,
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
      markPublishDone(db, claimId, uploaded.postId, uploaded.url, nowFn())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        action: 'publish-failed',
        channel: candidate.channel,
        platform: candidate.platform,
        jobId: video.jobId,
        slot: candidate.slot,
        error: `uploaded ${uploaded.postId} (${uploaded.url}) but recording it failed: ${message}`,
      }
    }
    return {
      action: 'published',
      channel: candidate.channel,
      platform: candidate.platform,
      jobId: video.jobId,
      slot: candidate.slot,
      postId: uploaded.postId,
      url: uploaded.url,
    }
  } finally {
    if (!dryRun) releaseLease(db, 'publish', holder)
  }
}
