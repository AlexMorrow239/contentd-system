import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { loadChannelsDir } from '../config/channel.js'
import { parseTokenKey } from '../publish/crypto.js'
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
import { loadRefreshToken } from '../publish/tokens.js'
import { PublishError, resolvePlatformMeta } from '../publish/types.js'
import type { Platform, PublishTarget } from '../publish/types.js'
import {
  mintAccessToken,
  PublishOutcomeUnknownError,
  youtubeTarget,
  ytUploadsPerDayCap,
} from '../publish/youtube.js'
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
  channel?: string
  platform?: Platform
  jobId?: string
  slot?: string
  postId?: string
  url?: string
  error?: string
  wouldPublish?: { channel: string; platform: Platform; slot: string; jobId: string; title: string } | null
}

// Checks the two env vars whose malformed values would otherwise throw from
// deep inside the tick (exit 1, no JSON line, every firing, no DB trace).
// Returns a message naming the offending variable — never its value, which is
// key material in one case and noise in the other — or undefined when both are
// usable. An ABSENT var is not an error: it keeps its own graceful path (the
// default cap, the no-auth noop).
function badEnvMessage(): string | undefined {
  const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
  if (tokenKeyHex) {
    try {
      parseTokenKey(tokenKeyHex)
    } catch {
      return 'BRAINROT_TOKEN_KEY is malformed (expected 64 hex characters)'
    }
  }
  try {
    ytUploadsPerDayCap()
  } catch {
    return 'BRAINROT_YT_UPLOADS_PER_DAY is malformed (expected a positive integer number of uploads)'
  }
  return undefined
}

/**
 * Selects and executes one upload: env check -> due slots -> quota gate ->
 * fairness order -> candidate scan (video, its file, then token) -> claim ->
 * mint -> upload -> finalize.
 * The publish lease and repair sweep wrap this in the next cycle.
 */
export async function publishNextTick(
  db: Database,
  opts: {
    channelsDir: string
    target?: PublishTarget
    fetchImpl?: typeof fetch
    now?: () => Date
    dryRun?: boolean
  },
): Promise<PublishTickResult> {
  const nowFn = opts.now ?? (() => new Date())
  const dryRun = opts.dryRun ?? false
  const target = opts.target ?? youtubeTarget(opts.fetchImpl)
  // Env validation comes BEFORE the lease and any candidate work: a bad value
  // blocks the whole tick either way, and nothing should be claimed or leased
  // on its behalf. Same shape as every other blocked-tick outcome — one JSON
  // line, exit 0, a named cause — matching how these vars behave when unset.
  const envError = badEnvMessage()
  if (envError !== undefined) {
    return { action: 'noop', reason: 'bad-env', error: envError }
  }
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
    const channels = loadChannelsDir(opts.channelsDir)
    const day = localDay(now)

    const candidates: SlotCandidate[] = []
    for (const channel of channels) {
      if (channel.publish === null) continue
      for (const platform of channel.publish.platforms) {
        const consumed = consumedSlots(db, channel.name, platform, day)
        const due = dueSlotsForChannel(channel.publish, consumed, now)
        for (const slot of due) {
          candidates.push({
            channel: channel.name,
            platform,
            slot,
            filledCount: consumed.size,
            totalSlots: channel.publish.slots.length,
          })
        }
      }
    }
    if (candidates.length === 0) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: 'no-due-slot' }
        : { action: 'noop', reason: 'no-due-slot' }
    }

    // Quota gate: YouTube quota is per Google Cloud project, counted across
    // every channel — v1's only platform, so one check covers every candidate.
    if (uploadsUsedToday(db, 'youtube', day) >= ytUploadsPerDayCap()) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: 'platform-quota' }
        : { action: 'noop', reason: 'platform-quota' }
    }

    const ordered = orderCandidates(candidates)
    const clientId = process.env.YT_CLIENT_ID
    const clientSecret = process.env.YT_CLIENT_SECRET
    const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
    const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

    let firstReason: 'no-ready-video' | 'no-video-file' | 'no-auth' | undefined
    let picked:
      | {
          candidate: SlotCandidate
          video: { jobId: string; videoPath: string; metadataJson: string; topic: string }
          refreshToken: string
          clientId: string
          clientSecret: string
        }
      | undefined

    for (const candidate of ordered) {
      const video = eligibleVideo(db, candidate.channel, candidate.platform)
      if (video === null) {
        if (firstReason === undefined) firstReason = 'no-ready-video'
        continue
      }
      // Video-file pre-flight: a pruned runs/ tree leaves a 'ready' library
      // row pointing at nothing, and claiming it first would burn the slot
      // plus a quota unit on an ENOENT the adapter can only report as
      // 'rejected'. A pure read, so dry-run previews the same skip.
      if (!existsSync(video.videoPath)) {
        if (firstReason === undefined) firstReason = 'no-video-file'
        continue
      }
      // Missing client credentials or the token-encryption key blocks every
      // candidate identically — still evaluated per-candidate so a later
      // channel's own missing token row is never masked.
      if (!clientId || !clientSecret || tokenKey === undefined) {
        if (firstReason === undefined) firstReason = 'no-auth'
        continue
      }
      const refreshToken = loadRefreshToken(db, candidate.platform, candidate.channel, tokenKey)
      if (refreshToken === null) {
        if (firstReason === undefined) firstReason = 'no-auth'
        continue
      }
      picked = { candidate, video, refreshToken, clientId, clientSecret }
      break
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason }
    }

    const { candidate, video, refreshToken, clientId: cid, clientSecret: csec } = picked
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

    // Resolve the channel BEFORE the claim: nothing may throw between the
    // claim and the upload, or a thrown row would sit 'claimed' until the
    // sweep heals it. This lookup is defensive — the candidate came from this
    // same channels list, every entry of which carries a non-null publish.
    const channel = channels.find((c) => c.name === candidate.channel)
    if (channel === undefined || channel.publish === null) {
      throw new Error(`publishNextTick: channel ${candidate.channel} missing publish config at claim time`)
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

    // ONLY the platform calls sit inside the failure-mapping catch. A throw
    // from anything after them cannot be mapped to a failure kind, because by
    // then the video may already be live.
    let uploaded: { postId: string; url: string }
    try {
      const accessToken = await mintAccessToken({
        refreshToken,
        clientId: cid,
        clientSecret: csec,
        fetchImpl: opts.fetchImpl,
      })
      uploaded = await target.upload(
        { videoPath: video.videoPath, meta, publish: channel.publish },
        accessToken,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // PublishOutcomeUnknownError means the platform ACCEPTED the upload and
      // only its answer was unreadable. Marking that row failed would return
      // the video to the eligibility pool and publish it a second time, so it
      // stays 'claimed' for the sweep — same operator path as a crashed tick.
      if (!(err instanceof PublishOutcomeUnknownError)) {
        // A PublishError carries its taxonomy kind; anything else escaping the
        // adapter (a bug, a thrown string) is treated as transient — the
        // safest default, since it leaves the video retryable at the next slot
        // rather than permanently retiring it via 'rejected'.
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
