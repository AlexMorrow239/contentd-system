import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import {
  claimPublish,
  listPublishes,
  markPublishDone,
  MAX_PUBLISH_ATTEMPTS,
  QUOTA_BACKOFF_MS,
  videosPublishedToday,
} from '../../publish/publishes.js'
import { PLATFORM_QUOTAS } from '../../publish/platforms/quota.js'
import type { Platform, PublishAdapter } from '../../publish/types.js'
import { PublishError, PublishOutcomeUnknownError } from '../../publish/types.js'
import { claimTopic, insertTopics, redditCandidates } from '../../scout/topics.js'
import { fakeStore } from '../../storage/fake.js'
import { acquireLease, extendLease, PUBLISH_LEASE_TTL_MS } from '../lease.js'
import { publishExitCode, publishNextTick } from '../publish-next.js'
import type { PublishTickResult } from '../publish-next.js'
import {
  FANOUT_NOW,
  NOW,
  fakeAdapter,
  fakeIgAdapter,
  fanOutFixture,
  seedAttempt,
  seedObjectKey,
  seedQuotaFailure,
  seedReadyVideo,
  seedToken,
  stubPublishEnv,
  urlResolvingAdapter,
  writeChannel,
} from './_publish-next.fixtures.js'
import { runCli } from '../../testing/run-cli.js'
import { tmpDir, testRoot } from '../../testing/tmp.js'
import { memDb, seedJob, seedLibrary, seedLibraryObject, seedPublish } from '../../testing/db.js'

/**
 * publish-next's full tick: the gates a candidate must clear, which
 * candidate is picked and whether it's due, the upload itself and its
 * failure modes, fan-out across every declared platform, the lease/sweep
 * machinery, config-error noops, the CLI surface, and the pure
 * result-to-exit-code mapping. Shared fixtures live in
 * _publish-next.fixtures.ts.
 */

// Spies claimPublish so the claim-conflict test can force a `null` return
// (a racing-tick claim collision the publish lease makes unreachable in a
// single-process run), and markPublishDone so the post-upload DB-failure
// test can force a throw; every other test calls straight through to the
// real DAO because vi.fn wraps the actual implementation as its default.
vi.mock('../../publish/publishes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../publish/publishes.js')>()
  return {
    ...actual,
    claimPublish: vi.fn(actual.claimPublish),
    markPublishDone: vi.fn(actual.markPublishDone),
  }
})

// Spies extendLease so the fan-out tests can count the mid-fan-out heartbeats.
// acquireLease and releaseLease stay REAL (the factory spreads the original
// module) because every lease test in this file asserts on their actual
// database effect.
vi.mock('../lease.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lease.js')>()
  return { ...actual, extendLease: vi.fn(actual.extendLease) }
})

beforeEach(() => {
  stubPublishEnv(vi)
})

