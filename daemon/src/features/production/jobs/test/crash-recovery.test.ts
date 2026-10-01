import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testChannel } from '../../../../../testing/channel.js'
import { fileDb, seedTopic } from '../../../../../testing/db.js'
import { testScript } from '../../../../../testing/job.js'
import { requireLease } from '../../../../infra/coordination/lease.js'
import { STAGE_ORDER, type StageName } from '../../../../shared/contracts/pipeline.js'
import { recordCost } from '../../../billing/costs.js'
import { type StageDef } from '../../contracts.js'
import { planTick } from '../../plan-tick.js'
import { reconcileJobs } from '../execution.js'
import { runJob } from '../runner.js'

type CrashPoint = 'queued' | 'script' | 'voice' | 'before-finalize'
interface Marker {
  jobId: string
  attemptId: string | null
  unfinishedPath?: string
}

// Only the harness lives in the disposable directory. Imports use the current
// source tree so the child tests exactly the runner under review, without a CLI
// build, live provider, or test-only production hook.
const childSource = `
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from ${JSON.stringify(new URL('../../../../infra/db/index.ts', import.meta.url).href)}
import { createJob, runJob } from ${JSON.stringify(new URL('../runner.ts', import.meta.url).href)}
import { beginAttempt } from ${JSON.stringify(new URL('../execution.ts', import.meta.url).href)}
import { recordCost } from ${JSON.stringify(new URL('../../../billing/costs.ts', import.meta.url).href)}
import { requireLease } from ${JSON.stringify(new URL('../../../../infra/coordination/lease.ts', import.meta.url).href)}
import { claimTopic } from ${JSON.stringify(new URL('../../../topics/mutations.ts', import.meta.url).href)}
import { testChannel } from ${JSON.stringify(new URL('../../../../../testing/channel.ts', import.meta.url).href)}
import { testScript } from ${JSON.stringify(new URL('../../../../../testing/job.ts', import.meta.url).href)}
import { STAGE_ORDER } from ${JSON.stringify(new URL('../../../../shared/contracts/pipeline.ts', import.meta.url).href)}
const { dbPath, runsRoot, mode, topicId } = JSON.parse(process.argv[2])
const db = openDb(dbPath)
const channel = testChannel()
const lease = requireLease(db, 'produce')
const jobId = db.transaction(() => {
  const id = createJob(db, channel, { topic: 'Crash recovery topic' })
  if (!claimTopic(db, topicId, id)) throw new Error('fixture topic claim failed')
  return id
})()
const pause = async (marker) => {
  // A referenced timer keeps the process alive while the parent chooses the
  // exact SIGKILL boundary. The production lease heartbeat is unref'd.
  setInterval(() => {}, 1000)
  process.send(marker)
  await new Promise(() => {})
}
const artifact = (stage, path) => {
  if (stage === 'script') writeFileSync(path('script.json'), JSON.stringify(testScript()))
  else if (stage === 'qc') writeFileSync(path('qc.json'), JSON.stringify({ passed: true, checks: [] }))
  else if (stage === 'assemble') writeFileSync(path('final.mp4'), 'fake final video')
  else writeFileSync(path('complete.txt'), stage)
}
if (mode === 'queued') await pause({ jobId, attemptId: null })
if (mode === 'before-finalize') {
  // The real final gate has no async gap after the last committed stage.
  // Seed that persisted state, then kill a real process holding its attempt.
  const attemptId = beginAttempt(db, jobId, lease)
  for (const stage of STAGE_ORDER) {
    const dir = join(runsRoot, jobId, 'attempts', attemptId, stage)
    mkdirSync(dir, { recursive: true })
    artifact(stage, file => join(dir, file))
    if (stage === 'script') recordCost(db, jobId, 'fake-paid', 'script', 75, attemptId)
    db.prepare("UPDATE job_stages SET status='done', artifact_dir=? WHERE job_id=? AND stage=?")
      .run(dir, jobId, stage)
  }
  await pause({ jobId, attemptId })
}
await runJob(db, channel, jobId, STAGE_ORDER.map(name => ({ name, async run(ctx) {
  if (name === 'script') recordCost(db, jobId, 'fake-paid', 'script', 75, ctx.attemptId)
  if (name === mode) {
    const unfinishedPath = ctx.artifactPath(name, 'unfinished.txt')
    writeFileSync(unfinishedPath, 'partial from killed attempt')
    await pause({ jobId, attemptId: ctx.attemptId, unfinishedPath })
  }
  artifact(name, file => ctx.artifactPath(name, file))
} })), { runsRoot, lease })
throw new Error('child passed its intended crash point')
`

async function killAt(
  root: string,
  dbPath: string,
  runsRoot: string,
  mode: CrashPoint,
  topicId: number,
): Promise<Marker> {
  const script = join(root, 'crash-child.mjs')
  writeFileSync(script, childSource)
  const child = fork(script, [JSON.stringify({ dbPath, runsRoot, mode, topicId })], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  try {
    const marker = await new Promise<Marker>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`child did not reach crash point: ${stderr}`)),
        10_000,
      )
      child.once('message', (message) => {
        clearTimeout(timer)
        resolve(message as Marker)
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`child exited before marker (${code}/${signal}): ${stderr}`))
      })
    })
    const exited = once(child, 'exit')
    expect(child.kill('SIGKILL')).toBe(true)
    expect(await exited).toEqual([null, 'SIGKILL'])
    return marker
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
}

