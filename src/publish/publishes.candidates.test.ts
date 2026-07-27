import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedLibrary } from '../testing/db.js'
import {
  channelVideoCandidates,
  claimPublish,
  markPublishDone,
  markPublishFailed,
  MAX_PUBLISH_ATTEMPTS,
} from './publishes.js'
import { PUBLISH_PLATFORMS } from './types.js'

/**
 * channelVideoCandidates: which ready videos a channel may still publish,
 * and which platforms are blocked for each.
 *
 * Split from a single 1134-line publishes.test.ts that held one describe per
 * exported DAO function with its fixtures scattered between them; the shared
 * ones now live in _publishes.fixtures.ts and src/testing/db.ts.
 */

describe('channelVideoCandidates', () => {
  it('returns nothing for a channel with no publishable library rows', () => {
    const db = memDb()
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })

  it('returns a ready video with no platforms blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a', topic: 'ready topic' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([
      {
        jobId: 'job-1',
        videoPath: '/runs/job-1/assemble/final.mp4',
        objectKey: null,
        metadataJson: '{}',
        topic: 'ready topic',
        blockedPlatforms: [],
      },
    ])
    db.close()
  })

  it('excludes library rows that are not publishable', () => {
    const db = memDb()
    seedJob(db, 'job-ready', { channel: 'chan-a' })
    seedJob(db, 'job-review', { channel: 'chan-a' })
    seedJob(db, 'job-blocked', { channel: 'chan-a' })
    seedLibrary(db, 'job-ready', { state: 'ready' })
    seedLibrary(db, 'job-review', { state: 'needs-review' })
    seedLibrary(db, 'job-blocked', { state: 'blocked' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10).map((r) => r.jobId)).toEqual(
      ['job-ready'],
    )
    db.close()
  })

  // library_objects is LEFT-joined, never inner-joined: a library row predating
  // object storage has no object row and must still be selectable so it can
  // publish from its local file.
  it('carries the object key when the job has one', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    db.prepare(
      "INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES ('job-1', 'videos/chan-a/job-1.mp4', 10, 'e')",
    ).run()
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].objectKey).toBe(
      'videos/chan-a/job-1.mp4',
    )
    db.close()
  })

  it('reports a platform with a done row as blocked, leaving the other open', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['youtube'],
    )
    db.close()
  })

  it('reports a claimed row as blocking (in flight)', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['instagram'],
    )
    db.close()
  })

  it('reports a platform at the rejection cap as blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    for (let i = 0; i < MAX_PUBLISH_ATTEMPTS; i++) {
      const claim = claimPublish(db, {
        jobId: 'job-1',
        platform: 'youtube',
        channel: 'chan-a',
        day: `2026-07-2${i}`,
      })
      markPublishFailed(db, claim!.id, 'bad video', 'rejected', new Date())
    }
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      ['youtube'],
    )
    db.close()
  })

  it('does not treat a transient failure as blocking — that video retries', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'network', 'transient', new Date())
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)[0].blockedPlatforms).toEqual(
      [],
    )
    db.close()
  })

  it('omits a video whose every platform is blocked', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    for (const platform of ['youtube', 'instagram'] as const) {
      const claim = claimPublish(db, {
        jobId: 'job-1',
        platform,
        channel: 'chan-a',
        day: '2026-07-22',
      })
      markPublishDone(db, claim!.id, `${platform}-1`, 'https://example.test/x', new Date())
    }
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })

  // "Every platform" means every platform the CHANNEL declares, not every
  // platform the codebase knows about. A single-platform channel's published
  // video is finished even though a second platform exists in PUBLISH_PLATFORMS.
  it('omits a video published to the only platform the channel declares', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'published' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishDone(db, claim!.id, 'yt-1', 'https://youtu.be/yt-1', new Date())
    expect(channelVideoCandidates(db, 'chan-a', ['youtube'], 10)).toEqual([])
    // Still open — and still reported blocked on youtube — for a channel that
    // also declares instagram.
    expect(
      channelVideoCandidates(db, 'chan-a', ['youtube', 'instagram'], 10)[0].blockedPlatforms,
    ).toEqual(['youtube'])
    db.close()
  })

  // Regression (final-review Fix 1): the drop test used to compare against the
  // GLOBAL platform count, so on a youtube-only channel an already-published
  // video (blockedPlatforms ['youtube'], 1 < 2) was still returned and still
  // consumed one of the caller's `limit` slots. Because ordering is
  // failedCount ASC first, a genuinely publishable video carrying one
  // 'transient' failure sorts BEHIND every zero-failure row — so once a
  // channel accumulated `limit` published rows (~17 days at 3/day) it was
  // never returned at all, and the tick reported no-ready-video while a
  // publishable video sat in the library.
  it('returns a once-failed video that published rows would otherwise crowd out', () => {
    const db = memDb()
    const limit = 5
    // limit + 1 already-published videos, all newer than the failed one, each
    // done on the channel's only declared platform.
    for (let i = 0; i <= limit; i++) {
      const jobId = `job-done-${i}`
      seedJob(db, jobId, { channel: 'chan-a' })
      seedLibrary(db, jobId, {
        state: 'published',
        createdAt: `2026-07-2${i}T00:00:00.000Z`,
      })
      const claim = claimPublish(db, {
        jobId,
        platform: 'youtube',
        channel: 'chan-a',
        day: `2026-07-2${i}`,
      })
      markPublishDone(db, claim!.id, `yt-${i}`, `https://youtu.be/yt-${i}`, new Date())
    }
    seedJob(db, 'job-hurt', { channel: 'chan-a' })
    seedLibrary(db, 'job-hurt', { state: 'ready', createdAt: '2026-07-10T00:00:00.000Z' })
    const hurt = claimPublish(db, {
      jobId: 'job-hurt',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-19',
    })
    markPublishFailed(db, hurt!.id, 'network', 'transient', new Date())

    expect(channelVideoCandidates(db, 'chan-a', ['youtube'], limit).map((r) => r.jobId)).toEqual([
      'job-hurt',
    ])
    db.close()
  })

  // A channel declaring no platform has nothing to publish, and `platform IN ()`
  // is not valid SQL — so this is an explicit early return, asserted.
  it('returns nothing when no platforms are declared', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', [], 10)).toEqual([])
    db.close()
  })

  it('orders fewest prior failures first, then newest library row', () => {
    const db = memDb()
    seedJob(db, 'job-old', { channel: 'chan-a' })
    seedJob(db, 'job-new', { channel: 'chan-a' })
    seedJob(db, 'job-hurt', { channel: 'chan-a' })
    seedLibrary(db, 'job-old', { state: 'ready', createdAt: '2026-07-20T00:00:00.000Z' })
    seedLibrary(db, 'job-new', { state: 'ready', createdAt: '2026-07-22T00:00:00.000Z' })
    seedLibrary(db, 'job-hurt', { state: 'ready', createdAt: '2026-07-23T00:00:00.000Z' })
    const claim = claimPublish(db, {
      jobId: 'job-hurt',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'network', 'transient', new Date())
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10).map((r) => r.jobId)).toEqual(
      ['job-new', 'job-old', 'job-hurt'],
    )
    db.close()
  })

  it('honours the limit', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedLibrary(db, 'job-2', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 1)).toHaveLength(1)
    db.close()
  })

  it('ignores other channels', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-b' })
    seedLibrary(db, 'job-1', { state: 'ready' })
    expect(channelVideoCandidates(db, 'chan-a', PUBLISH_PLATFORMS, 10)).toEqual([])
    db.close()
  })
})
