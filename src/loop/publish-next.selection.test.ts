import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import type { Platform, PublishAdapter } from '../publish/types.js'
import { publishNextTick } from './publish-next.js'
import {
  NOW,
  fakeAdapter,
  seedAttempt,
  seedReadyVideo,
  seedToken,
  stubPublishEnv,
  writeChannel,
} from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'
import { memDb } from '../testing/db.js'

/**
 * Which candidate the tick picks, and whether it is due at all: dry-run
 * ordering plus the cadence/window due gate.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

beforeEach(() => {
  stubPublishEnv(vi)
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
      createdAt: '2026-07-20T00:00:00.000Z',
    })
    seedReadyVideo(db, {
      channel: 'chan-a',
      topic: 'Newest topic',
      createdAt: '2026-07-21T00:00:00.000Z',
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
    expect(result).toEqual({ action: 'noop', reason: 'no-video-file' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM publishes').get()).toEqual({ n: 0 })
    db.close()
  })

  it('picks the emptier channel over the fuller one regardless of name order', async () => {
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-fair-')
    // chan-a at 3/day (a 4h gap) so its 09:00 attempt is 5h05m behind NOW and
    // therefore NOT paced — the ordering, not the gap, is what this asserts.
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

  // fakeAdapter hardcodes cap: () => 6; the real descriptor is substituted here
  // so BRAINROT_YT_UPLOADS_PER_DAY still governs, which the --force quota case
  // below depends on.
  function publishingAdapters(): Partial<Record<Platform, PublishAdapter>> {
    const base = fakeAdapter(async () => ({
      postId: 'yt-due',
      url: 'https://youtube.com/shorts/yt-due',
    }))
    return { youtube: { ...base, quota: PLATFORM_QUOTAS.youtube } }
  }

  it('noops with not-in-window before 09:00 local', async () => {
    const { db, dir } = dueFixture('brainrot-publish-window-')
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 8, 30),
    })
    expect(result).toEqual({ action: 'noop', reason: 'not-in-window' })
    db.close()
  })

  it('noops with daily-count-met once videos_per_day videos were attempted', async () => {
    const { db, dir } = dueFixture('brainrot-publish-count-', 1)
    // createdAt pinned inside the min gap for videosPerDay=1 (a 12h gap) as
    // measured from `now` below: if the gates were ever reordered to check
    // pacing before the day count, this fixture would report 'paced' instead
    // and fail the assertion honestly, rather than passing by coincidence on
    // whatever the real wall clock happened to be.
    seedAttempt(db, {
      jobId: 'job-old',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
      createdAt: new Date(2026, 6, 22, 9, 0).toISOString(),
    })
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters: publishingAdapters(),
      now: () => new Date(2026, 6, 22, 19, 0),
    })
    expect(result).toEqual({ action: 'noop', reason: 'daily-count-met' })
    db.close()
  })

  it('noops with paced inside the min gap', async () => {
    // videos_per_day = 3 -> a 4h gap. Last attempt 10:00 local, now 12:00.
    const { db, dir } = dueFixture('brainrot-publish-paced-', 3)
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
      now: () => new Date(2026, 6, 22, 12, 0),
    })
    expect(result).toEqual({ action: 'noop', reason: 'paced' })
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

  it('--force publishes despite window, gap, and count', async () => {
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
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const { db, dir } = dueFixture('brainrot-publish-force-quota-', 1)
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
      now: () => new Date(2026, 6, 22, 12, 0),
    })
    expect(result).toEqual({ action: 'noop', reason: 'platform-quota' })
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
