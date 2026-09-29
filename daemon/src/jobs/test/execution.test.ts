import { beforeEach } from 'vitest'
import { createTestTime, type TestTime } from '../../../testing/time.js'
let time: TestTime
beforeEach(() => {
  time = createTestTime(new Date('2026-08-01T12:00:00Z'))
})
import { describe, expect, it } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileDb, memDb, seedJob, seedStage } from '../../../testing/db.js'
import { testChannel } from '../../../testing/channel.js'
import { requireLease } from '../../loop/lease.js'
import { reconcileJobs } from '../execution.js'
import { createJob, runJob } from '../runner.js'

describe('execution recovery', () => {
  it('reconciles legacy queued/running jobs exactly once and preserves checkpoints', () => {
    const db = memDb(time)
    seedJob(db, 'orphan', { status: 'running' })
    seedStage(db, 'orphan', 'script', { status: 'done' })
    seedStage(db, 'orphan', 'voice', { status: 'running' })
    const lease = requireLease(db, 'produce', undefined, { time })
    expect(reconcileJobs(db, lease)).toBe(1)
    expect(reconcileJobs(db, lease)).toBe(0)
    expect(
      db
        .prepare(
          'SELECT status, recovery_count, recovery_pending, recovery_stage, retry_after FROM jobs',
        )
        .get(),
    ).toEqual({
      status: 'queued',
      recovery_count: 1,
      recovery_pending: 1,
      recovery_stage: 'voice',
      retry_after: new Date(time.now().getTime() + 30_000).toISOString(),
    })
    expect(db.prepare("SELECT status FROM job_stages WHERE stage='script'").get()).toEqual({
      status: 'done',
    })
    lease.release()
  })
  it('fences late stage completion and keeps replacement artifacts separate', async () => {
    const { db, root } = fileDb(undefined, time)
    const channel = testChannel()
    const jobId = createJob(db, channel, { time, topic: 'isolation' })
    const lease = requireLease(db, 'produce', undefined, { time })
    let finish!: () => void
    let oldPath = ''
    const first = runJob(
      db,
      channel,
      jobId,
      [
        {
          name: 'script',
          run: async (ctx) => {
            oldPath = ctx.artifactPath('script', 'value.txt')
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            writeFileSync(oldPath, 'stale')
          },
        },
      ],
      { time, runsRoot: join(root, 'runs'), lease },
    )
    const observed = first.catch((e) => e)
    time.setNow(time.now().getTime() + 300_000)
    const replacement = requireLease(db, 'produce', undefined, { time })
    reconcileJobs(db, replacement)
    let newPath = ''
    await runJob(
      db,
      channel,
      jobId,
      [
        {
          name: 'script',
          run: async (ctx) => {
            newPath = ctx.artifactPath('script', 'value.txt')
            writeFileSync(newPath, 'current')
          },
        },
      ],
      { time, runsRoot: join(root, 'runs'), lease: replacement },
    )
    finish()
    expect((await observed).name).toBe('LeaseLostError')
    expect(newPath).not.toBe(oldPath)
    expect(readFileSync(newPath, 'utf8')).toBe('current')
    expect(
      db
        .prepare("SELECT artifact_dir FROM job_stages WHERE job_id=? AND stage='script'")
        .get(jobId),
    ).toEqual({ artifact_dir: newPath.slice(0, -'/value.txt'.length) })
    lease.release()
    replacement.assertOwned()
    replacement.release()
  })
})
