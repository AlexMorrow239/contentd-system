import { describe, expect, it } from 'vitest'
import { listPostLog } from '../posts.js'
import { memDb, seedJob, seedPost } from '../../../testing/db.js'

describe('listPostLog', () => {
  it('joins the topic off the owning job', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
    seedPost(db, {
      jobId: 'j1',
      channel: 'space',
      platform: 'youtube',
      url: 'https://youtube.com/shorts/j1',
    })
    const [entry] = listPostLog(db)
    expect(entry?.jobId).toBe('j1')
    expect(entry?.channel).toBe('space')
    expect(entry?.platform).toBe('youtube')
    expect(entry?.topic).toBe('Venus')
    expect(entry?.url).toBe('https://youtube.com/shorts/j1')
    db.close()
  })

  it('orders reverse-chronologically by posted_at', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
    seedJob(db, 'j2', { channel: 'space', topic: 'Mars' })
    seedPost(db, { jobId: 'j1', platform: 'youtube', postedAt: '2026-07-25T09:00:00.000Z' })
    seedPost(db, { jobId: 'j2', platform: 'youtube', postedAt: '2026-07-26T09:00:00.000Z' })
    const rows = listPostLog(db)
    expect(rows.map((r) => r.jobId)).toEqual(['j2', 'j1'])
    db.close()
  })

  it('carries a null url through untouched', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
    seedPost(db, { jobId: 'j1', platform: 'tiktok', url: null })
    const [entry] = listPostLog(db)
    expect(entry?.url).toBeNull()
    db.close()
  })

  it('respects the limit option', () => {
    const db = memDb()
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
    seedJob(db, 'j2', { channel: 'space', topic: 'Mars' })
    seedPost(db, { jobId: 'j1', platform: 'youtube', postedAt: '2026-07-25T09:00:00.000Z' })
    seedPost(db, { jobId: 'j2', platform: 'youtube', postedAt: '2026-07-26T09:00:00.000Z' })
    expect(listPostLog(db, { limit: 1 })).toHaveLength(1)
    db.close()
  })
})
