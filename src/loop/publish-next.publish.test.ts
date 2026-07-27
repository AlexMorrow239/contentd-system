import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimPublish, markPublishDone } from '../publish/publishes.js'
import { PublishError, PublishOutcomeUnknownError } from '../publish/types.js'
import { fakeStore } from '../storage/fake.js'
import { acquireLease, PUBLISH_LEASE_TTL_MS } from './lease.js'
import { publishNextTick } from './publish-next.js'
import {
  NOW,
  fakeAdapter,
  seedObjectKey,
  seedQuotaRows,
  seedReadyVideo,
  seedToken,
  stubPublishEnv,
  urlResolvingAdapter,
  writeChannel,
} from './_publish-next.fixtures.js'
import { tmpDir } from '../testing/tmp.js'
import { memDb } from '../testing/db.js'

/**
 * The upload itself and its failure modes, including media resolved from
 * object storage.
 *
 * Split from a single 1825-line publish-next.test.ts — the largest file in the
 * repo — whose eleven fixtures sat in a 300-line preamble. They now live in
 * _publish-next.fixtures.ts.
 */

// Spies claimPublish so the claim-conflict test can force a `null` return
// (a racing-tick claim collision the publish lease makes unreachable in a
// single-process run), and markPublishDone so the post-upload DB-failure
// test can force a throw; every other test calls straight through to the
// real DAO because vi.fn wraps the actual implementation as its default.
vi.mock('../publish/publishes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../publish/publishes.js')>()
  return {
    ...actual,
    claimPublish: vi.fn(actual.claimPublish),
    markPublishDone: vi.fn(actual.markPublishDone),
  }
})

beforeEach(() => {
  stubPublishEnv(vi)
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
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-qualify-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    // Push youtube over its (capped-to-1) quota — on another channel, so
    // chan's own day count and pacing clock stay clear — leaving instagram as
    // the only target that can be picked.
    seedQuotaRows(db, { count: 1 })
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
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-noqualify-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedQuotaRows(db, { count: 1 })
    seedReadyVideo(db, { channel: 'chan', videoExists: false })
    const now = () => new Date(2026, 6, 22, 10, 0)
    const result = await publishNextTick(db, {
      channelsDir,
      now,
      adapters: { instagram: urlResolvingAdapter() },
    })
    expect(result).toEqual({ action: 'noop', reason: 'no-video-file' })
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
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-store-unconfigured-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedQuotaRows(db, { count: 1 })
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
    vi.stubEnv('BRAINROT_YT_UPLOADS_PER_DAY', '1')
    const db = memDb()
    const channelsDir = tmpDir('brainrot-publish-nolog-url-')
    writeChannel(channelsDir, { name: 'chan', publish: true, instagram: true, videosPerDay: 1 })
    seedQuotaRows(db, { count: 1 })
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
