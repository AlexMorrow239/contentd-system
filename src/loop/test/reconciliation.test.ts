import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from 'better-sqlite3'
import {
  completeAction,
  failAction,
  getAction,
  reconcileActions,
  startAction,
} from '../../actions/queue.js'
import { linkActionJob } from '../../jobs/execution.js'
import { memDb, seedAction, seedJob, seedLibrary } from '../../testing/db.js'
import { testRoot } from '../../testing/tmp.js'
import { runDaemon } from '../daemon.js'
import { LeaseLostError, requireLease } from '../lease.js'

const now = new Date('2026-08-01T12:00:00Z')

function interruptedAction(
  db: Database,
  opts: {
    kind?: string
    jobId?: string
    ownerToken?: string | null
    notice?: string
    args?: string
  } = {},
): number {
  const id = seedAction(db, {
    kind: opts.kind ?? 'jobs.produce',
    lane: 'slow',
    status: 'running',
    startedAt: now.toISOString(),
    notice: opts.notice ?? null,
    args: opts.args ?? '{}',
  })
  db.prepare('UPDATE operator_actions SET owner_token = ?, job_id = ? WHERE id = ?').run(
    opts.ownerToken === undefined ? 'dead-daemon-token' : opts.ownerToken,
    opts.jobId ?? null,
    id,
  )
  return id
}

afterEach(() => vi.useRealTimers())

describe('daemon ownership and reconciliation', () => {
  it('refuses a second daemon before mutating any action or emitting startup', async () => {
    const db = memDb()
    const paths = testRoot()
    const first = requireLease(db, 'daemon')
    try {
      const id = interruptedAction(db)
      const before = getAction(db, id)
      const emit = vi.fn()
      await expect(runDaemon(db, { ...paths, emit, signal: AbortSignal.abort() })).rejects.toThrow(
        /daemon lease is held/,
      )
      expect(getAction(db, id)).toEqual(before)
      expect(emit).not.toHaveBeenCalled()
      first.assertOwned()
    } finally {
      first.release()
    }
  })

  it('preserves a running action owned by the live daemon', () => {
    const db = memDb()
    const owner = requireLease(db, 'daemon')
    try {
      const id = interruptedAction(db, { ownerToken: owner.token })
      const before = getAction(db, id)
      expect(reconcileActions(db, owner, now)).toBe(0)
      expect(getAction(db, id)).toEqual(before)
    } finally {
      owner.release()
    }
  })

  it('fences stale and unowned completions after the successor reclaims an action', () => {
    const db = memDb()
    const first = requireLease(db, 'daemon')
    const id = seedAction(db, { kind: 'jobs.produce', lane: 'slow' })
    startAction(db, id, now, first)
    db.prepare("UPDATE leases SET expires_at = '2020-01-01T00:00:00Z' WHERE name = 'daemon'").run()
    const successor = requireLease(db, 'daemon')
    try {
      expect(reconcileActions(db, successor, now)).toBe(1)
      expect(startAction(db, id, now, successor)).toBe(true)
      const before = getAction(db, id)
      expect(() => completeAction(db, id, { wrong: true }, now, first)).toThrow(LeaseLostError)
      expect(() => failAction(db, id, new Error('late failure'), now, first)).toThrow(
        LeaseLostError,
      )
      completeAction(db, id, { wrong: true }, now)
      failAction(db, id, new Error('unowned failure'), now)
      expect(getAction(db, id)).toEqual(before)
      completeAction(db, id, { correct: true }, now, successor)
      expect(JSON.parse(getAction(db, id)!.result!)).toEqual({ correct: true })
    } finally {
      first.release()
      successor.release()
    }
  })

  it('retains linked interrupted jobs while requeueing known prelink render actions', () => {
    const db = memDb()
    const jobId = seedJob(db, 'interrupted-job', { status: 'running' })
    const linked = interruptedAction(db, { jobId })
    const prelink = interruptedAction(db)
    const owner = requireLease(db, 'daemon')
    try {
      expect(reconcileActions(db, owner, now)).toBe(2)
      expect(getAction(db, linked)).toMatchObject({ status: 'failed', jobId })
      expect(getAction(db, linked)?.notice).toContain(jobId)
      expect(getAction(db, prelink)).toMatchObject({
        status: 'pending',
        jobId: null,
        ownerToken: null,
        startedAt: null,
      })
      expect(db.prepare('SELECT id, status FROM jobs').all()).toEqual([
        { id: jobId, status: 'running' },
      ])
      expect(reconcileActions(db, owner, now)).toBe(0)
    } finally {
      owner.release()
    }
  })

  it('links a legacy produce notice instead of replaying an already-created job', () => {
    const db = memDb()
    const jobId = seedJob(db, 'legacy-job', { status: 'running' })
    const id = interruptedAction(db, { ownerToken: null, notice: `job ${jobId}` })
    const owner = requireLease(db, 'daemon')
    try {
      reconcileActions(db, owner, now)
      expect(getAction(db, id)).toMatchObject({ status: 'failed', jobId })
      expect(getAction(db, id)?.notice).toContain(jobId)
      expect(db.prepare('SELECT id FROM jobs').all()).toEqual([{ id: jobId }])
    } finally {
      owner.release()
    }
  })

  it('links a legacy resume action from its jobId argument', () => {
    const db = memDb()
    const jobId = seedJob(db, 'legacy-resume-job', { status: 'running' })
    const id = interruptedAction(db, {
      kind: 'jobs.resume',
      ownerToken: null,
      args: JSON.stringify({ jobId }),
    })
    const owner = requireLease(db, 'daemon')
    try {
      reconcileActions(db, owner, now)
      expect(getAction(db, id)).toMatchObject({ status: 'failed', jobId })
    } finally {
      owner.release()
    }
  })

  it('fails an unlinked legacy render with unknown outcome instead of risking duplicate work', () => {
    const db = memDb()
    const id = interruptedAction(db, { ownerToken: null })
    const owner = requireLease(db, 'daemon')
    try {
      reconcileActions(db, owner, now)
      expect(getAction(db, id)).toMatchObject({ status: 'failed', jobId: null })
      expect(getAction(db, id)?.error).toMatch(/unknown|interrupted/i)
    } finally {
      owner.release()
    }
  })

  it('reconstructs completed linked results from the durable library row', () => {
    const db = memDb()
    const jobId = seedJob(db, 'completed-job', { status: 'done' })
    seedLibrary(db, jobId, {
      state: 'needs-review',
      videoPath: '/runs/completed-job/attempts/a/assemble/final.mp4',
    })
    const id = interruptedAction(db, { jobId, notice: 'render in progress' })
    const owner = requireLease(db, 'daemon')
    try {
      reconcileActions(db, owner, now)
      expect(getAction(db, id)).toMatchObject({
        status: 'done',
        jobId,
        notice: null,
        finishedAt: now.toISOString(),
      })
      expect(JSON.parse(getAction(db, id)!.result!)).toEqual({
        jobId,
        status: 'needs-review',
        videoPath: '/runs/completed-job/attempts/a/assemble/final.mp4',
      })
    } finally {
      owner.release()
    }
  })

  it('rejects linking work to an action after daemon ownership is lost', () => {
    const db = memDb()
    const owner = requireLease(db, 'daemon')
    const id = seedAction(db)
    startAction(db, id, now, owner)
    const jobId = seedJob(db, 'job')
    owner.release()
    expect(() => linkActionJob(db, id, jobId, owner)).toThrow(LeaseLostError)
    expect(getAction(db, id)?.jobId).toBeNull()
  })
})
