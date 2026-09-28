import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { memDb, seedJob, seedLibrary, seedPost } from '../../testing/db.js'
import { fullyPostedClause, markPosted, postedPlatforms, unmarkPosted } from '../posts.js'

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

  it('resolves the channel from the job when the caller omits it', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    markPosted(db, { jobId: 'j1', platform: 'youtube' })
    const row = db.prepare('SELECT channel FROM posts WHERE job_id = ?').get('j1') as {
      channel: string
    }
    expect(row.channel).toBe('alpha')
  })

  it('refuses an unknown job rather than filing the row under nothing', () => {
    const db = memDb()
    expect(() => markPosted(db, { jobId: 'nope', platform: 'youtube' })).toThrow(/no such job/)
  })
})

describe('fullyPostedClause', () => {
  // The four readers of this predicate compose it into their own FROM, so the
  // alias travels with it rather than being assumed.
  it('binds the declared platforms and their count, against the given alias', () => {
    const clause = fullyPostedClause(['youtube', 'tiktok'], { alias: 'l', match: 'not-fully' })
    expect(clause.sql).toContain('p.job_id = l.job_id')
    expect(clause.sql).toContain('p.platform IN (?, ?)')
    expect(clause.sql.endsWith(') < ?')).toBe(true)
    expect(clause.params).toEqual(['youtube', 'tiktok', 2])
  })

  it('uses >= for the fully-posted direction', () => {
    const clause = fullyPostedClause(['youtube'], { alias: 'l', match: 'fully' })
    expect(clause.sql.endsWith(') >= ?')).toBe(true)
    expect(clause.params).toEqual(['youtube', 1])
  })

  // An undecided channel: everything still counts as inventory and nothing is
  // fully posted. The two directions are deliberately not each other's negation.
  it('resolves an empty platform list per direction, with no bindings', () => {
    expect(fullyPostedClause([], { alias: 'l', match: 'not-fully' })).toEqual({
      sql: '1',
      params: [],
    })
    expect(fullyPostedClause([], { alias: 'l', match: 'fully' })).toEqual({ sql: '0', params: [] })
  })

  it('runs as real SQL against the library shape its callers select from', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'alpha' })
    seedJob(db, 'j2', { channel: 'alpha' })
    seedLibrary(db, 'j1')
    seedLibrary(db, 'j2')
    markPosted(db, { jobId: 'j1', platform: 'youtube' })
    const unposted = fullyPostedClause(['youtube'], { alias: 'l', match: 'not-fully' })
    const rows = db
      .prepare(`SELECT l.job_id AS jobId FROM library l WHERE ${unposted.sql}`)
      .all(...unposted.params) as { jobId: string }[]
    expect(rows.map((r) => r.jobId)).toEqual(['j2'])
  })
})
