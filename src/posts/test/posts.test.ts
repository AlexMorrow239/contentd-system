import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { memDb, seedJob, seedPost } from '../../testing/db.js'
import { markPosted, postedPlatforms, unmarkPosted } from '../posts.js'

// Raw read against the `posts` table, standing in for the deleted
// postsForJob DAO helper: nothing in production reads a single job's posts
// row-by-row any more (postedPlatforms's grouped read is what every real
// caller wants), but these tests still want to assert on the written rows
// directly.
function rowsForJob(db: Database, jobId: string): { url: string | null; postedAt: string }[] {
  return db
    .prepare('SELECT url, posted_at AS postedAt FROM posts WHERE job_id = ? ORDER BY platform ASC')
    .all(jobId) as { url: string | null; postedAt: string }[]
}

describe('posts', () => {
  it('records a post and reads it back', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube', url: 'https://y/1' })
    const rows = rowsForJob(db, 'j1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.url).toBe('https://y/1')
    expect(rows[0]?.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('accepts a post with no url', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'tiktok' })
    expect(rowsForJob(db, 'j1')[0]?.url).toBeNull()
  })

  // The composite primary key IS the idempotence guarantee: a double-clicked
  // button must not produce two rows.
  it('is idempotent on (job, platform), keeping the newer url', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube', url: 'https://y/1' })
    const rows = rowsForJob(db, 'j1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.url).toBe('https://y/1')
  })

  it('unmarks, and reports whether anything was there', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube' })
    expect(unmarkPosted(db, 'j1', 'youtube')).toBe(true)
    expect(unmarkPosted(db, 'j1', 'youtube')).toBe(false)
    expect(rowsForJob(db, 'j1')).toEqual([])
  })

  it('groups posted platforms and their urls by job in one read', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedJob(db, 'j2', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube', url: 'https://y/1' })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'tiktok' })
    markPosted(db, { jobId: 'j2', channel: 'alpha', platform: 'youtube' })
    const byJob = postedPlatforms(db, ['j1', 'j2', 'j3'])
    expect(byJob.get('j1')).toEqual(
      new Map([
        ['youtube', 'https://y/1'],
        ['tiktok', null],
      ]),
    )
    expect(byJob.get('j2')).toEqual(new Map([['youtube', null]]))
    // Absent, not present-and-empty: "never posted" and "posted to nothing"
    // are the same state, and the absence is what callers branch on.
    expect(byJob.has('j3')).toBe(false)
  })

  it('returns an empty map for no job ids rather than building an empty IN ()', () => {
    expect(postedPlatforms(memDb(), []).size).toBe(0)
  })

  // posted_at records when the video went out. A second click correcting a
  // typo'd url must not restamp it.
  it('does not restamp posted_at on a correcting write', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedPost(db, {
      jobId: 'j1',
      channel: 'alpha',
      platform: 'youtube',
      url: 'https://y/typo',
      postedAt: '2020-01-01T00:00:00.000Z',
    })
    markPosted(db, { jobId: 'j1', channel: 'alpha', platform: 'youtube', url: 'https://y/1' })
    const row = rowsForJob(db, 'j1')[0]
    expect(row?.url).toBe('https://y/1')
    expect(row?.postedAt).toBe('2020-01-01T00:00:00.000Z')
  })
})
