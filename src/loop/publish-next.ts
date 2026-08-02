import { existsSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import { classify, errorMessage } from '../errors.js'
import { parseTokenKey } from '../publish/crypto.js'
import { publishMedia } from '../publish/media.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import {
  channelVideoCandidates,
  claimPublish,
  lastAttemptAt,
  markPublishDone,
  markPublishFailed,
  quotaBackedOff,
  sweepInterrupted,
  videosPublishedToday,
} from '../publish/publishes.js'
import type { ChannelVideoCandidate } from '../publish/publishes.js'
import { reclaimableObjects, reclaimObjects } from '../publish/reclaim.js'
import { channelNotDueReason, localDay, orderChannels } from '../publish/schedule.js'
import type { ChannelCandidate, NotDueReason } from '../publish/schedule.js'
import { agedCutoff } from '../publish/settled.js'
import { PUBLISH_PLATFORMS, resolvePlatformMeta, toPublishFailureKind } from '../publish/types.js'
import type { Platform, PublishAdapter, PublishTargetConfig } from '../publish/types.js'
import type { ObjectStore } from '../storage/types.js'
import { acquireLease, extendLease, PUBLISH_LEASE_TTL_MS, releaseLease } from './lease.js'

/** One platform's leg of the fan-out — one video, one `publishes` row. */
export interface PublishAttemptResult {
  platform: Platform
  /**
   * 'unknown' is the platform-accepted-but-unreadable case: the row stays
   * 'claimed' for the repair sweep, never 'failed', because marking it failed
   * would publish the same video twice.
   *
   * 'skipped' means this platform was never attempted at all: the fan-out
   * stopped because a mid-fan-out lease heartbeat (`extendLease`) came back
   * `false`, meaning this holder was already evicted by a takeover. A second
   * live process may already be claiming platforms for this same video, so
   * continuing could claim (and publish) the same platform twice under two
   * holders. No `publishes` row exists for a 'skipped' entry — nothing was
   * claimed for it.
   */
  status: 'published' | 'failed' | 'unknown' | 'skipped'
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
    | 'paced'
    | 'daily-count-met'
    | 'platform-quota'
    | 'no-ready-video'
    | 'series-blocked'
    | 'no-video-file'
    | 'no-auth'
    | 'bad-env'
    | 'config-error'
  channel?: string
  jobId?: string
  /**
   * One entry per platform the fan-out reached, in the channel's target
   * order — including a trailing 'skipped' run for platforms the fan-out
   * abandoned after losing the lease (see PublishAttemptResult['status']).
   */
  results?: PublishAttemptResult[]
  error?: string
  wouldPublish?: {
    channel: string
    jobId: string
    title: string
    platforms: Platform[]
  } | null
  /**
   * What the reclaim sweep freed this tick. Absent on a dry run, which never
   * sweeps. `{ count: 0, bytes: 0 }` means the sweep ran and found nothing.
   */
  reclaimed?: { count: number; bytes: number }
}

// Checks BRAINROT_TOKEN_KEY, whose malformed value would otherwise throw from
// deep inside the tick (exit 1, no JSON line, every firing, no DB trace).
// Quota is no longer a config-derived cap (see platformOpen below), so there
// is no per-platform env var left to validate here.
function badEnvMessage(): string | undefined {
  const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
  if (tokenKeyHex) {
    try {
      parseTokenKey(tokenKeyHex)
    } catch {
      return 'BRAINROT_TOKEN_KEY is malformed (expected 64 hex characters)'
    }
  }
  return undefined
}

// How many candidate rows the tick asks the DAO for per channel — the ceiling
// on how many videos it may reject (pruned bytes, quota, missing credential)
// before giving up on that channel this tick. The DAO already omits videos
// every declared platform blocks, so reaching this is pathological (a wholesale
// runs/ prune with no stored objects), and giving up is harmless: the next tick
// starts the scan over.
const MAX_VIDEO_CANDIDATES = 50

// How many objects one tick may delete. A large accumulated backlog must not
// eat the lease window mid-sweep; the next tick continues where this stopped.
const MAX_RECLAIM_PER_TICK = 25

