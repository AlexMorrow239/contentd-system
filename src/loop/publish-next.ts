import type { Database } from 'better-sqlite3'
import { loadChannelsDir } from '../config/channel.js'
import { parseTokenKey } from '../publish/crypto.js'
import {
  claimPublish,
  consumedSlots,
  eligibleVideo,
  markPublishDone,
  markPublishFailed,
  uploadsUsedToday,
} from '../publish/publishes.js'
import { dueSlotsForChannel, localDay, orderCandidates } from '../publish/slots.js'
import type { SlotCandidate } from '../publish/slots.js'
import { loadRefreshToken } from '../publish/tokens.js'
import { PublishError, resolvePlatformMeta } from '../publish/types.js'
import type { Platform, PublishTarget } from '../publish/types.js'
import { mintAccessToken, youtubeTarget, ytUploadsPerDayCap } from '../publish/youtube.js'

export interface PublishTickResult {
  action: 'published' | 'publish-failed' | 'noop' | 'dry-run'
  reason?: 'lease-held' | 'no-due-slot' | 'platform-quota' | 'no-ready-video' | 'no-auth' | 'claim-conflict'
  channel?: string
  platform?: Platform
  jobId?: string
  slot?: string
  postId?: string
  url?: string
  error?: string
  wouldPublish?: { channel: string; platform: Platform; slot: string; jobId: string; title: string } | null
}

/**
 * Selects and executes one upload: due slots -> quota gate -> fairness order
 * -> candidate scan (video then token) -> claim -> mint -> upload -> finalize.
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
  const now = nowFn()
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
    return { action: 'noop', reason: 'no-due-slot' }
  }

  // Quota gate: YouTube quota is per Google Cloud project, counted across
  // every channel — v1's only platform, so one check covers every candidate.
  if (uploadsUsedToday(db, 'youtube', day) >= ytUploadsPerDayCap()) {
    return { action: 'noop', reason: 'platform-quota' }
  }

  const ordered = orderCandidates(candidates)
  const clientId = process.env.YT_CLIENT_ID
  const clientSecret = process.env.YT_CLIENT_SECRET
  const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
  const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

  let firstReason: 'no-ready-video' | 'no-auth' | undefined
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

  const channel = channels.find((c) => c.name === candidate.channel)
  if (channel === undefined || channel.publish === null) {
    throw new Error(`publishNextTick: channel ${candidate.channel} missing publish config at claim time`)
  }

  try {
    const accessToken = await mintAccessToken({
      refreshToken,
      clientId: cid,
      clientSecret: csec,
      fetchImpl: opts.fetchImpl,
    })
    const uploaded = await target.upload({ videoPath: video.videoPath, meta, publish: channel.publish }, accessToken)
    markPublishDone(db, claimId, uploaded.postId, uploaded.url, now)
    return {
      action: 'published',
      channel: candidate.channel,
      platform: candidate.platform,
      jobId: video.jobId,
      slot: candidate.slot,
      postId: uploaded.postId,
      url: uploaded.url,
    }
  } catch (err) {
    // A PublishError carries its taxonomy kind; anything else escaping the
    // adapter (a bug, a thrown string) is treated as transient — the safest
    // default, since it leaves the video retryable at the next slot rather
    // than permanently retiring it via 'rejected'.
    const kind = err instanceof PublishError ? err.kind : 'transient'
    const message = err instanceof Error ? err.message : String(err)
    markPublishFailed(db, claimId, message, kind, now)
    return {
      action: 'publish-failed',
      channel: candidate.channel,
      platform: candidate.platform,
      jobId: video.jobId,
      slot: candidate.slot,
      error: message,
    }
  }
}