describe('publishNextTick — gates', () => {
  // A channels dir where nothing declares [publish] produces no candidate and
  // no channel whose pacing gate closed — distinct from a pacing reason, so
  // it gets its own 'no-publish-channel' cause rather than a bare noop.
  it('no-ops with reason no-publish-channel when no channel has publishing configured', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nodue-')
    writeChannel(channelsDir, { name: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-publish-channel',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('no-ops with reason platform-quota when the platform is backed off after a recent quota failure', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // A publishable, authorized video, so the backoff is the ONLY thing
    // stopping this tick — an empty library would report 'no-ready-video'
    // instead.
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    seedQuotaFailure(db, { channel: 'chan-a', platform: 'youtube', now: NOW(), msAgo: 60 * 60 * 1000 })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'platform-quota',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('no-ops with reason no-ready-video when the channel is due but its library is empty', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-novideo-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-ready-video',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('no-ops with reason series-blocked when the only ready video is a continuation waiting on its predecessor', async () => {
    // Part 1's topic row exists but has never been claimed by a job (still a
    // 'candidate' — the queue simply hasn't produced it yet), so the
    // series-predecessor gate blocks every declared platform for part 2. A
    // stalled series must not read as an idle channel in the log stream —
    // that ambiguity is exactly why 'series-blocked' exists as its own
    // reason distinct from the generic 'no-ready-video'.
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-seriesblocked-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedToken(db, 'chan-a')
    const jobId = seedReadyVideo(db, { channel: 'chan-a', topic: 'Story (2/2)' })
    insertTopics(db, [
      {
        channel: 'chan-a',
        title: 'Story (1/2)',
        rawTitle: 'Story',
        source: 'reddit:r/a',
        url: 'https://example.com/1',
        dedupeHash: 'series-h1',
        score: 88,
        reason: 'seeded',
        status: 'candidate',
        bodyText: 'part one body',
        seriesKey: 'series-S',
        partIndex: 1,
        partCount: 2,
      },
      {
        channel: 'chan-a',
        title: 'Story (2/2)',
        rawTitle: 'Story',
        source: 'reddit:r/a',
        url: 'https://example.com/2',
        dedupeHash: 'series-h2',
        score: 88,
        reason: 'seeded',
        status: 'candidate',
        bodyText: 'part two body',
        seriesKey: 'series-S',
        partIndex: 2,
        partCount: 2,
      },
    ])
    const part2 = redditCandidates(db, 'chan-a').find((t) => t.partIndex === 2)
    claimTopic(db, part2!.id, jobId)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'series-blocked',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('no-ops with reason no-auth when the YouTube client credentials are unset', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-noauth-env-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    vi.stubEnv('YT_CLIENT_ID', '')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-auth',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('no-ops with reason no-auth when no oauth token row exists for the channel', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-noauth-token-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-auth',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  // A malformed env var used to throw out of the tick — exit 1, no JSON line,
  // every firing, with no DB trace. Unset, the same vars degrade gracefully,
  // so present-but-invalid must too.
  it('no-ops with reason bad-env on a malformed BRAINROT_TOKEN_KEY, naming the variable but never its value', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-badkey-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    const badKey = 'ab'.repeat(31) + 'a' // 63 hex chars: one short of a 32-byte key
    vi.stubEnv('BRAINROT_TOKEN_KEY', badKey)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('bad-env')
    expect(result.error).toContain('BRAINROT_TOKEN_KEY')
    expect(result.error).not.toContain(badKey)
    // Validated before any lease or candidate work: nothing was claimed and
    // the lease is free for the next firing.
    expect(db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('cross-platform candidates', () => {
  it('walks every declared target of a due channel, not just the first', async () => {
    // Channel with both youtube and instagram targets and a ready video: the
    // scan spans both platforms — verified via dry-run so no claim mutates
    // state. No stored token for either platform on a fresh db means neither
    // can be picked, but the fact that BOTH platforms were considered (not
    // just the first) is what this test guards, checked via the reason.
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-crossplatform-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan' })
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, { channelsDir, now, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-auth' })
    db.close()
  })
})

// Cap counting is gone: a platform's own quota-kind failure sidelines it for
// QUOTA_BACKOFF_MS (quotaBackedOff, src/publish/publishes.ts), regardless of
// how many uploads it has actually done today.
describe('runtime quota backoff', () => {
  it('a recent YouTube quota failure skips only the YouTube leg, and stays skipped for a second video (global scope)', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-yt-recent-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 2 })
    // Seeded against an unrelated channel: youtube's quota scope is 'global',
    // so the backoff applies everywhere regardless of which channel the
    // failure was recorded against.
    seedQuotaFailure(db, {
      channel: 'other-chan',
      platform: 'youtube',
      now: FANOUT_NOW(),
      msAgo: 60 * 60 * 1000,
    })
    seedReadyVideo(db, { channel: 'chan', topic: 'Video one' })
    seedToken(db, 'chan')
    const igAdapter = fakeIgAdapter(async () => ({ postId: 'ig-1', url: 'https://ig/ig-1' }))
    const first = await publishNextTick(db, {
      channelsDir,
      now: FANOUT_NOW,
      adapters: { instagram: igAdapter },
    })
    expect(first.action).toBe('published')
    expect(first.results?.map((r) => r.platform)).toEqual(['instagram'])

    // A second video on the same channel. --force skips the cooldown/day-count
    // gate (the real claim row above stamped its own wall-clock created_at,
    // which the fictional `now` cannot control — see seedAttempt's doc
    // comment) so this tick isolates the backoff as the only variable: the
    // backoff is a platform fact read fresh each tick, not a per-video or
    // one-shot exclusion.
    seedReadyVideo(db, { channel: 'chan', topic: 'Video two' })
    const second = await publishNextTick(db, {
      channelsDir,
      now: FANOUT_NOW,
      adapters: { instagram: igAdapter },
      force: true,
    })
    expect(second.action).toBe('published')
    expect(second.results?.map((r) => r.platform)).toEqual(['instagram'])
    db.close()
  })

  it('a recent Instagram quota failure is scoped to its channel; a different channel is unaffected', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-ig-scoped-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true, instagram: true, videosPerDay: 1 })
    writeChannel(channelsDir, { name: 'chan-b', publish: true, instagram: true, videosPerDay: 1 })
    seedQuotaFailure(db, {
      channel: 'chan-a',
      platform: 'instagram',
      now: FANOUT_NOW(),
      msAgo: 60 * 60 * 1000,
    })
    seedReadyVideo(db, { channel: 'chan-a', topic: 'A video' })
    seedToken(db, 'chan-a')
    seedReadyVideo(db, { channel: 'chan-b', topic: 'B video' })
    seedToken(db, 'chan-b')
    const adapters = {
      youtube: fakeAdapter(async () => ({ postId: 'yt-x', url: 'https://youtu.be/yt-x' })),
      instagram: fakeIgAdapter(async () => ({ postId: 'ig-x', url: 'https://ig/ig-x' })),
    }

    // chan-a sorts first (tied fairness, channel ASC — see orderChannels):
    // its Instagram leg is backed off, so only YouTube goes out for it.
    const first = await publishNextTick(db, { channelsDir, now: FANOUT_NOW, adapters })
    expect(first.channel).toBe('chan-a')
    expect(first.results?.map((r) => r.platform)).toEqual(['youtube'])

    // chan-a's day count is now met, so this tick reaches chan-b — whose
    // Instagram leg was never touched by chan-a's failure.
    const second = await publishNextTick(db, { channelsDir, now: FANOUT_NOW, adapters })
    expect(second.channel).toBe('chan-b')
    expect(second.results?.map((r) => r.platform).sort()).toEqual(['instagram', 'youtube'])
    db.close()
  })

  it('a quota failure older than QUOTA_BACKOFF_MS no longer backs off the platform', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-expired-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    seedQuotaFailure(db, {
      channel: 'chan-a',
      platform: 'youtube',
      now: NOW(),
      msAgo: QUOTA_BACKOFF_MS + 1,
    })
    const target = fakeAdapter(async () => ({
      postId: 'yt-recovered',
      url: 'https://youtube.com/shorts/yt-recovered',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('published')
    expect(result.results?.map((r) => r.platform)).toEqual(['youtube'])
    db.close()
  })

  it('noops with platform-quota and writes no rows when every declared platform is backed off', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-allbackedoff-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan' })
    seedToken(db, 'chan')
    const now = FANOUT_NOW()
    // Global-scope youtube backed off via an unrelated channel; channel-scope
    // instagram backed off directly on 'chan' — every declared platform closed.
    seedQuotaFailure(db, { channel: 'other-chan', platform: 'youtube', now, msAgo: 60 * 60 * 1000 })
    seedQuotaFailure(db, { channel: 'chan', platform: 'instagram', now, msAgo: 60 * 60 * 1000 })
    const result = await publishNextTick(db, { channelsDir, now: FANOUT_NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'platform-quota',
      reclaimed: { count: 0, bytes: 0 },
    })
    // Only the two pre-seeded quota-failure rows exist — the tick claimed nothing.
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 2 })
    db.close()
  })

  it('repeated quota failures on the same video never retire it — only rejected counts toward the poison-video cap', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-quota-noaccum-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // More quota-kind failures on this exact video than MAX_PUBLISH_ATTEMPTS —
    // if quota accumulated like 'rejected' does, channelVideoCandidates would
    // retire it for good. All old enough that the backoff window has long
    // since passed.
    const longAgo = new Date(NOW().getTime() - (QUOTA_BACKOFF_MS + 60_000)).toISOString()
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS + 1; i++) {
      seedPublish(db, jobId, {
        platform: 'youtube',
        channel: 'chan-a',
        status: 'failed',
        errorKind: 'quota',
        seq: i + 1,
        createdAt: longAgo,
      })
    }
    const target = fakeAdapter(async () => ({
      postId: 'yt-recovered',
      url: 'https://youtube.com/shorts/yt-recovered',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('published')
    expect(result.jobId).toBe(jobId)
    db.close()
  })
})

describe('publishNextTick — candidate selection (dry-run)', () => {
  it('skips a blocked channel and previews the next eligible one', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-iter-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    writeChannel(channelsDir, { name: 'chan-b', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        jobId,
        title: 'Chan B topic',
        platforms: ['youtube'],
      },
    })
    db.close()
  })

  it('reports the first candidate blocker when every channel is blocked', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-blocked-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    writeChannel(channelsDir, { name: 'chan-b', publish: true })
    seedReadyVideo(db, { channel: 'chan-b' })
    seedToken(db, 'chan-a')
    // chan-b has a video but no token; chan-a is authorized but has no video.
    // chan-a sorts first (tied fraction, channel ASC) so its blocker wins.
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-ready-video' })
    db.close()
  })

  // A pruned runs/ tree leaves a 'ready' library row pointing at nothing.
  // Without the pre-flight the claim happens first and the ENOENT comes back
  // as 'rejected' — three burnt attempts and three quota units before the
  // poison cap retires the row.
  it('skips a ready video whose file is gone and reports no-video-file', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nofile-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a', videoExists: false })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({ action: 'dry-run', wouldPublish: null, reason: 'no-video-file' })
    db.close()
  })

  it('falls through to a channel whose file is present when an earlier one is pruned', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nofile-fallthrough-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    writeChannel(channelsDir, { name: 'chan-b', publish: true })
    seedReadyVideo(db, { channel: 'chan-a', videoExists: false })
    seedToken(db, 'chan-a')
    const jobB = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        jobId: jobB,
        title: 'Chan B topic',
        platforms: ['youtube'],
      },
    })
    db.close()
  })

  // A pruned newest video must not shadow every older healthy video on its
  // channel: the scan walks past it to the next candidate rather than giving up
  // on the channel and re-picking the same dead row on the next tick.
  it('publishes an older ready video when the newest one on the channel is pruned', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-shadow-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const older = seedReadyVideo(db, {
      channel: 'chan-a',
      topic: 'Older topic',
      createdAt: '2026-07-21T00:00:00.000Z',
    })
    seedReadyVideo(db, {
      channel: 'chan-a',
      topic: 'Newest topic',
      createdAt: '2026-07-22T00:00:00.000Z',
      videoExists: false,
    })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt-old',
      url: 'https://youtube.com/shorts/yt-old',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result).toEqual({
      action: 'published',
      channel: 'chan-a',
      jobId: older,
      results: [
        {
          platform: 'youtube',
          status: 'published',
          seq: 1,
          postId: 'yt-old',
          url: 'https://youtube.com/shorts/yt-old',
        },
      ],
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('reports no-video-file only once every ready video on the channel is pruned', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-shadow-all-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, {
      channel: 'chan-a',
      createdAt: '2026-07-20T00:00:00.000Z',
      videoExists: false,
    })
    seedReadyVideo(db, {
      channel: 'chan-a',
      createdAt: '2026-07-21T00:00:00.000Z',
      videoExists: false,
    })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-video-file',
      reclaimed: { count: 0, bytes: 0 },
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('picks the emptier channel over the fuller one regardless of name order', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-fair-')
    // chan-a at 3/day so its 09:00 attempt is 5h05m behind NOW — well past
    // the 10-minute PUBLISH_COOLDOWN_MS — and therefore NOT paced; the
    // ordering, not the cooldown, is what this asserts.
    writeChannel(channelsDir, { name: 'chan-a', publish: true, videosPerDay: 3 })
    writeChannel(channelsDir, { name: 'chan-b', publish: true })
    seedAttempt(db, {
      jobId: 'chan-a-earlier',
      channel: 'chan-a',
      platform: 'youtube',
      day: '2026-07-22',
      createdAt: new Date(2026, 6, 22, 9, 0).toISOString(),
    })
    seedReadyVideo(db, { channel: 'chan-a', topic: 'Chan A topic' })
    seedToken(db, 'chan-a')
    const jobB = seedReadyVideo(db, { channel: 'chan-b', topic: 'Chan B topic' })
    seedToken(db, 'chan-b')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-b',
        jobId: jobB,
        title: 'Chan B topic',
        platforms: ['youtube'],
      },
    })
    db.close()
  })
})