/**
 * Deletes the stored object of every video whose declared platforms have all
 * settled (publish/reclaim.ts), across every channel that publishes.
 *
 * Runs at the top of the lease window, beside sweepInterrupted, and that
 * placement is what makes it self-healing: a video becomes reclaimable through
 * a normal fan-out, a manual `publish mark-done`, a `publish retry` that
 * finally landed, or simply by ageing out — and a sweep here catches all four.
 * Attached to the end of a fan-out instead, it would only ever catch the video
 * it had just published.
 *
 * A null store (no credentials configured) is a silent no-op, consistent with
 * how resolveStore() already degrades: a YouTube-only deployment with no
 * bucket has nothing to reclaim.
 */
async function sweepReclaimable(
  db: Database,
  channels: ChannelConfig[],
  store: ObjectStore | null,
  now: Date,
): Promise<{ count: number; bytes: number }> {
  if (store === null) return { count: 0, bytes: 0 }
  let count = 0
  let bytes = 0
  for (const channel of channels) {
    if (channel.publish === null) continue
    const remaining = MAX_RECLAIM_PER_TICK - count
    if (remaining <= 0) break
    const warn = (message: string): void => console.error(`publish-next: reclaim: ${message}`)
    const objects = reclaimableObjects(db, {
      channel: channel.name,
      declared: channel.publish.targets.map((t) => t.platform),
      createdAfter: agedCutoff(now, channel.backlogDays),
      limit: remaining,
      warn,
    })
    if (objects.length === 0) continue
    const result = await reclaimObjects({
      db,
      objects,
      store,
      warn,
    })
    count += result.reclaimed.length
    bytes += result.bytes
  }
  return { count, bytes }
}

