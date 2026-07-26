import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import { pipelineStages } from '../../jobs/pipeline.js'
import { countJobs, DASHBOARD_STAGE_ORDER, getJobDetail, jobChannels, listJobs } from './jobs.js'

function seed(): Database {
  const db = openDb(':memory:')
  db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status, created_at, finished_at) ' +
      "VALUES ('j1','space','volume','Why Venus is hot','failed','2026-07-24T10:00:00.000Z',NULL)",
  ).run()
  db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status, created_at, finished_at) ' +
      "VALUES ('j2','ocean','premium','Deep sea','done','2026-07-25T10:00:00.000Z','2026-07-25T10:04:00.000Z')",
  ).run()
  return db
}

describe('DASHBOARD_STAGE_ORDER', () => {
  it('matches the real pipeline order', () => {
    // The dashboard hardcodes the order rather than importing pipelineStages()
    // at runtime — that module pulls in remotion, kokoro and ffmpeg wrappers,
    // which a viewer has no business loading. This test is the anti-drift
    // guard: it pays the heavy import once, in test only.
    expect([...DASHBOARD_STAGE_ORDER]).toEqual(pipelineStages().map((s) => s.name))
  })
})

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
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j1','anthropic','script',12000)",
    ).run()
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES ('j1','elevenlabs','tts',30000)",
    ).run()
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
    db.prepare(
      'INSERT INTO job_stages (job_id, stage, status, started_at, finished_at) ' +
        "VALUES ('j1','script','done','2026-07-24T10:00:00.000Z','2026-07-24T10:00:30.000Z')",
    ).run()
    db.prepare(
      'INSERT INTO job_stages (job_id, stage, status, error, started_at) ' +
        "VALUES ('j1','voice','failed','elevenlabs 401','2026-07-24T10:00:30.000Z')",
    ).run()

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
    db.prepare(
      'INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) ' +
        "VALUES ('j1','anthropic','script',12000,'2026-07-24T10:00:10.000Z')",
    ).run()
    db.prepare(
      'INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) ' +
        "VALUES ('j1','elevenlabs','tts',30000,'2026-07-24T10:00:40.000Z')",
    ).run()
    const detail = getJobDetail(db, 'j1')
    expect(detail?.costs.map((c) => c.provider)).toEqual(['elevenlabs', 'anthropic'])
    db.close()
  })

  it('reports the library row when one exists', () => {
    const db = seed()
    db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) ' +
        "VALUES ('j2','runs/j2/assemble/final.mp4','{}','ready')",
    ).run()
    const detail = getJobDetail(db, 'j2')
    expect(detail?.libraryState).toBe('ready')
    expect(detail?.videoPath).toBe('runs/j2/assemble/final.mp4')
    db.close()
  })

  it('reports null library fields for a job that never finished', () => {
    const db = seed()
    const detail = getJobDetail(db, 'j1')
    expect(detail?.libraryState).toBeNull()
    expect(detail?.videoPath).toBeNull()
    db.close()
  })
})