describe('publishNextTick — the due gate', () => {
  // Shared fixture for the pacing cases: one channel, one ready+authorized
  // video, so the only thing under test is WHEN the tick fires.
  function dueFixture(prefix: string, videosPerDay?: number): { db: Database; dir: string } {
    const db = memDb()
    const dir = tmpDir(prefix)
    writeChannel(dir, { name: 'test', publish: true, videosPerDay })
    seedReadyVideo(db, { channel: 'test' })
    seedToken(db, 'test')
    return { db, dir }
  }

  // Vestigial substitution: fakeAdapter's own descriptor already carries
  // scope 'global', so swapping in the real PLATFORM_QUOTAS.youtube changes
  // nothing platformOpen reads. Kept only so this fixture keeps tracking the
  // production descriptor if its shape ever gains another field.
  function publishingAdapters(): Partial<Record<Platform, PublishAdapter>> {
    const base = fakeAdapter(async () => ({
      postId: 'yt-due',
      url: 'https://youtube.com/shorts/yt-due',
    }))
    return { youtube: { ...base, quota: PLATFORM_QUOTAS.youtube } }
  }

  it('publishes at any hour — there is no posting window', async () => {
    const { db, dir } = dueFixture('brainrot-publish-anyhour-')
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 3, 0),
    })
    expect(result.action).toBe('published')
    db.close()
  })

  it('noops with daily-count-met once videos_per_day videos were attempted', async () => {
    const { db, dir } = dueFixture('brainrot-publish-count-', 1)
    // createdAt pinned inside the 10 min PUBLISH_COOLDOWN_MS as measured from
    // `now` below: if the gates were ever reordered to check pacing before
    // the day count, this fixture would report 'paced' instead and fail the
    // assertion honestly, rather than passing by coincidence on whatever the
    // real wall clock happened to be.
    seedAttempt(db, {
      jobId: 'job-old',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
      createdAt: new Date(2026, 6, 22, 18, 55).toISOString(),
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 19, 0),
    })
    expect(result).toEqual({
      action: 'noop',
      reason: 'daily-count-met',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('noops with paced inside the min gap', async () => {
    // PUBLISH_COOLDOWN_MS is a flat 10 min, independent of videos_per_day.
    // Last attempt 11:55 local, now 12:00 -> a 5 min gap, inside the cooldown.
    const { db, dir } = dueFixture('brainrot-publish-paced-', 3)
    seedAttempt(db, {
      jobId: 'job-old',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
      createdAt: new Date(2026, 6, 22, 11, 55).toISOString(),
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 12, 0),
    })
    expect(result).toEqual({
      action: 'noop',
      reason: 'paced',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('is due again once the min gap has elapsed', async () => {
    const { db, dir } = dueFixture('brainrot-publish-gap-elapsed-', 3)
    seedAttempt(db, {
      jobId: 'job-old',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
      createdAt: new Date(2026, 6, 22, 10, 0).toISOString(),
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 14, 0),
    })
    expect(result.action).toBe('published')
    db.close()
  })

  it('--force publishes despite the cooldown gap and day count', async () => {
    const { db, dir } = dueFixture('brainrot-publish-force-', 1)
    seedAttempt(db, {
      jobId: 'job-old',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      force: true,
      now: () => new Date(2026, 6, 22, 3, 0),
    })
    expect(result.action).toBe('published')
    db.close()
  })

  it('--force still respects the platform quota', async () => {
    const { db, dir } = dueFixture('brainrot-publish-force-quota-', 1)
    seedQuotaFailure(db, {
      channel: 'test',
      platform: 'youtube',
      now: new Date(2026, 6, 22, 12, 0),
      msAgo: 60 * 60 * 1000,
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      force: true,
      now: () => new Date(2026, 6, 22, 12, 0),
    })
    expect(result).toEqual({
      action: 'noop',
      reason: 'platform-quota',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  it('reports the seq of the row it claimed', async () => {
    const { db, dir } = dueFixture('brainrot-publish-seq-')
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 10, 0),
    })
    expect(result.results?.[0].seq).toBe(1)
    db.close()
  })
})

describe('publishNextTick — publish', () => {
  it('publishes the eligible video: publishes row done, library flipped, result fields set', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-happy-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, {
      channel: 'chan-a',
      metadataJson: JSON.stringify({
        youtube: { title: 'Great Video', description: 'desc', hashtags: ['#space'] },
      }),
    })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt123',
      url: 'https://youtube.com/shorts/yt123',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result).toEqual({
      action: 'published',
      channel: 'chan-a',
      jobId,
      results: [
        {
          platform: 'youtube',
          status: 'published',
          seq: 1,
          postId: 'yt123',
          url: 'https://youtube.com/shorts/yt123',
        },
      ],
      reclaimed: { count: 0, bytes: 0 },
    })
    const row = db
      .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      post_id: string
      url: string
    }
    expect(row).toEqual({
      status: 'done',
      post_id: 'yt123',
      url: 'https://youtube.com/shorts/yt123',
    })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('published')
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('marks a rejected upload failed, keeps the video ready, and reports publish-failed', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-fail-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => {
      throw new PublishError('upload: invalid metadata', 'rejected')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result).toEqual({
      action: 'publish-failed',
      channel: 'chan-a',
      jobId,
      results: [
        {
          platform: 'youtube',
          status: 'failed',
          seq: 1,
          error: 'upload: invalid metadata',
        },
      ],
      reclaimed: { count: 0, bytes: 0 },
    })
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string
    }
    expect(row).toEqual({ status: 'failed', error_kind: 'rejected' })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  it('maps a non-PublishError from the adapter to error_kind transient', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-transient-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => {
      throw new Error('boom')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('publish-failed')
    const row = db.prepare('SELECT error_kind FROM publishes WHERE job_id = ?').get(jobId) as {
      error_kind: string
    }
    expect(row.error_kind).toBe('transient')
    db.close()
  })

  // The upload landed — the video is public — and only the finalize write
  // failed. Marking the row failed would put the same job back in the
  // eligibility pool and publish it a second time, so the row stays claimed
  // and the repair sweep heals it to 'interrupted' for `publish mark-done`.
  it('leaves the row claimed when the finalize write throws after a live upload', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-finalize-throw-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt-live-1',
      url: 'https://youtube.com/shorts/yt-live-1',
    }))
    vi.mocked(markPublishDone).mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('publish-failed')
    expect(result.jobId).toBe(jobId)
    // Reported 'unknown', never 'failed': the post may be live, so the video
    // must not go back in the pool. The post facts survive in the error text —
    // the operator needs them to confirm the upload in Studio and run
    // `publish mark-done`.
    expect(result.results?.[0].status).toBe('unknown')
    expect(result.results?.[0].error).toContain('yt-live-1')
    expect(result.results?.[0].error).toContain('https://youtube.com/shorts/yt-live-1')
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string | null
    }
    expect(row).toEqual({ status: 'claimed', error_kind: null })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  // Same duplicate-upload hazard from the other side: YouTube accepted the
  // bytes but its success body was unreadable.
  it('leaves the row claimed when the adapter reports an unknown outcome', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-unknown-outcome-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => {
      throw new PublishOutcomeUnknownError(
        'youtubeTarget: accepted the upload but its success body carried no video id',
      )
    })
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result).toEqual({
      action: 'publish-failed',
      channel: 'chan-a',
      jobId,
      results: [
        {
          platform: 'youtube',
          status: 'unknown',
          seq: 1,
          error: 'youtubeTarget: accepted the upload but its success body carried no video id',
        },
      ],
      reclaimed: { count: 0, bytes: 0 },
    })
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string | null
    }
    expect(row).toEqual({ status: 'claimed', error_kind: null })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })

  it('stamps finished_at when the write happens, not when the tick started', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-finished-at-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // A clock that advances between the tick's planning read and the
    // finalize write, standing in for a multi-minute upload.
    const started = NOW()
    const finished = new Date(started.getTime() + 4 * 60_000)
    const clock = [started, finished]
    let call = 0
    const now = () => clock[Math.min(call++, clock.length - 1)]
    const target = fakeAdapter(async () => ({
      postId: 'yt-slow-1',
      url: 'https://youtube.com/shorts/yt-slow-1',
    }))
    await publishNextTick(db, { channelsDir, now, adapters: { youtube: target } })
    const row = db.prepare('SELECT finished_at FROM publishes WHERE job_id = ?').get(jobId) as {
      finished_at: string
    }
    expect(row.finished_at).toBe(finished.toISOString())
    db.close()
  })

  // A racing tick winning the ordinal is that ONE platform's failure, not the
  // tick's: the other platforms in a fan-out still have work to do. With a
  // single declared platform there is nothing left, so the tick is
  // publish-failed and the CLI exits 1.
  it('reports a claim conflict as that platform failing, not as a whole-tick noop', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-conflict-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const jobId = seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    vi.mocked(claimPublish).mockReturnValueOnce(null)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'publish-failed',
      channel: 'chan-a',
      jobId,
      results: [{ platform: 'youtube', status: 'failed', error: 'claim conflict' }],
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })
})

