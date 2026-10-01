import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { STAGE_ORDER } from '../../../../../daemon/src/shared/contracts/pipeline.js'
import { countJobs, getJobDetail, jobChannels, listJobs } from '../jobs.js'
import { tmpDir } from '../../../../../daemon/testing/tmp.js'
import { testChannel } from '../../../../../daemon/testing/channel.js'
import {
  memDb,
  seedAction,
  seedCost,
  seedJob,
  seedLibrary,
  seedPost,
  seedStage,
} from '../../../../../daemon/testing/db.js'

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
  it('combines content filters before pagination and keeps counts in agreement', () => {
    const db = seed()
    const channels = [testChannel({ name: 'ocean', platforms: ['youtube', 'tiktok'] })]
    seedLibrary(db, 'j2', { state: 'needs-review', qcJson: '{broken' })
    seedPost(db, { jobId: 'j2', platform: 'youtube', url: null })
    const filter = {
      channel: 'ocean',
      status: 'done' as const,
      review: 'needs-review' as const,
      posting: 'partial' as const,
      q: 'SEA',
      limit: 1,
      offset: 0,
    }
    expect(listJobs(db, filter, channels).map((j) => j.id)).toEqual(['j2'])
    expect(countJobs(db, filter, channels)).toBe(1)
    expect(listJobs(db, { ...filter, offset: 1 }, channels)).toEqual([])
    expect(listJobs(db, { ...filter, q: 'J1' }, channels)).toEqual([])
    const [job] = listJobs(db, filter, channels)
    expect(job?.video).toMatchObject({ state: 'needs-review', qc: { kind: 'unparseable' } })
    expect(job?.posting).toEqual({ kind: 'partial', posted: 1, total: 2 })
  })

  it('distinguishes review state from production status and searches literal substrings', () => {
    const db = seed()
    seedLibrary(db, 'j2', { state: 'blocked' })
    expect(listJobs(db, { review: 'none' }).map((j) => j.id)).toEqual(['j1'])
    expect(listJobs(db, { review: 'blocked' }).map((j) => j.id)).toEqual(['j2'])
    expect(listJobs(db, { status: 'blocked' })).toEqual([])
    expect(listJobs(db, { q: 'J2' }).map((j) => j.id)).toEqual(['j2'])
    expect(listJobs(db, { q: '%' })).toEqual([])
    expect(countJobs(db, { review: 'ready' })).toBe(0)
  })

  it('uses declared platforms for progress and preserves historical posts without links', () => {
    const db = seed()
    seedLibrary(db, 'j2')
    seedPost(db, { jobId: 'j2', platform: 'instagram', url: null })
    const channels = [testChannel({ name: 'ocean', platforms: ['youtube'] })]
    expect(listJobs(db, { posting: 'unposted' }, channels).map((j) => j.id)).toEqual(['j2'])
    expect(listJobs(db, { posting: 'has-posts' }, channels).map((j) => j.id)).toEqual(['j2'])
    expect(countJobs(db, { posting: 'full' }, channels)).toBe(0)
    seedPost(db, { jobId: 'j2', platform: 'youtube', url: null })
    expect(listJobs(db, { posting: 'full' }, channels).map((j) => j.id)).toEqual(['j2'])
    expect(getJobDetail(db, 'j2', channels)?.posts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'instagram', url: null }),
        expect.objectContaining({ platform: 'youtube', url: null }),
      ]),
    )
    expect(listJobs(db, { posting: 'full' }, [])).toEqual([])
    expect(
      listJobs(db, { posting: 'full' }, [testChannel({ name: 'ocean', platforms: [] })]),
    ).toEqual([])
    expect(listJobs(db).find((j) => j.id === 'j2')?.posting?.kind).toBe('unconfigured')
  })

  it('finds active scalar, list, and linked actions without losing older pending work', () => {
    const db = seed()
    const id = seedAction(db, { kind: 'library.approve', args: '{"jobIds":["j1","j2"]}' })
    seedAction(db, { kind: 'jobs.delete', args: '{"jobId":"j2"}', status: 'failed' })
    seedAction(db, { kind: 'jobs.resume', args: '{broken' })
    expect(listJobs(db).map((j) => j.action?.id)).toEqual([id, id])
    db.prepare("UPDATE operator_actions SET status='done' WHERE id=?").run(id)
    expect(getJobDetail(db, 'j2')?.job.action).toMatchObject({
      kind: 'jobs.delete',
      status: 'failed',
    })
    const linked = seedAction(db, { kind: 'jobs.produce', args: '{}' })
    db.prepare('UPDATE operator_actions SET job_id=? WHERE id=?').run('j1', linked)
    expect(getJobDetail(db, 'j1')?.job.action?.id).toBe(linked)
  })

  it('excludes retired jobs even when they still have content', () => {
    const db = seed()
    seedLibrary(db, 'j2')
    db.prepare('UPDATE jobs SET deleted_at=? WHERE id=?').run('2026-09-30', 'j2')
    expect(listJobs(db, { review: 'ready' })).toEqual([])
    expect(countJobs(db, { review: 'ready' })).toBe(0)
    expect(getJobDetail(db, 'j2')).toBeNull()
  })
  it.each(['pending', 'running'])(
    'shows an active %s resume as queued across job views',
    (status) => {
      const db = seed()
      seedAction(db, {
        kind: 'jobs.resume',
        lane: 'slow',
        args: JSON.stringify({ jobId: 'j1' }),
        status,
      })
      expect(getJobDetail(db, 'j1')?.job.status).toBe('queued')
      expect(listJobs(db, { status: 'queued' }).map((job) => job.id)).toEqual(['j1'])
      expect(countJobs(db, { status: 'queued' })).toBe(1)
      expect(countJobs(db, { status: 'failed' })).toBe(0)
      db.prepare("UPDATE jobs SET status = 'running' WHERE id = 'j1'").run()
      expect(getJobDetail(db, 'j1')?.job.status).toBe('running')
    },
  )

  it.each(['done', 'failed'])('allows retry after a resume action is %s', (status) => {
    const db = seed()
    seedAction(db, {
      kind: 'jobs.resume',
      lane: 'slow',
      args: JSON.stringify({ jobId: 'j1' }),
      status,
    })
    expect(getJobDetail(db, 'j1')?.job.status).toBe('failed')
  })

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
  it('exposes persisted budget waits and retry deadlines without changing state', () => {
    const db = seed()
    const wait = {
      version: 1,
      stage: 'voice',
      reason: 'per-video budget exceeded',
      utcDay: '2026-09-29',
      configFingerprint: 'abc',
      details: {
        scope: 'per-video',
        upcomingUsdMicros: 2_000_000,
        spentUsdMicros: 7_000_000,
        capUsdMicros: 8_000_000,
        utcDay: '2026-09-29',
      },
    }
    db.prepare('UPDATE jobs SET budget_wait_json = ?, retry_after = ? WHERE id = ?').run(
      JSON.stringify(wait),
      '2026-09-29T12:01:00.000Z',
      'j1',
    )
    db.pragma('query_only = ON')
    expect(getJobDetail(db, 'j1')).toMatchObject({
      budgetWait: wait,
      retryAfter: '2026-09-29T12:01:00.000Z',
    })
  })

  it('tolerates old or malformed budget metadata', () => {
    const db = seed()
    expect(getJobDetail(db, 'j1')?.budgetWait).toBeNull()
    expect(getJobDetail(db, 'j1')?.retryAfter).toBeNull()
    db.prepare('UPDATE jobs SET budget_wait_json = ? WHERE id = ?').run('{broken', 'j1')
    expect(getJobDetail(db, 'j1')?.budgetWait).toBeNull()
  })

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
    expect(detail?.stages.map((s) => s.stage)).toEqual([...STAGE_ORDER])
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
    const video = getJobDetail(db, 'j2')?.job.video
    expect(video?.state).toBe('ready')
    expect(video?.createdAt).toBeTruthy()
    expect(video?.qc).toEqual({ kind: 'absent' })
    db.close()
  })

  it('reports no video and no posts for a job that never finished', () => {
    const db = seed()
    const detail = getJobDetail(db, 'j1')
    expect(detail?.job.video).toBeNull()
    expect(detail?.posts).toEqual([])
    db.close()
  })

  it('reports bytes local when the local file still exists on disk', () => {
    const db = seed()
    const dir = tmpDir('dashboard-video-')
    const file = path.join(dir, 'out.mp4')
    writeFileSync(file, 'not really a video')
    seedLibrary(db, 'j2', { videoPath: file, state: 'ready' })
    expect(getJobDetail(db, 'j2')?.job.video?.bytes).toBe('local')
    db.close()
  })

  it('reports bytes missing when the local file is gone', () => {
    const db = seed()
    seedLibrary(db, 'j2', { videoPath: '/nonexistent/runs/j2/final.mp4', state: 'ready' })
    expect(getJobDetail(db, 'j2')?.job.video?.bytes).toBe('missing')
    db.close()
  })

  it('lists post records for the job, one per platform', () => {
    const db = seed()
    seedLibrary(db, 'j2', { videoPath: '/nonexistent/runs/j2/final.mp4', state: 'ready' })
    seedPost(db, {
      jobId: 'j2',
      channel: 'ocean',
      platform: 'youtube',
      url: 'https://youtu.be/abc',
    })
    seedPost(db, { jobId: 'j2', channel: 'ocean', platform: 'instagram', url: null })
    expect(
      getJobDetail(db, 'j2')
        ?.posts.map(({ platform, url }) => ({ platform, url }))
        .sort((a, b) => a.platform.localeCompare(b.platform)),
    ).toEqual([
      { platform: 'instagram', url: null },
      { platform: 'youtube', url: 'https://youtu.be/abc' },
    ])
    db.close()
  })
})