describe('process crash recovery', () => {
  it.each<CrashPoint>(['queued', 'script', 'voice', 'before-finalize'])(
    'recovers the same claimed job after SIGKILL at %s',
    async (mode) => {
      const { db, dbPath, root } = fileDb()
      const runsRoot = join(root, 'runs')
      const topicId = seedTopic(db, { channel: 'test', title: 'Crash recovery topic' })
      const marker = await killAt(root, dbPath, runsRoot, mode, topicId)
      const before = db
        .prepare('SELECT status, active_attempt_id FROM jobs WHERE id=?')
        .get(marker.jobId)
      expect(before).toEqual({
        status: mode === 'queued' ? 'queued' : 'running',
        active_attempt_id: marker.attemptId,
      })
      expect(db.prepare('SELECT status, job_id FROM topics WHERE id=?').get(topicId)).toEqual({
        status: 'claimed',
        job_id: marker.jobId,
      })
      expect(db.prepare('SELECT * FROM library').all()).toEqual([])
      const scriptCheckpoint = db
        .prepare("SELECT artifact_dir FROM job_stages WHERE job_id=? AND stage='script'")
        .get(marker.jobId) as { artifact_dir: string | null }
      const oldScript =
        scriptCheckpoint.artifact_dir === null
          ? null
          : readFileSync(join(scriptCheckpoint.artifact_dir, 'script.json'), 'utf8')

      // The child is confirmed dead. Advance only its persisted lease expiry;
      // no wall-clock sleep or live-owner takeover is needed for this test.
      db.prepare(
        "UPDATE leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE name='produce'",
      ).run()
      const lease = requireLease(db, 'produce')
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(reconcileJobs(db, lease)).toBe(1)
        expect(reconcileJobs(db, lease)).toBe(0)
        expect(
          db
            .prepare('SELECT status, recovery_pending, recovery_count FROM jobs WHERE id=?')
            .get(marker.jobId),
        ).toEqual({ status: 'queued', recovery_pending: 1, recovery_count: 1 })
        if (marker.attemptId !== null) {
          expect(
            db.prepare('SELECT status FROM execution_attempts WHERE id=?').get(marker.attemptId),
          ).toEqual({ status: 'interrupted' })
        }
        db.prepare("UPDATE jobs SET retry_after='2000-01-01T00:00:00.000Z' WHERE id=?").run(
          marker.jobId,
        )
        const channel = testChannel()
        expect(planTick(db, [channel])).toEqual({
          kind: 'resume',
          jobId: marker.jobId,
          channel: 'test',
        })
        const ran: StageName[] = []
        const artifactPaths: string[] = []
        const stages: StageDef[] = STAGE_ORDER.map((name) => ({
          name,
          async run(ctx) {
            ran.push(name)
            const output = (file: string) => {
              const path = ctx.artifactPath(name, file)
              artifactPaths.push(path)
              return path
            }
            if (name === 'script') {
              recordCost(db, ctx.jobId, 'fake-paid', 'script', 125, ctx.attemptId)
              writeFileSync(output('script.json'), JSON.stringify(testScript()))
            } else if (name === 'voice') {
              expect(
                JSON.parse(readFileSync(ctx.artifactPath('script', 'script.json'), 'utf8')).hook,
              ).toBe('Hook here')
              writeFileSync(output('complete.txt'), name)
            } else if (name === 'qc')
              writeFileSync(output('qc.json'), JSON.stringify({ passed: true, checks: [] }))
            else if (name === 'assemble')
              writeFileSync(output('final.mp4'), 'recovered final video')
            else writeFileSync(output('complete.txt'), name)
          },
        }))
        const result = await runJob(db, channel, marker.jobId, stages, { runsRoot, lease })
        expect(result).toMatchObject({ jobId: marker.jobId, status: 'ready' })
        expect(db.prepare('SELECT id, status FROM jobs').all()).toEqual([
          { id: marker.jobId, status: 'done' },
        ])
        expect(db.prepare('SELECT status, job_id FROM topics WHERE id=?').get(topicId)).toEqual({
          status: 'used',
          job_id: marker.jobId,
        })
        expect(db.prepare('SELECT job_id FROM library').all()).toEqual([{ job_id: marker.jobId }])
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM job_stages WHERE job_id=? AND status='done'")
            .get(marker.jobId),
        ).toEqual({ n: 6 })
        expect(ran).toEqual(
          mode === 'before-finalize'
            ? []
            : mode === 'voice'
              ? STAGE_ORDER.slice(1)
              : [...STAGE_ORDER],
        )
        if (oldScript !== null)
          expect(readFileSync(join(scriptCheckpoint.artifact_dir!, 'script.json'), 'utf8')).toBe(
            oldScript,
          )
        if (marker.unfinishedPath !== undefined) {
          expect(readFileSync(marker.unfinishedPath, 'utf8')).toBe('partial from killed attempt')
          for (const path of artifactPaths) expect(path).not.toContain(marker.attemptId!)
        }
        const charges = db
          .prepare('SELECT usd_micros, attempt_id FROM costs ORDER BY id')
          .all() as { usd_micros: number; attempt_id: string }[]
        expect(charges.map((c) => c.usd_micros)).toEqual(
          mode === 'script' ? [75, 125] : mode === 'queued' ? [125] : [75],
        )
        if (mode === 'script') {
          expect(charges[0].attempt_id).not.toBe(charges[1].attempt_id)
          expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
            expect.objectContaining({
              event: 'job-recovery',
              jobId: marker.jobId,
              possibleDuplicateCharge: true,
              previousAttemptId: marker.attemptId,
              stage: 'script',
            }),
          )
        }
      } finally {
        warnings.mockRestore()
        lease.release()
      }
    },
  )
})