describe('publishNextTick — media resolved from object storage', () => {
  // A pruned runs/ tree is now normal (the bucket is the durable copy), so a
  // candidate whose local file is gone but has a library_objects row must
  // still qualify and publish — the pre-flight guard is "local file OR
  // stored object", not "local file alone".
  it('qualifies and publishes a candidate whose local file is gone but has a stored object', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-qualify-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    // No youtube token is seeded for 'chan', so youtube fails hasCredential
    // and is never attempted — leaving instagram as the only target that can
    // be picked, without needing to touch either platform's quota.
    const jobId = seedReadyVideo(db, { channel: 'chan', videoExists: false })
    seedObjectKey(db, jobId, 'videos/chan/job.mp4')
    const storeDir = tmpDir('brainrot-publish-fakestore-')
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: urlResolvingAdapter() },
      store: fakeStore(storeDir),
    })
    expect(result).toMatchObject({
      action: 'published',
      channel: 'chan',
      jobId,
      results: [{ platform: 'instagram', status: 'published', postId: 'ig-post-1' }],
    })
    db.close()
  })

  it('excludes a candidate with neither a local file nor a stored object, reporting no-video-file', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-noqualify-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'chan', videoExists: false })
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: urlResolvingAdapter() },
    })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-video-file',
      reclaimed: { count: 0, bytes: 0 },
    })
    db.close()
  })

  // s3ConfigFromEnv() throws when object storage is unconfigured (design:
  // no silent local fallback). A YouTube-only deployment must keep working;
  // an Instagram upload that actually needs the store must fail the one
  // video legibly rather than crash the whole tick. The failure is
  // 'transient', not 'rejected': a deploy that drops or breaks BRAINROT_S3_*
  // is a misconfiguration of the environment, not a defect in the video, and
  // 'rejected' counts toward rejectedCount's un-undoable 3-attempt retirement
  // cap (src/publish/publishes.ts channelVideoCandidates).
  it('degrades to a legible transient failure, not a crash, when no store is configured or injected', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-unconfigured-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    const jobId = seedReadyVideo(db, { channel: 'chan', videoExists: false })
    seedObjectKey(db, jobId, 'videos/chan/job.mp4')
    const now = () => new Date(2026, 6, 22, 10, 0)
    // No `store` in opts, and BRAINROT_S3_* is stubbed empty in beforeEach —
    // resolveStore() must catch s3ConfigFromEnv()'s throw rather than let it
    // escape the tick.
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: urlResolvingAdapter() },
    })
    expect(result.action).toBe('publish-failed')
    expect(result.jobId).toBe(jobId)
    const row = db
      .prepare('SELECT status, error_kind FROM publishes WHERE job_id = ?')
      .get(jobId) as {
      status: string
      error_kind: string
    }
    expect(row).toEqual({ status: 'failed', error_kind: 'transient' })
    db.close()
  })

  // A signed URL is a bearer capability with a long TTL (IG_PRESIGN_TTL_SECONDS)
  // — the tick must never write it anywhere, only the object key. Only the
  // preflight CLI command (a later task) is allowed to print one.
  it('never logs the presigned URL', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nolog-url-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    const jobId = seedReadyVideo(db, { channel: 'chan', videoExists: false })
    seedObjectKey(db, jobId, 'videos/chan/job.mp4')
    const storeDir = tmpDir('brainrot-publish-fakestore-nolog-')
    const now = () => new Date(2026, 6, 22, 10, 0)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: urlResolvingAdapter() },
      store: fakeStore(storeDir),
    })
    expect(result.action).toBe('published')
    const everyLoggedString = [...log.mock.calls, ...error.mock.calls].flat().join('\n')
    // fakeStore's presignGet shape is `fake-store://<key>?ttl=<n>` — assert
    // neither the ttl query param nor the fake-store scheme reached a log.
    expect(everyLoggedString).not.toContain('ttl=')
    expect(everyLoggedString).not.toContain('fake-store://')
    log.mockRestore()
    error.mockRestore()
    db.close()
  })
})

