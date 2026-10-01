import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { channelToml, testChannel, writeChannelsDir } from '../../../../testing/channel.js'
import { memDb, seedTopic } from '../../../../testing/db.js'
import { createTestTime } from '../../../../testing/time.js'
import { tmpDir } from '../../../../testing/tmp.js'
import { runDaemon } from '../../../app/daemon.js'
import { enqueueAction, getAction } from '../../../features/actions/queue.js'
import { assertBudget, recordCost } from '../../../features/billing/costs.js'
import { markPosted } from '../../../features/posting/posts.js'
import { createJob } from '../../../features/production/jobs/runner.js'
import * as pipeline from '../../../features/production/pipeline.js'
import { planTick } from '../../../features/production/plan-tick.js'
import { buildDigest } from '../../../features/reporting/digest.js'

describe('daemon time source composition', () => {
  it('shares one clock through singleton ownership, actions, a long job, accounting and shutdown drain', async () => {
    const time = createTestTime(new Date('2040-02-03T12:00:00Z'))
    const db = memDb(time)
    const channelsDir = writeChannelsDir({ 'clock.toml': channelToml({ name: 'clock' }) })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stages = vi.spyOn(pipeline, 'pipelineStages').mockReturnValue([
      {
        name: 'script',
        async run(ctx) {
          expect(ctx.time).toBe(time)
          entered()
          await ctx.time.sleep(360_000, ctx.signal)
          ctx.assertOwned!()
          recordCost(db, ctx.jobId, 'test', 'script', 123, ctx.attemptId, ctx.time)
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        },
      },
    ])
    const id = enqueueAction(db, {
      kind: 'jobs.produce',
      args: { channel: 'clock', topic: 'clock test' },
      requestedBy: 'test',
      time,
    })
    const controller = new AbortController()
    const running = runDaemon(db, {
      channelsDir,
      runsRoot: tmpDir('clock-runs-'),
      time,
      signal: controller.signal,
      emit: () => {},
    })
    try {
      await started
      expect(getAction(db, id)).toMatchObject({
        createdAt: '2040-02-03T12:00:00.000Z',
        startedAt: '2040-02-03T12:00:00.000Z',
      })
      await time.advanceBy(120_000)
      controller.abort()
      expect(db.prepare('SELECT name, expires_at FROM leases ORDER BY name').all()).toEqual([
        { name: 'daemon', expires_at: '2040-02-03T12:07:00.000Z' },
        { name: 'produce', expires_at: '2040-02-03T12:07:00.000Z' },
      ])
      await time.advanceBy(240_000)
      await running
      expect(getAction(db, id)).toMatchObject({
        status: 'done',
        finishedAt: '2040-02-03T12:06:00.000Z',
      })
      expect(db.prepare('SELECT created_at, finished_at FROM jobs').get()).toEqual({
        created_at: '2040-02-03T12:00:00.000Z',
        finished_at: '2040-02-03T12:06:00.000Z',
      })
      expect(db.prepare('SELECT created_at FROM costs').get()).toEqual({
        created_at: '2040-02-03T12:06:00.000Z',
      })
      expect(db.prepare('SELECT created_at FROM library').get()).toEqual({
        created_at: '2040-02-03T12:06:00.000Z',
      })
      expect(db.prepare('SELECT * FROM leases').all()).toEqual([])
      expect(time.pendingTimerCount()).toBe(0)
    } finally {
      controller.abort()
      await time.advanceBy(360_000)
      await running
      stages.mockRestore()
    }
  })

  it('rolls production quota and daily spend over at the injected UTC midnight', async () => {
    const time = createTestTime(new Date('2040-02-03T23:59:59Z'))
    const db = memDb(time)
    const channel = testChannel({
      videosPerDay: 1,
      budget: { perDayUsdMicros: 100 },
    })
    const jobId = createJob(db, channel, { topic: 'yesterday', time })
    db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobId)
    seedTopic(db, { channel: channel.name })
    recordCost(db, jobId, 'test', 'script', 100, undefined, time)
    expect(planTick(db, [channel], time).kind).toBe('noop')
    expect(() => assertBudget(db, channel, 1, time)).toThrow(/channel-day budget/)
    expect(buildDigest(db, [channel], { time })).toContain('1 scouted')
    await time.advanceBy(1000)
    expect(planTick(db, [channel], time).kind).toBe('produce')
    expect(() => assertBudget(db, channel, 1, time)).not.toThrow()
    markPosted(db, { jobId, platform: 'youtube', url: 'https://example.com/first', time })
    await time.advanceBy(86_400_000)
    markPosted(db, { jobId, platform: 'youtube', url: 'https://example.com/corrected', time })
    expect(db.prepare('SELECT posted_at, url FROM posts').get()).toEqual({
      posted_at: '2040-02-04T00:00:00.000Z',
      url: 'https://example.com/corrected',
    })
    expect(buildDigest(db, [channel], { time })).toContain('Topics (last 24h)\n  none')
  })
})
