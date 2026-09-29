import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../../db/index.js'
import { fileDb } from '../../../testing/db.js'
import { testChannel } from '../../../testing/channel.js'
import { trackDb } from '../../../testing/tmp.js'
import { LeaseLostError, requireLease } from '../../loop/lease.js'
import { planTick } from '../../loop/plan-tick.js'
import { beginAttempt, reconcileJobs } from '../execution.js'
import { createJob, runJob } from '../runner.js'

const start = new Date('2026-09-29T12:00:00.000Z')
afterEach(() => vi.useRealTimers())

describe('persisted crash recovery backoff', () => {
  it('doubles repeated interruption delays up to thirty minutes across database reopens', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const fixture = fileDb()
    let db = fixture.db
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'repeated interruption' })
    const attempts: string[] = []
    const expectedDelays = [
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
    ]
    for (const [index, delay] of expectedDelays.entries()) {
      const executionLease = requireLease(db, 'produce')
      attempts.push(beginAttempt(db, jobId, executionLease))
      db.prepare("UPDATE job_stages SET status='running' WHERE job_id=? AND stage='script'").run(
        jobId,
      )
      executionLease.release()
      db.close()
      db = trackDb(openDb(fixture.dbPath))
      const lease = requireLease(db, 'produce')
      const interruptedAt = new Date()
      try {
        expect(reconcileJobs(db, lease, interruptedAt)).toBe(1)
        const row = db
          .prepare(
            'SELECT recovery_count,recovery_pending,retry_after,previous_attempt_id FROM jobs WHERE id=?',
          )
          .get(jobId) as {
          recovery_count: number
          recovery_pending: number
          retry_after: string
          previous_attempt_id: string
        }
        expect(row).toEqual({
          recovery_count: index + 1,
          recovery_pending: 1,
          retry_after: new Date(interruptedAt.getTime() + delay).toISOString(),
          previous_attempt_id: attempts[index],
        })
        // Reconciliation itself cannot count another crash or move the deadline.
        expect(reconcileJobs(db, lease, interruptedAt)).toBe(0)
        expect(db.prepare('SELECT retry_after FROM jobs WHERE id=?').get(jobId)).toEqual({
          retry_after: row.retry_after,
        })
      } finally {
        lease.release()
      }
      vi.setSystemTime(new Date(interruptedAt.getTime() + delay - 1))
      expect(planTick(db, [channel])).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
      vi.setSystemTime(new Date(interruptedAt.getTime() + delay))
      expect(planTick(db, [channel])).toEqual({ kind: 'resume', jobId, channel: channel.name })
    }
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE status='interrupted'").get(),
    ).toEqual({ n: 8 })
    expect(new Set(attempts).size).toBe(8)
  })

  it('resets the delay only after a completed checkpoint, then starts the next interrupted stage at thirty seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const { db, root } = fileDb()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'progress resets backoff' })
    db.prepare(
      'UPDATE jobs SET recovery_count=5,recovery_pending=1,recovery_stage=?,previous_attempt_id=?,retry_after=? WHERE id=?',
    ).run('script', 'older-attempt', '2026-09-29T11:59:00.000Z', jobId)
    const lease = requireLease(db, 'produce')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        runJob(
          db,
          channel,
          jobId,
          [
            {
              name: 'script',
              async run(ctx) {
                expect(db.prepare('SELECT recovery_count FROM jobs WHERE id=?').get(jobId)).toEqual(
                  { recovery_count: 5 },
                )
                writeFileSync(ctx.artifactPath('script', 'completed.txt'), 'checkpoint')
              },
            },
            {
              name: 'voice',
              async run() {
                expect(
                  db
                    .prepare(
                      'SELECT recovery_count,recovery_stage,previous_attempt_id,retry_after FROM jobs WHERE id=?',
                    )
                    .get(jobId),
                ).toEqual({
                  recovery_count: 0,
                  recovery_stage: null,
                  previous_attempt_id: null,
                  retry_after: null,
                })
                lease.release()
                throw new Error('interrupted after script checkpoint')
              },
            },
          ],
          { runsRoot: root, lease },
        ),
      ).rejects.toBeInstanceOf(LeaseLostError)
      const successor = requireLease(db, 'produce')
      try {
        expect(reconcileJobs(db, successor, start)).toBe(1)
        expect(
          db
            .prepare('SELECT recovery_count,recovery_stage,retry_after FROM jobs WHERE id=?')
            .get(jobId),
        ).toEqual({
          recovery_count: 1,
          recovery_stage: 'voice',
          retry_after: '2026-09-29T12:00:30.000Z',
        })
        expect(
          db
            .prepare(
              "SELECT stage,status FROM job_stages WHERE job_id=? AND stage IN ('script','voice') ORDER BY stage",
            )
            .all(jobId),
        ).toEqual([
          { stage: 'script', status: 'done' },
          { stage: 'voice', status: 'pending' },
        ])
      } finally {
        successor.release()
      }
    } finally {
      warning.mockRestore()
      lease.release()
    }
  })
})