describe('publishNextTick — fan-out across every declared platform', () => {
  it('publishes one video to both declared platforms in a single tick', async () => {
    const { db, dir, jobId, adapters } = fanOutFixture('brainrot-publish-fanout-both-')
    const result = await publishNextTick(db, { channelsDir: dir, adapters, now: FANOUT_NOW })
    expect(result.action).toBe('published')
    expect(result.channel).toBe('test')
    expect(result.jobId).toBe(jobId)
    // Ordered by the channel's target order, which loadChannelConfig sorts by
    // platform name — so instagram precedes youtube.
    expect(result.results).toEqual([
      {
        platform: 'instagram',
        status: 'published',
        seq: 1,
        postId: 'ig-1',
        url: 'https://instagram.test/ig-1',
      },
      {
        platform: 'youtube',
        status: 'published',
        seq: 1,
        postId: 'yt-1',
        url: 'https://youtu.be/yt-1',
      },
    ])
    db.close()
  })

  it('counts a two-platform fan-out as ONE video against videos_per_day', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-count-')
    await publishNextTick(db, { channelsDir: dir, adapters, now: FANOUT_NOW })
    expect(videosPublishedToday(db, 'test', '2026-07-22')).toBe(1)
    db.close()
  })

  it('records both platforms against the same job, each with its own row', async () => {
    const { db, dir, jobId, adapters } = fanOutFixture('brainrot-publish-fanout-rows-')
    await publishNextTick(db, { channelsDir: dir, adapters, now: FANOUT_NOW })
    const rows = listPublishes(db).filter((r) => r.jobId === jobId)
    expect(rows.map((r) => [r.platform, r.status, r.seq]).sort()).toEqual([
      ['instagram', 'done', 1],
      ['youtube', 'done', 1],
    ])
    db.close()
  })

  it('keeps going after one platform fails, and reports both outcomes', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-onefail-')
    const failing = {
      ...adapters,
      youtube: {
        ...adapters.youtube,
        upload: async () => {
          throw new PublishError('bad video', 'rejected')
        },
      },
    }
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: failing,
      now: FANOUT_NOW,
    })
    expect(result.action).toBe('published')
    expect(result.results).toEqual([
      {
        platform: 'instagram',
        status: 'published',
        seq: 1,
        postId: 'ig-1',
        url: 'https://instagram.test/ig-1',
      },
      { platform: 'youtube', status: 'failed', seq: 1, error: 'bad video' },
    ])
    const yt = listPublishes(db).find((r) => r.platform === 'youtube')
    expect([yt?.status, yt?.errorKind]).toEqual(['failed', 'rejected'])
    db.close()
  })

  it('is publish-failed when every attempted platform fails', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-allfail-')
    const upload: PublishAdapter['upload'] = async () => {
      throw new PublishError('nope', 'transient')
    }
    const failing = {
      youtube: { ...adapters.youtube, upload },
      instagram: { ...adapters.instagram, upload },
    }
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: failing,
      now: FANOUT_NOW,
    })
    expect(result.action).toBe('publish-failed')
    expect(result.results?.map((r) => r.status)).toEqual(['failed', 'failed'])
    db.close()
  })

  it('leaves an unknown-outcome row claimed for the sweep and continues to the next platform', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-unknown-')
    const unknown = {
      ...adapters,
      instagram: {
        ...adapters.instagram,
        upload: async () => {
          throw new PublishOutcomeUnknownError('no id in response')
        },
      },
    }
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: unknown,
      now: FANOUT_NOW,
    })
    expect(result.results).toEqual([
      { platform: 'instagram', status: 'unknown', seq: 1, error: 'no id in response' },
      {
        platform: 'youtube',
        status: 'published',
        seq: 1,
        postId: 'yt-1',
        url: 'https://youtu.be/yt-1',
      },
    ])
    // Never 'failed': that would return the video to the pool and publish it a
    // second time. The next tick's sweep heals it to 'interrupted'.
    expect(listPublishes(db).find((r) => r.platform === 'instagram')?.status).toBe('claimed')
    db.close()
  })

  it('publishes to the open platform only when the other is quota-backed-off', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-quota-')
    seedQuotaFailure(db, {
      channel: 'test',
      platform: 'youtube',
      now: FANOUT_NOW(),
      msAgo: 60 * 60 * 1000,
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters,
      now: FANOUT_NOW,
    })
    expect(result.results?.map((r) => r.platform)).toEqual(['instagram'])
    db.close()
  })

  it('publishes to the credentialed platform only when the other has no token', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-nocred-')
    const noYtCred = {
      ...adapters,
      youtube: { ...adapters.youtube, hasCredential: () => false },
    }
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: noYtCred,
      now: FANOUT_NOW,
    })
    expect(result.results?.map((r) => r.platform)).toEqual(['instagram'])
    db.close()
  })

  // Instagram's create-container-then-poll upload can outlast the 30-minute
  // publish lease. Losing it mid-fan-out would let a second tick publish the
  // same video again, so the tick heartbeats before every platform after the
  // first — not before the first, which has just acquired the lease.
  it('heartbeats the lease once per platform after the first, before that upload starts', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-heartbeat-')
    // Each upload records how many heartbeats had already fired when it began —
    // a count taken only at the end could not tell a heartbeat before the second
    // upload from one after it, and only the former protects the lease.
    const heartbeatsBeforeUpload: Record<string, number> = {}
    const watching = {
      instagram: {
        ...adapters.instagram,
        upload: async (...args: Parameters<PublishAdapter['upload']>) => {
          heartbeatsBeforeUpload.instagram = vi.mocked(extendLease).mock.calls.length
          return adapters.instagram.upload(...args)
        },
      },
      youtube: {
        ...adapters.youtube,
        upload: async (...args: Parameters<PublishAdapter['upload']>) => {
          heartbeatsBeforeUpload.youtube = vi.mocked(extendLease).mock.calls.length
          return adapters.youtube.upload(...args)
        },
      },
    }
    vi.mocked(extendLease).mockClear()
    await publishNextTick(db, { channelsDir: dir, adapters: watching, now: FANOUT_NOW })
    expect(heartbeatsBeforeUpload).toEqual({ instagram: 0, youtube: 1 })
    expect(vi.mocked(extendLease)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(extendLease)).toHaveBeenCalledWith(
      db,
      'publish',
      expect.stringMatching(/^pid:/),
      PUBLISH_LEASE_TTL_MS,
    )
    db.close()
  })

  it('does not heartbeat for a single-platform channel', async () => {
    const db = memDb()
    const dir = tmpDir('brainrot-publish-fanout-single-')
    writeChannel(dir, { name: 'test', publish: true, videosPerDay: 1 })
    seedReadyVideo(db, { channel: 'test' })
    const adapters = {
      youtube: {
        ...fakeAdapter(async () => ({ postId: 'yt-1', url: 'https://youtu.be/yt-1' })),
        quota: PLATFORM_QUOTAS.youtube,
      },
    }
    vi.mocked(extendLease).mockClear()
    const result = await publishNextTick(db, { channelsDir: dir, adapters, now: FANOUT_NOW })
    expect(result.action).toBe('published')
    expect(vi.mocked(extendLease)).not.toHaveBeenCalled()
    db.close()
  })

  // Regression test for the double-publish bug: leg 1 (instagram) runs past
  // the lease TTL, a takeover tick claims the lease, and THEN leg 1's
  // heartbeat comes back `false` because this holder was already evicted.
  // Continuing to leg 2 (youtube) here — ignoring the `false` — would let
  // this holder claim and upload youtube out from under the new holder,
  // posting it twice. The fan-out must stop instead: report instagram's real
  // success, never call youtube's upload, and leave no youtube row behind.
  it('stops the fan-out and reports the rest skipped when a mid-fan-out heartbeat reports eviction', async () => {
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-evicted-')
    const youtubeUpload = vi.fn(adapters.youtube.upload)
    const watched: Record<Platform, PublishAdapter> = {
      ...adapters,
      youtube: { ...adapters.youtube, upload: youtubeUpload },
    }
    // Only one extendLease call happens in a two-platform fan-out (before the
    // second leg, instagram then youtube by target order) — make that one
    // call report eviction.
    vi.mocked(extendLease).mockReturnValueOnce(false)
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: watched,
      now: FANOUT_NOW,
    })
    expect(result.action).toBe('published')
    expect(result.results).toEqual([
      {
        platform: 'instagram',
        status: 'published',
        seq: 1,
        postId: 'ig-1',
        url: 'https://instagram.test/ig-1',
      },
      {
        platform: 'youtube',
        status: 'skipped',
        error: expect.stringContaining('lease'),
      },
    ])
    expect(youtubeUpload).not.toHaveBeenCalled()
    // No publishes row at all for the skipped platform — nothing was claimed
    // for it, so there is nothing for the sweep to heal either.
    expect(listPublishes(db).find((r) => r.platform === 'youtube')).toBeUndefined()
    db.close()
  })

  it('dry-run previews the video and every platform it would reach, writing nothing', async () => {
    const { db, dir, jobId, adapters } = fanOutFixture('brainrot-publish-fanout-dryrun-')
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters,
      dryRun: true,
      now: FANOUT_NOW,
    })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'test',
        jobId,
        title: 'Fan-out topic',
        platforms: ['instagram', 'youtube'],
      },
    })
    expect(listPublishes(db)).toEqual([])
    db.close()
  })

  // The archived-video path, and the whole reason the durable copy lives in the
  // object bucket: runs/ is a disposable cache, so a video with no local file
  // must still fan out, with each platform's media handle served from the store.
  it('fans an archived video out from its stored object when the local file is gone', async () => {
    const db = memDb()
    const dir = tmpDir('brainrot-publish-fanout-archived-')
    writeChannel(dir, { name: 'test', publish: true, instagram: true, videosPerDay: 1 })
    const jobId = seedReadyVideo(db, { channel: 'test', videoExists: false })
    const objectKey = 'videos/test/archived.mp4'
    seedObjectKey(db, jobId, objectKey)
    const store = fakeStore(tmpDir('brainrot-publish-fanout-archived-store-'))
    await store.put(objectKey, Buffer.from('archived video bytes'), 'video/mp4')
    // Each adapter reads the bytes through the handle the tick built for it, so
    // `seen` proves the store — not a local file — served both platforms.
    const seen: string[] = []
    const readBytes = (postId: string): PublishAdapter['upload'] =>
      async function upload(req) {
        seen.push((await req.media.bytes()).toString())
        return { postId, url: `https://example.test/${postId}` }
      }
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: {
        youtube: { ...fakeAdapter(readBytes('yt-arch')), quota: PLATFORM_QUOTAS.youtube },
        instagram: { ...fakeIgAdapter(readBytes('ig-arch')), quota: PLATFORM_QUOTAS.instagram },
      },
      store,
      now: FANOUT_NOW,
    })
    expect(result.action).toBe('published')
    expect(result.jobId).toBe(jobId)
    expect(result.results?.map((r) => [r.platform, r.status, r.postId])).toEqual([
      ['instagram', 'published', 'ig-arch'],
      ['youtube', 'published', 'yt-arch'],
    ])
    expect(seen).toEqual(['archived video bytes', 'archived video bytes'])
    db.close()
  })
})

