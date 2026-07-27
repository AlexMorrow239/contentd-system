import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listPublishes, videosPublishedToday } from '../publish/publishes.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import type { Platform, PublishAdapter } from '../publish/types.js'
import { PublishError, PublishOutcomeUnknownError } from '../publish/types.js'
import { fakeStore } from '../storage/fake.js'
import { extendLease, PUBLISH_LEASE_TTL_MS } from './lease.js'
import { publishNextTick } from './publish-next.js'
import {
  FANOUT_NOW,
  fakeAdapter,
  fakeIgAdapter,
  fanOutFixture,
  seedAttempt,
  seedObjectKey,
  seedReadyVideo,
  stubPublishEnv,
  writeChannel,
} from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'
import { memDb } from '../testing/db.js'

/**
 * Fan-out across every declared platform for one video, and the lease
 * heartbeats that keep it alive mid-fan-out.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

// Spies extendLease so the fan-out tests can count the mid-fan-out heartbeats.
// acquireLease and releaseLease stay REAL (the factory spreads the original
// module) because every lease test in this file asserts on their actual
// database effect.
vi.mock('./lease.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lease.js')>()
  return { ...actual, extendLease: vi.fn(actual.extendLease) }
})

beforeEach(() => {
  stubPublishEnv(vi)
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

  it('publishes to the open platform only when the other is at quota', async () => {
    // The cap parser rejects 0, so set it to 1 and consume that one upload.
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const { db, dir, adapters } = fanOutFixture('brainrot-publish-fanout-quota-')
    seedAttempt(db, {
      jobId: 'job-other',
      channel: 'test',
      platform: 'youtube',
      day: '2026-07-22',
    })
    // That seeded attempt also meets the channel's day count and resets its
    // pacing clock, so --force is what keeps this a quota test.
    const result = await publishNextTick(db, {
      channelsDir: dir,
      adapters,
      force: true,
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
