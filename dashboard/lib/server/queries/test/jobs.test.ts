import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { countJobs, DASHBOARD_STAGE_ORDER, getJobDetail, jobChannels, listJobs } from '../jobs.js'
import { tmpDir } from '../../../../../src/testing/tmp.js'
import {
  memDb,
  seedCost,
  seedJob,
  seedLibrary,
  seedPost,
  seedStage,
} from '../../../../../src/testing/db.js'

function seed(): Database {
  const db = memDb()
  seedJob(db, 'j1', {
    channel: 'space',
    topic: 'Why Venus is hot',
    status: 'failed',
    createdAt: '2026-07-24T10:00:00.000Z',
  })
  seedJob(db, 'j2', {
    channel: 'ocean',
    tier: 'premium',
    topic: 'Deep sea',
    status: 'done',
    createdAt: '2026-07-25T10:00:00.000Z',
    finishedAt: '2026-07-25T10:04:00.000Z',
  })
  return db
}

describe('listJobs', () => {
  it('returns newest first', () => {
    const db = seed()
    expect(listJobs(db).map((j) => j.id)).toEqual(['j2', 'j1'])
    db.close()
  })

  it('filters by channel and by status', () => {
    const db = seed()
    expect(listJobs(db, { channel: 'space' }).map((j) => j.id)).toEqual(['j1'])
    expect(listJobs(db, { status: 'done' }).map((j) => j.id)).toEqual(['j2'])
    expect(listJobs(db, { channel: 'space', status: 'done' })).toEqual([])
    db.close()
  })

  it("sums each job's lifetime spend", () => {
    const db = seed()
    seedCost(db, 'j1', { provider: 'anthropic', operation: 'script', usdMicros: 12000 })
    seedCost(db, 'j1', { provider: 'elevenlabs', operation: 'tts', usdMicros: 30000 })
    const rows = listJobs(db)
    expect(rows.find((j) => j.id === 'j1')?.costUsdMicros).toBe(42000)
    // A job with no costs rows reports 0, not null.
    expect(rows.find((j) => j.id === 'j2')?.costUsdMicros).toBe(0)
    db.close()
  })

  it('honours the limit', () => {
    const db = seed()
    expect(listJobs(db, { limit: 1 }).map((j) => j.id)).toEqual(['j2'])
    db.close()
  })
})

describe('countJobs', () => {
  it('counts all matching rows regardless of any limit applied elsewhere', () => {
    const db = seed()
    expect(countJobs(db)).toBe(2)
    db.close()
  })

  it('applies the same channel and status filters as listJobs', () => {
    const db = seed()
    expect(countJobs(db, { channel: 'space' })).toBe(1)
    expect(countJobs(db, { status: 'done' })).toBe(1)
    expect(countJobs(db, { channel: 'space', status: 'done' })).toBe(0)
    db.close()
  })
})

describe('jobChannels', () => {
  it('lists distinct channels alphabetically for the filter dropdown', () => {
    const db = seed()
    expect(jobChannels(db)).toEqual(['ocean', 'space'])
    db.close()
  })
})

describe('getJobDetail', () => {
  it('returns null for an unknown job', () => {
    const db = seed()
    expect(getJobDetail(db, 'nope')).toBeNull()
    db.close()
  })

  it('puts the error on the failing stage and leaves later stages pending', () => {
    const db = seed()
    seedStage(db, 'j1', 'script', {
      status: 'done',
      startedAt: '2026-07-24T10:00:00.000Z',
      finishedAt: '2026-07-24T10:00:30.000Z',
    })
    seedStage(db, 'j1', 'voice', {
      status: 'failed',
      error: 'elevenlabs 401',
      startedAt: '2026-07-24T10:00:30.000Z',
    })

    const detail = getJobDetail(db, 'j1')
    expect(detail?.stages.map((s) => s.stage)).toEqual([...DASHBOARD_STAGE_ORDER])
    expect(detail?.stages[0]?.status).toBe('done')
    expect(detail?.stages[1]?.status).toBe('failed')
    expect(detail?.stages[1]?.error).toBe('elevenlabs 401')
    // Stages that never ran have no row at all; they must still render.
    expect(detail?.stages[2]?.status).toBe('pending')
    expect(detail?.stages[2]?.error).toBeNull()
    db.close()
  })

  it('returns the job costs newest first', () => {
    const db = seed()
    seedCost(db, 'j1', {
      provider: 'anthropic',
      operation: 'script',
      usdMicros: 12000,
      createdAt: '2026-07-24T10:00:10.000Z',
    })
    seedCost(db, 'j1', {
      provider: 'elevenlabs',
      operation: 'tts',
      usdMicros: 30000,
      createdAt: '2026-07-24T10:00:40.000Z',
    })
    const detail = getJobDetail(db, 'j1')
    expect(detail?.costs.map((c) => c.provider)).toEqual(['elevenlabs', 'anthropic'])
    db.close()
  })

  it('reports the library row when one exists', () => {
    const db = seed()
    seedLibrary(db, 'j2', { videoPath: 'runs/j2/assemble/final.mp4', state: 'ready' })
    const detail = getJobDetail(db, 'j2')
    expect(detail?.libraryState).toBe('ready')
    expect(detail?.videoPath).toBe('runs/j2/assemble/final.mp4')
    db.close()
  })

  it('reports null bytes and no links for a job that never finished', () => {
    const db = seed()
    const detail = getJobDetail(db, 'j1')
    expect(detail?.libraryState).toBeNull()
    expect(detail?.videoPath).toBeNull()
    expect(detail?.bytes).toBeNull()
    expect(detail?.links).toEqual([])
    db.close()
  })

  it('reports bytes local when the local file still exists on disk', () => {
    const db = seed()
    const dir = tmpDir('dashboard-video-')
    const file = path.join(dir, 'out.mp4')
    writeFileSync(file, 'not really a video')
    seedLibrary(db, 'j2', { videoPath: file, state: 'ready' })
    expect(getJobDetail(db, 'j2')?.bytes).toBe('local')
    db.close()
  })

  it('reports bytes missing when the local file is gone', () => {
    const db = seed()
    seedLibrary(db, 'j2', { videoPath: '/nonexistent/runs/j2/final.mp4', state: 'ready' })
    expect(getJobDetail(db, 'j2')?.bytes).toBe('missing')
    db.close()
  })

  it('lists post links for the job, one per platform', () => {
    const db = seed()
    seedLibrary(db, 'j2', { videoPath: '/nonexistent/runs/j2/final.mp4', state: 'ready' })
    seedPost(db, {
      jobId: 'j2',
      channel: 'ocean',
      platform: 'youtube',
      url: 'https://youtu.be/abc',
    })
    seedPost(db, { jobId: 'j2', channel: 'ocean', platform: 'instagram', url: null })
    expect(getJobDetail(db, 'j2')?.links).toEqual([
      { platform: 'youtube', url: 'https://youtu.be/abc' },
    ])
    db.close()
  })
})