describe('publishNextTick — lease and sweep', () => {
  it('no-ops with reason lease-held while another process holds the lease', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-lease-')
    // Deliberately an empty library: the lease gate must short-circuit BEFORE
    // any due/candidate work runs, so this fixture stays safe (no
    // mintAccessToken/network reachable) whether or not the gate is wired yet.
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    acquireLease(db, 'publish', 'pid:other', PUBLISH_LEASE_TTL_MS)
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
    db.close()
  })

  it('releases the lease after a successful publish', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-release-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await publishNextTick(db, { channelsDir, now: NOW, adapters: { youtube: target } })
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('releases the lease when the tick throws mid-flight', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-throw-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    // A throw from inside the leased window (here: the claim write) must still
    // release on the way out, so one crash cannot wedge publishing for a TTL.
    vi.mocked(claimPublish).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    await expect(
      publishNextTick(db, { channelsDir, now: NOW, adapters: { youtube: target } }),
    ).rejects.toThrow('disk full')
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('sweeps a stale claimed row to interrupted before planning the tick', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-sweep-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // Seed the stale claim RELATIVE to NOW (65 min ago > 30-min TTL, and also
    // past the 10 min PUBLISH_COOLDOWN_MS) so the age is identical in every
    // timezone the suite runs in. No ready video is seeded for chan-a, so the
    // planning half then reports 'no-ready-video' — the point of the test is
    // that the sweep ran first, proven below by the row's status flip.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-22', 1, 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 65 * 60_000).toISOString())
    const result = await publishNextTick(db, { channelsDir, now: NOW })
    expect(result).toEqual({
      action: 'noop',
      reason: 'no-ready-video',
      reclaimed: { count: 0, bytes: 0 },
    })
    const row = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(row.status).toBe('interrupted')
    db.close()
  })

  it('dry-run never acquires the lease, never sweeps, and writes nothing', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-dryrun-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    // Old enough that a real sweep WOULD flip it — proving dry-run skipped it.
    // 26h back (not 65 min) so it also sits outside the channel's min gap and
    // the tick still reaches its preview.
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('stale-job', 'youtube', 'chan-a', '2026-07-21', 1, 'claimed', 1, ?)",
    ).run(new Date(NOW().getTime() - 26 * 3_600_000).toISOString())
    const jobId = seedReadyVideo(db, { channel: 'chan-a', topic: 'Preview me' })
    seedToken(db, 'chan-a')
    const result = await publishNextTick(db, { channelsDir, now: NOW, dryRun: true })
    expect(result).toEqual({
      action: 'dry-run',
      wouldPublish: {
        channel: 'chan-a',
        jobId,
        title: 'Preview me',
        platforms: ['youtube'],
      },
    })
    // the stale row from a DIFFERENT day is untouched: sweep never ran
    const stale = db.prepare("SELECT status FROM publishes WHERE job_id = 'stale-job'").get() as {
      status: string
    }
    expect(stale.status).toBe('claimed')
    // no new row for today, no lease taken
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM publishes WHERE day = '2026-07-22'").get() as {
        n: number
      }
    ).n
    expect(count).toBe(0)
    const lease = db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()
    expect(lease).toBeUndefined()
    db.close()
  })
})