/**
 * Selects ONE video and fans it out to every platform that still wants it: env
 * check -> per-channel due gate (cooldown gap, day count) -> fairness
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
  // so nothing should be leased on its behalf. The cause travels in `error`
  // only: printing it here too was harmless under cron but is spam under the
  // daemon, where this tick reruns every 30 seconds and an unstructured print
  // bypasses runWorker's idle dedupe. The one-shot CLI prints it (src/cli.ts).
  const loaded = tryLoadChannelsDir(opts.channelsDir)
  if (loaded.error !== undefined) {
    return { action: 'noop', reason: 'config-error', error: loaded.error }
  }
  const channels = loaded.channels
  // A held lease is the NORMAL case while a previous firing's upload is still
  // in flight — benign no-op, exit 0 at the CLI. Dry-run never touches the
  // lease: it is a pure read-only preview, never a competing writer.
  //
  // KNOWN GAP: same in-process holder collision as produce-next.ts:91 — the
  // slow lane now calls this tick in-process too, sharing this pid as a
  // second caller. Not fixed here; currently bounded because
  // `ux_publishes_live` still enforces one live `publishes` row per (job,
  // platform) even if a stalled caller's release frees this lease early.
  const holder = `pid:${process.pid}`
  if (!dryRun && !acquireLease(db, 'publish', holder, PUBLISH_LEASE_TTL_MS)) {
    return { action: 'noop', reason: 'lease-held' }
  }
  try {
    const now = nowFn()
    let reclaimed: { count: number; bytes: number } | undefined
    if (!dryRun) {
      // Repair sweep (publish-analog of produce-next's topic sweep): a tick
      // that died mid-upload leaves a stale 'claimed' row — heal it to
      // 'interrupted' before planning this tick's attempt.
      sweepInterrupted(db, PUBLISH_LEASE_TTL_MS, now)
      // Then free the bytes of everything nothing can publish any more. Ahead
      // of candidate selection, so a video reclaimed here is already excluded
      // from this tick's own scan rather than picked and then failed.
      reclaimed = await sweepReclaimable(db, channels, await resolveStore(), now)
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
      // --force is the local-testing bypass: it skips the cooldown gap and
      // the day count so ticks can be fired back to back. It never
      // skips quota, credentials, or eligibility — a forced test must not be
      // able to bypass a platform's runtime backoff.
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
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason }
        : { action: 'noop', reason, reclaimed }
    }

    const ordered = orderChannels(candidates)
    const tokenKeyHex = process.env.BRAINROT_TOKEN_KEY
    const tokenKey = tokenKeyHex ? parseTokenKey(tokenKeyHex) : undefined

    // Runtime quota gate: the platform's own quota error (a failed row with
    // error_kind='quota', see quotaBackedOff) sidelines it for
    // QUOTA_BACKOFF_MS. Checked once per scope-appropriate key per tick.
    const backoffCache = new Map<string, boolean>()
    function platformOpen(platform: Platform, channel: string): boolean {
      const adapter = adapters[platform]
      const key = adapter.quota.scope === 'global' ? platform : `${platform}:${channel}`
      let open = backoffCache.get(key)
      if (open === undefined) {
        open = !quotaBackedOff(
          db,
          platform,
          now,
          adapter.quota.scope === 'channel' ? channel : undefined,
        )
        backoffCache.set(key, open)
      }
      return open
    }

    let firstReason:
      | 'no-ready-video'
      | 'no-video-file'
      | 'no-auth'
      | 'platform-quota'
      | 'series-blocked'
      | undefined
    // One video, plus the platforms it can actually reach this tick — the whole
    // fan-out is planned before anything is claimed. `tokenKey` rides along as a
    // plain Buffer (the credential gate below is what proves it is set) so the
    // upload loop never has to re-check it.
    let picked:
      | {
          channel: ChannelConfig
          video: ChannelVideoCandidate
          targets: PublishTargetConfig[]
          tokenKey: Buffer
        }
      | undefined

    for (const candidate of ordered) {
      const channel = channels.find((c) => c.name === candidate.channel)
      if (channel === undefined || channel.publish === null) continue
      const declared = channel.publish.targets
      // The declared platform list goes to the DAO as plain data: it is what
      // makes "every platform blocked" mean every platform THIS channel targets,
      // so a single-platform channel's finished videos stop consuming the
      // MAX_VIDEO_CANDIDATES budget the moment they are published.
      const declaredPlatforms = declared.map((t) => t.platform)
      // Whether every candidate seen for THIS channel was fully blocked on its
      // declared platforms (as opposed to missing a file), and whether any of
      // that blocking came from the series-predecessor gate rather than the
      // video's own publish state — the two facts 'series-blocked' reports. A
      // channel with no candidates at all keeps `hadCandidates` false, which
      // falls through to the ordinary 'no-ready-video' below, same as before
      // this reason existed.
      let hadCandidates = false
      let allCandidatesFullyBlocked = true
      let anySeriesBlock = false
      for (const video of channelVideoCandidates(
        db,
        channel.name,
        declaredPlatforms,
        MAX_VIDEO_CANDIDATES,
        agedCutoff(now, channel.backlogDays),
      )) {
        hadCandidates = true
        // Bytes-reachable pre-flight: a local file OR a stored object. A pruned
        // runs/ tree is normal (the bucket is the durable copy); a row with
        // NEITHER would burn a quota unit on a failure the adapter can only
        // report as 'rejected'.
        if (video.objectKey === null && !existsSync(video.videoPath)) {
          if (firstReason === undefined) firstReason = 'no-video-file'
          allCandidatesFullyBlocked = false
          continue
        }
        const open: PublishTargetConfig[] = []
        let allBlocked = true
        for (const target of declared) {
          const platform = target.platform
          if (video.blockedPlatforms.includes(platform)) {
            if (video.seriesBlockedPlatforms.includes(platform)) anySeriesBlock = true
            continue
          }
          allBlocked = false
          if (!platformOpen(platform, channel.name)) {
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
          open.push(target)
        }
        if (!allBlocked) allCandidatesFullyBlocked = false
        if (open.length === 0) continue
        // `open` is non-empty only if the credential gate above ran
        // hasCredential, which it can only do with a key in hand — so the cast
        // records an invariant the control flow already proved.
        picked = { channel, video, targets: open, tokenKey: tokenKey as Buffer }
        break
      }
      if (picked !== undefined) break
      if (firstReason === undefined) {
        firstReason =
          hadCandidates && allCandidatesFullyBlocked && anySeriesBlock
            ? 'series-blocked'
            : 'no-ready-video'
      }
    }

    if (picked === undefined) {
      return dryRun
        ? { action: 'dry-run', wouldPublish: null, reason: firstReason }
        : { action: 'noop', reason: firstReason, reclaimed }
    }

    const { channel: pickedChannel, video, targets, tokenKey: pickedTokenKey } = picked
    const platforms = targets.map((t) => t.platform)

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
    for (const [index, target] of targets.entries()) {
      const platform = target.platform
      // Heartbeat before every platform after the first: Instagram's
      // container-create-then-poll can outlast the 30-minute lease, and losing
      // it mid-fan-out would let a second tick publish the same video again.
      if (index > 0 && !extendLease(db, 'publish', holder, PUBLISH_LEASE_TTL_MS)) {
        // `false` means this holder was already evicted by a takeover (see
        // extendLease's doc comment in lease.ts) — a second live process may
        // already be claiming platforms for this same video. Stop the
        // fan-out here rather than claim (and possibly publish) a platform
        // that tick has also picked up; the legs already collected above are
        // still reported truthfully, and every remaining platform is recorded
        // as 'skipped' so it does not silently vanish from the JSON line.
        for (const remaining of targets.slice(index)) {
          results.push({
            platform: remaining.platform,
            status: 'skipped',
            error: 'publish lease lost mid-fan-out (evicted by a takeover); not attempted',
          })
        }
        break
      }

      const meta = resolvePlatformMeta(video.metadataJson, platform, video.topic)

      // The publish lease above is the only guard against publishing this video
      // twice: `seq` is derived from existing rows, so UNIQUE(channel, platform,
      // day, seq) keeps the day's ordinals distinct but cannot detect a racing
      // tick claiming the same (job, platform) — it just hands out the next
      // ordinal. A null here means a writer's INSERT landed between this claim's
      // MAX(seq) read and its own INSERT (see claimPublish's doc comment).
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
        const info = classify(err)
        if (info.kind === 'unknown-outcome') {
          // The platform ACCEPTED the post and only its answer was unreadable.
          // Marking it failed would return the video to the pool and publish it
          // twice, so it stays 'claimed' for the sweep.
          results.push({ platform, status: 'unknown', seq: claim.seq, error: info.message })
        } else {
          markPublishFailed(db, claim.id, info.message, toPublishFailureKind(info), nowFn())
          results.push({ platform, status: 'failed', seq: claim.seq, error: info.message })
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
        const message = errorMessage(err)
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
      // the per-platform entries carry the failures/unknowns/skips, and
      // publishExitCode below decides the CLI's exit code from them.
      action: results.some((r) => r.status === 'published') ? 'published' : 'publish-failed',
      channel: pickedChannel.name,
      jobId: video.jobId,
      results,
      reclaimed,
    }
  } finally {
    if (!dryRun) releaseLease(db, 'publish', holder)
  }
}

/**
 * Pure exit-code decision for the `publish-next` CLI command, extracted so it
 * is unit-testable without a subprocess: the CLI tests for this command are
 * subprocess-only and cannot force a partial fan-out without real
 * credentials. `action: 'publish-failed'` always exits 1 (every attempted
 * platform failed outright). Otherwise, ANY result entry that is not
 * 'published' — 'failed', 'unknown', or 'skipped' — exits 1: each of those
 * means a `publishes` row needs operator attention (a live post whose
 * outcome is unreadable, a platform abandoned mid-fan-out, or an outright
 * failure). Every noop and dry-run reason carries no `results` at all, so
 * they fall through to 0.
 */
export function publishExitCode(result: PublishTickResult): number {
  if (result.action === 'publish-failed') return 1
  if (result.results?.some((r) => r.status !== 'published')) return 1
  return 0
}
