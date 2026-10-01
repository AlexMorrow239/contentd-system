import { writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testChannel } from '../../../../../testing/channel.js'
import { fileDb } from '../../../../../testing/db.js'
import { createTestTime, type TestTime } from '../../../../../testing/time.js'
import type { ChannelConfig } from '../../../../config/channel.js'
import { parseBudgetWait } from '../../../billing/budget-wait.js'
import { BudgetExceededError, assertBudget } from '../../../billing/costs.js'
import type { StageDef } from '../../contracts.js'
import { planTick } from '../../plan-tick.js'
import { createJob, runJob } from '../runner.js'
let time: TestTime
beforeEach(() => {
  time = createTestTime(new Date('2026-08-01T12:00:00Z'))
})

const start = new Date('2026-09-29T12:00:00.000Z')

describe('runner budget waits and planner eligibility', () => {
  it('does not call an unchanged blocked stage again; each configuration probe observes a new cooldown', async () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '25')

    time.setNow(start)
    const { db, root } = fileDb(undefined, time)
    const channel = testChannel({ budget: { perDayUsdMicros: 100 } })
    const jobId = createJob(db, channel, { time, topic: 'budget refusal' })
    let calls = 0
    const stages: StageDef[] = [
      {
        name: 'script',
        async run(ctx) {
          calls++
          assertBudget(db, ctx.channel, 150, time)
          writeFileSync(ctx.artifactPath('script', 'finished.txt'), 'paid call allowed')
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        },
      },
    ]
    const tick = async (config: ChannelConfig) => {
      const plan = planTick(db, [config], time)
      if (plan.kind === 'resume')
        return runJob(db, config, plan.jobId, stages, { time, runsRoot: root })
      return plan
    }
    expect(await runJob(db, channel, jobId, stages, { time, runsRoot: root })).toEqual({
      jobId,
      status: 'blocked',
    })
    const persisted = db
      .prepare('SELECT budget_wait_json,retry_after FROM jobs WHERE id=?')
      .get(jobId) as { budget_wait_json: string; retry_after: string }
    expect(persisted.retry_after).toBe('2026-09-29T12:01:00.000Z')
    expect(parseBudgetWait(persisted.budget_wait_json)).toMatchObject({
      stage: 'script',
      details: { scope: 'channel-day', upcomingUsdMicros: 150 },
    })
    const changed = { ...channel, scriptModel: 'another-model' }
    for (const seconds of [0, 30, 59]) {
      time.setNow(new Date(start.getTime() + seconds * 1000))
      expect(await tick(changed)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    }
    time.setNow(new Date('2026-09-29T12:01:00.000Z'))
    expect(await tick(channel)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    time.setNow(new Date('2026-09-29T14:00:00.000Z'))
    expect(await tick(channel)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    expect(calls).toBe(1)
    expect(await tick(changed)).toEqual({ jobId, status: 'blocked' })
    expect(calls).toBe(2)
    expect(db.prepare('SELECT retry_after FROM jobs WHERE id=?').get(jobId)).toEqual({
      retry_after: '2026-09-29T14:01:00.000Z',
    })
    const affordable = { ...changed, budget: { perDayUsdMicros: 150 } }
    expect(await tick(affordable)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    time.setNow(new Date('2026-09-29T14:01:00.000Z'))
    expect(await tick(changed)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    expect(await tick(affordable)).toMatchObject({ jobId, status: 'ready' })
    expect(calls).toBe(3)
    expect(
      db.prepare('SELECT status,budget_wait_json,retry_after FROM jobs WHERE id=?').get(jobId),
    ).toEqual({ status: 'done', budget_wait_json: null, retry_after: null })
  })

  it('parks a legacy refusal after its first probe and records a fresh wait when the UTC day changes', async () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', '25')

    time.setNow(start)
    const { db, root } = fileDb(undefined, time)
    const channel = testChannel()
    const jobId = createJob(db, channel, { time, topic: 'legacy budget refusal' })
    db.prepare("UPDATE jobs SET status='blocked' WHERE id=?").run(jobId)
    let calls = 0
    const stage: StageDef = {
      name: 'script',
      async run() {
        calls++
        throw new BudgetExceededError('unknown provider budget')
      },
    }
    expect(planTick(db, [channel], time)).toMatchObject({ kind: 'resume', jobId })
    expect(await runJob(db, channel, jobId, [stage], { time, runsRoot: root })).toMatchObject({
      status: 'blocked',
    })
    time.setNow(new Date('2026-09-29T23:59:59.000Z'))
    expect(planTick(db, [channel], time)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    expect(calls).toBe(1)
    time.setNow(new Date('2026-09-30T00:00:00.000Z'))
    expect(planTick(db, [channel], time)).toMatchObject({ kind: 'resume', jobId })
    await runJob(db, channel, jobId, [stage], { time, runsRoot: root })
    time.setNow(new Date('2026-09-30T00:02:00.000Z'))
    expect(planTick(db, [channel], time)).toEqual({ kind: 'noop', reason: 'no-eligible-work' })
    expect(calls).toBe(2)
  })

  it('records invalid global configuration as terminal failure even when a channel-day refusal occurs first', async () => {
    vi.stubEnv('CONTENTD_GLOBAL_DAILY_USD', 'invalid')
    const { db, root } = fileDb(undefined, time)
    const channel = testChannel({ budget: { perDayUsdMicros: 100 } })
    const jobId = createJob(db, channel, { time, topic: 'invalid budget config' })
    await expect(
      runJob(
        db,
        channel,
        jobId,
        [
          {
            name: 'script',
            async run() {
              assertBudget(db, channel, 150, time)
            },
          },
        ],
        { time, runsRoot: root },
      ),
    ).resolves.toMatchObject({ status: 'failed' })
    expect(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId)).toEqual({
      status: 'failed',
    })
  })
})