describe('reclaim sweep', () => {
  it('deletes and reports the object of a fully-published video', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-reclaim-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const store = fakeStore(tmpDir('brainrot-publish-reclaim-store-'))
    await store.put('videos/chan-a/job-old.mp4', Buffer.from('video'), 'video/mp4')
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'published', createdAt: '2026-07-01T00:00:00.000Z' })
    seedLibraryObject(db, 'job-old', { objectKey: 'videos/chan-a/job-old.mp4', bytes: 4096 })
    seedPublish(db, 'job-old', { platform: 'youtube', channel: 'chan-a', status: 'done', seq: 1 })

    const result = await publishNextTick(db, {
      channelsDir,
      store,
      now: () => new Date('2026-07-27T10:00:00.000Z'),
    })

    expect(result.reclaimed).toEqual({ count: 1, bytes: 4096 })
    expect(await store.head('videos/chan-a/job-old.mp4')).toBeNull()
    db.close()
  })

  it('leaves a half-published video alone', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-reclaim-half-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const store = fakeStore(tmpDir('brainrot-publish-reclaim-half-store-'))
    await store.put('videos/chan-a/job-new.mp4', Buffer.from('video'), 'video/mp4')
    seedJob(db, 'job-new', { channel: 'chan-a' })
    seedLibrary(db, 'job-new', { state: 'published', createdAt: '2026-07-27T09:00:00.000Z' })
    seedLibraryObject(db, 'job-new', { objectKey: 'videos/chan-a/job-new.mp4', bytes: 4096 })
    seedPublish(db, 'job-new', { platform: 'instagram', channel: 'chan-a', status: 'done', seq: 1 })

    const result = await publishNextTick(db, {
      channelsDir,
      store,
      now: () => new Date('2026-07-27T10:00:00.000Z'),
    })

    expect(result.reclaimed).toEqual({ count: 0, bytes: 0 })
    expect(await store.head('videos/chan-a/job-new.mp4')).not.toBeNull()
    db.close()
  })

  it('does not sweep on a dry run', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-reclaim-dryrun-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    const store = fakeStore(tmpDir('brainrot-publish-reclaim-dryrun-store-'))
    await store.put('videos/chan-a/job-old.mp4', Buffer.from('video'), 'video/mp4')
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'published', createdAt: '2026-07-01T00:00:00.000Z' })
    seedLibraryObject(db, 'job-old', { objectKey: 'videos/chan-a/job-old.mp4', bytes: 4096 })
    seedPublish(db, 'job-old', { platform: 'youtube', channel: 'chan-a', status: 'done', seq: 1 })

    const result = await publishNextTick(db, {
      channelsDir,
      store,
      dryRun: true,
      now: () => new Date('2026-07-27T10:00:00.000Z'),
    })

    expect(result.reclaimed).toBeUndefined()
    expect(await store.head('videos/chan-a/job-old.mp4')).not.toBeNull()
    db.close()
  })
})

