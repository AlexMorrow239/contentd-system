import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedPublish } from '../testing/db.js'
import { DAY_MS, isoAgo } from './_publishes.fixtures.js'
import {
  claimPublish,
  lastAttemptAt,
  listPublishes,
  markPublishFailed,
  uploadsUsedToday,
  videosPublishedToday,
} from './publishes.js'

/**
 * Read-only accounting queries: uploadsUsedToday, listPublishes,
 * videosPublishedToday, lastAttemptAt.
 *
 * Split from a single 1134-line publishes.test.ts that held one describe per
 * exported DAO function with its fixtures scattered between them; the shared
 * ones now live in _publishes.fixtures.ts and src/testing/db.ts.
 */

describe('uploadsUsedToday', () => {
  it('counts claimed/done/interrupted and non-auth failed rows, including NULL error_kind, excluding auth failures', () => {
    const db = memDb()
    for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) seedJob(db, id)
    seedPublish(db, 'job-1', { seq: 1, status: 'claimed' })
    seedPublish(db, 'job-2', { seq: 2, status: 'done' })
    seedPublish(db, 'job-3', { seq: 3, status: 'interrupted' })
    seedPublish(db, 'job-4', { seq: 4, status: 'failed', errorKind: 'quota' })
    seedPublish(db, 'job-5', { seq: 5, status: 'failed', errorKind: null })
    seedPublish(db, 'job-6', { seq: 6, status: 'failed', errorKind: 'auth' })

    expect(uploadsUsedToday(db, 'youtube', '2026-07-20')).toBe(5)
    expect(uploadsUsedToday(db, 'youtube', '2026-07-21')).toBe(0)
    db.close()
  })

  // Design spec decision 7 (quota scope): a scope:'channel' quota (Instagram)
  // must count only its own channel's usage, distinct from the unfiltered
  // scope:'global' count (YouTube) that sums across every channel.
  it('filters to one channel when a channel is given', () => {
    const db = memDb()
    seedJob(db, 'a', { channel: 'chan-a' })
    seedJob(db, 'b', { channel: 'chan-b' })
    seedPublish(db, 'a', {
      platform: 'instagram',
      channel: 'chan-a',
      status: 'done',
      day: '2026-07-25',
    })
    seedPublish(db, 'b', {
      platform: 'instagram',
      channel: 'chan-b',
      status: 'done',
      day: '2026-07-25',
    })

    expect(uploadsUsedToday(db, 'instagram', '2026-07-25', 'chan-a')).toBe(1)
    expect(uploadsUsedToday(db, 'instagram', '2026-07-25')).toBe(2)
    db.close()
  })
})

describe('listPublishes', () => {
  it('defaults to a 7-day window, newest first, mapped to camelCase', () => {
    const db = memDb()
    seedJob(db, 'job-newer')
    seedJob(db, 'job-older')
    seedJob(db, 'job-out')
    const newerAt = isoAgo(1 * DAY_MS)
    const olderAt = isoAgo(2 * DAY_MS)
    const newerId = seedPublish(db, 'job-newer', {
      status: 'done',
      postId: 'yt-1',
      url: 'https://youtube.com/shorts/yt-1',
      createdAt: newerAt,
    })
    const olderId = seedPublish(db, 'job-older', {
      seq: 2,
      status: 'failed',
      errorKind: 'rejected',
      createdAt: olderAt,
    })
    seedPublish(db, 'job-out', {
      seq: 3,
      status: 'failed',
      errorKind: 'transient',
      createdAt: isoAgo(8 * DAY_MS),
    })

    const rows = listPublishes(db)
    expect(rows.map((r) => r.id)).toEqual([newerId, olderId])
    expect(rows[0]).toEqual({
      id: newerId,
      jobId: 'job-newer',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-20',
      seq: 1,
      status: 'done',
      postId: 'yt-1',
      url: 'https://youtube.com/shorts/yt-1',
      error: null,
      errorKind: null,
      attempt: 1,
      createdAt: newerAt,
      finishedAt: null,
    })
    db.close()
  })

  it('sinceDays widens or narrows the window', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedPublish(db, 'job-1', { createdAt: isoAgo(8 * DAY_MS) })

    expect(listPublishes(db)).toHaveLength(0)
    expect(listPublishes(db, { sinceDays: 10 })).toHaveLength(1)
    db.close()
  })
})

describe('videosPublishedToday', () => {
  it('is 0 for a channel with no rows', () => {
    const db = memDb()
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(0)
    db.close()
  })

  it('counts a fan-out of one video to two platforms as ONE video', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    claimPublish(db, {
      jobId: 'job-1',
      platform: 'instagram',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(1)
    db.close()
  })

  it('counts two distinct videos as two', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    claimPublish(db, { jobId: 'job-2', platform: 'youtube', channel: 'chan-a', day: '2026-07-22' })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(2)
    db.close()
  })

  it('counts a failed attempt — an attempt consumes its place in the day', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    const claim = claimPublish(db, {
      jobId: 'job-1',
      platform: 'youtube',
      channel: 'chan-a',
      day: '2026-07-22',
    })
    markPublishFailed(db, claim!.id, 'boom', 'transient', new Date())
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(1)
    db.close()
  })

  it('ignores other channels and other days', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-b' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-a', day: '2026-07-21' })
    claimPublish(db, { jobId: 'job-2', platform: 'youtube', channel: 'chan-b', day: '2026-07-22' })
    expect(videosPublishedToday(db, 'chan-a', '2026-07-22')).toBe(0)
    db.close()
  })
})

describe('lastAttemptAt', () => {
  it('is null for a channel with no rows', () => {
    const db = memDb()
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })

  it('returns the newest created_at across every day, not just today', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-a' })
    seedJob(db, 'job-2', { channel: 'chan-a' })
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('job-1','youtube','chan-a','2026-07-21',1,'done',1,'2026-07-21T20:50:00.000Z')",
    ).run()
    db.prepare(
      'INSERT INTO publishes (job_id, platform, channel, day, seq, status, attempt, created_at) ' +
        "VALUES ('job-2','youtube','chan-a','2026-07-22',1,'done',1,'2026-07-22T10:00:00.000Z')",
    ).run()
    expect(lastAttemptAt(db, 'chan-a')?.toISOString()).toBe('2026-07-22T10:00:00.000Z')
    db.close()
  })

  it('ignores other channels', () => {
    const db = memDb()
    seedJob(db, 'job-1', { channel: 'chan-b' })
    claimPublish(db, { jobId: 'job-1', platform: 'youtube', channel: 'chan-b', day: '2026-07-22' })
    expect(lastAttemptAt(db, 'chan-a')).toBeNull()
    db.close()
  })
})
