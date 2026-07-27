import { describe, expect, it } from 'vitest'
import { memDb, seedJob, seedLibrary, seedPublish } from '../testing/db.js'
import { recordTransactionModes } from './_publishes.fixtures.js'
import { markInterruptedDone, retryInterrupted, sweepInterrupted } from './publishes.js'

/**
 * The interrupted-row repair path: sweepInterrupted, retryInterrupted,
 * markInterruptedDone.
 *
 * Split from a single 1134-line publishes.test.ts that held one describe per
 * exported DAO function with its fixtures scattered between them; the shared
 * ones now live in _publishes.fixtures.ts and src/testing/db.ts.
 */

describe('sweepInterrupted', () => {
  it('flips only claimed rows older than the cutoff, and is idempotent on rerun', () => {
    const db = memDb()
    seedJob(db, 'job-old')
    seedJob(db, 'job-fresh')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const oldId = seedPublish(db, 'job-old', {
      status: 'claimed',
      createdAt: '2026-07-20T11:00:00.000Z',
    })
    const freshId = seedPublish(db, 'job-fresh', {
      seq: 2,
      status: 'claimed',
      createdAt: '2026-07-20T11:55:00.000Z',
    })

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(1)
    const rows = db.prepare('SELECT id, status FROM publishes ORDER BY id').all() as {
      id: number
      status: string
    }[]
    expect(rows).toEqual([
      { id: oldId, status: 'interrupted' },
      { id: freshId, status: 'claimed' },
    ])

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(0)
    db.close()
  })

  // The cutoff is inclusive (publishes.ts): a row created at exactly
  // now - olderThanMs is stale, one millisecond later is not.
  it('sweeps a row created exactly at the cutoff, not one a millisecond after it', () => {
    const db = memDb()
    seedJob(db, 'job-at-cutoff')
    seedJob(db, 'job-past-cutoff')
    const now = new Date('2026-07-20T12:00:00.000Z')
    const atCutoffId = seedPublish(db, 'job-at-cutoff', {
      status: 'claimed',
      createdAt: '2026-07-20T11:30:00.000Z',
    })
    const pastCutoffId = seedPublish(db, 'job-past-cutoff', {
      seq: 2,
      status: 'claimed',
      createdAt: '2026-07-20T11:30:00.001Z',
    })

    expect(sweepInterrupted(db, 30 * 60_000, now)).toBe(1)
    expect(db.prepare('SELECT id, status FROM publishes ORDER BY id').all()).toEqual([
      { id: atCutoffId, status: 'interrupted' },
      { id: pastCutoffId, status: 'claimed' },
    ])
    db.close()
  })
})

describe('retryInterrupted', () => {
  it('flips an interrupted row to failed, kind transient, with an appended clearance note', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    const id = seedPublish(db, 'job-1', { status: 'interrupted' })

    expect(retryInterrupted(db, 'job-1')).toBe(true)
    expect(
      db.prepare('SELECT status, error, error_kind FROM publishes WHERE id = ?').get(id),
    ).toEqual({
      status: 'failed',
      error: '; manually cleared',
      error_kind: 'transient',
    })
    db.close()
  })

  it('returns false and touches nothing when the job has no interrupted row', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedPublish(db, 'job-1', { status: 'done' })

    expect(retryInterrupted(db, 'job-1')).toBe(false)
    expect(retryInterrupted(db, 'job-unknown')).toBe(false)
    expect(
      (
        db.prepare('SELECT status FROM publishes WHERE job_id = ?').get('job-1') as {
          status: string
        }
      ).status,
    ).toBe('done')
    db.close()
  })
})

describe('markInterruptedDone', () => {
  it('flips the interrupted publish row to done and the library row to published together', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    const id = seedPublish(db, 'job-1', { status: 'interrupted' })

    const ok = markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date('2026-07-20T10:10:00.000Z'),
    )

    expect(ok).toBe(true)
    expect(
      db.prepare('SELECT status, post_id, url, finished_at FROM publishes WHERE id = ?').get(id),
    ).toEqual({
      status: 'done',
      post_id: 'yt-xyz789',
      url: 'https://youtube.com/shorts/yt-xyz789',
      finished_at: '2026-07-20T10:10:00.000Z',
    })
    expect(
      (
        db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }
      ).state,
    ).toBe('published')
    db.close()
  })

  it('runs the two-table flip in one immediate transaction', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })
    seedPublish(db, 'job-1', { status: 'interrupted' })
    const modes = recordTransactionModes(db)

    markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date(),
    )

    expect(modes).toEqual(['immediate'])
    db.close()
  })

  it('returns false and touches neither table when the job has no interrupted row', () => {
    const db = memDb()
    seedJob(db, 'job-1')
    seedLibrary(db, 'job-1', { state: 'ready' })

    const ok = markInterruptedDone(
      db,
      'job-1',
      'yt-xyz789',
      'https://youtube.com/shorts/yt-xyz789',
      new Date('2026-07-20T10:10:00.000Z'),
    )

    expect(ok).toBe(false)
    expect(
      (
        db.prepare('SELECT state FROM library WHERE job_id = ?').get('job-1') as {
          state: string
        }
      ).state,
    ).toBe('ready')
    db.close()
  })
})