describe('publishNextTick — config errors', () => {
  it('no-ops with reason config-error on an unparseable channel TOML, naming the file', async () => {
    const db = memDb()
    const brokenDir = tmpDir('brainrot-publish-broken-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await publishNextTick(db, { channelsDir: brokenDir, now: NOW })
    // One well-formed JSON line (exit 0 at the CLI) instead of a throw that
    // escaped with no line at all, every 15 minutes, until the file is fixed.
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    expect(result.error).toContain('broken.toml')
    // The cause travels in the result, never on stderr: this tick reruns every
    // 30s under the daemon, where an unstructured print bypasses runWorker's
    // idle dedupe. `brainrot publish-next` prints it for a human (cli.ts).
    expect(stderr).not.toHaveBeenCalled()
    stderr.mockRestore()
    db.close()
  })

  it('no-ops with reason config-error when the channels dir does not exist', async () => {
    const db = memDb()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await publishNextTick(db, {
      channelsDir: join(tmpdir(), 'brainrot-no-such-channels-dir'),
      now: NOW,
    })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    stderr.mockRestore()
    db.close()
  })

  it('never takes the publish lease on a broken config', async () => {
    const db = memDb()
    const brokenDir = tmpDir('brainrot-publish-broken-lease-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await publishNextTick(db, { channelsDir: brokenDir, now: NOW })
    // Never acquired, not merely released: a broken config cannot take a lease,
    // and the sweep it would have run never touches rows either.
    expect(db.prepare("SELECT * FROM leases WHERE name = 'publish'").get()).toBeUndefined()
    expect(acquireLease(db, 'publish', 'pid:probe', PUBLISH_LEASE_TTL_MS)).toBe(true)
    stderr.mockRestore()
    db.close()
  })

  it('a healthy channels dir is unaffected: the tick publishes as before', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-healthy-')
    writeChannel(channelsDir, { name: 'chan-a', publish: true })
    seedReadyVideo(db, { channel: 'chan-a' })
    seedToken(db, 'chan-a')
    const target = fakeAdapter(async () => ({
      postId: 'yt1',
      url: 'https://youtube.com/shorts/yt1',
    }))
    const result = await publishNextTick(db, {
      channelsDir,
      now: NOW,
      adapters: { youtube: target },
    })
    expect(result.action).toBe('published')
    expect(result.reason).toBeUndefined()
    db.close()
  })
})

describe('publish-next CLI', () => {
  it.concurrent(
    '`publish-next --help` prints usage with --root/--dry-run/--force',
    async () => {
      const result = await runCli(['publish-next', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--root')
      expect(result.stdout).not.toContain('--channels-dir')
      expect(result.stdout).toContain('--dry-run')
      expect(result.stdout).toContain('--force')
    },
    60000,
  )

  it.concurrent(
    '`publish-next` with no publishing channel prints one noop JSON line and exits 0',
    async () => {
      const root = testRoot('brainrot-publish-cli-')
      writeChannel(root.channelsDir, { name: 'chan-a' })
      const result = await runCli(['publish-next', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'noop',
        reason: 'no-publish-channel',
        reclaimed: { count: 0, bytes: 0 },
      })
    },
    60000,
  )

  it.concurrent(
    '`publish-next --dry-run` with no publishing channel prints one dry-run JSON line and exits 0',
    async () => {
      const root = testRoot('brainrot-publish-cli-dry-')
      writeChannel(root.channelsDir, { name: 'chan-a' })
      const result = await runCli(['publish-next', '--root', root.root, '--dry-run'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'dry-run',
        wouldPublish: null,
        reason: 'no-publish-channel',
      })
    },
    60000,
  )

  // The tick itself is silent now (it reruns every 30s under the daemon); the
  // one-shot command is where a human is reading stderr, so this is where the
  // cause has to stay legible.
  it.concurrent(
    '`publish-next` over a broken channels dir names the file on stderr, one JSON line, exit 0',
    async () => {
      const root = testRoot('brainrot-publish-cli-broken-')
      writeFileSync(join(root.channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['publish-next', '--root', root.root])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const line = JSON.parse(result.stdout) as { action: string; reason: string; error: string }
      expect(line.action).toBe('noop')
      expect(line.reason).toBe('config-error')
      expect(result.stderr).toContain('broken.toml')
    },
    60000,
  )
})

describe('publishExitCode (in-process)', () => {
  it('is 0 when every result published', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'published', seq: 1 },
      ],
    }
    expect(publishExitCode(result)).toBe(0)
  })

  it('is 1 when any result is failed', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'failed', error: 'bad video' },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when any result is unknown', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'unknown', error: 'no id in response' },
        { platform: 'youtube', status: 'published', seq: 1 },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when any result is skipped', () => {
    const result: PublishTickResult = {
      action: 'published',
      channel: 'test',
      jobId: 'job-1',
      results: [
        { platform: 'instagram', status: 'published', seq: 1 },
        { platform: 'youtube', status: 'skipped', error: 'lease lost mid-fan-out' },
      ],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 1 when the action is publish-failed', () => {
    const result: PublishTickResult = {
      action: 'publish-failed',
      channel: 'test',
      jobId: 'job-1',
      results: [{ platform: 'youtube', status: 'failed', error: 'nope' }],
    }
    expect(publishExitCode(result)).toBe(1)
  })

  it('is 0 for every noop/dry-run reason', () => {
    const reasons: PublishTickResult[] = [
      { action: 'noop', reason: 'lease-held' },
      { action: 'noop', reason: 'no-publish-channel' },
      { action: 'noop', reason: 'paced' },
      { action: 'noop', reason: 'daily-count-met' },
      { action: 'noop', reason: 'platform-quota' },
      { action: 'noop', reason: 'no-ready-video' },
      { action: 'noop', reason: 'no-video-file' },
      { action: 'noop', reason: 'no-auth' },
      { action: 'noop', reason: 'bad-env' },
      { action: 'noop', reason: 'config-error' },
      { action: 'dry-run', wouldPublish: null },
      {
        action: 'dry-run',
        wouldPublish: { channel: 'test', jobId: 'job-1', title: 't', platforms: ['youtube'] },
      },
    ]
    for (const result of reasons) {
      expect(publishExitCode(result)).toBe(0)
    }
  })
})
