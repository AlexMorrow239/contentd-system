import { createTestTime } from '../../../testing/time.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import { STAGE_ORDER } from '../types.js'
import type { JobContext, StageDef } from '../types.js'
import { pipelineStages } from '../pipeline.js'
import { claimJobForResume, ResumeError, resumeJob } from '../resume.js'
import { runCli } from '../../../testing/run-cli.js'
import { memDb, seedJob as seedJobRow, seedStage, seedTopic } from '../../../testing/db.js'
import { testRoot, tmpDir } from '../../../testing/tmp.js'
import { BrainrotError, classify, errorMessage } from '../../errors.js'

// Real minimal channel TOML (plan-1 shape; [scout] is optional): resumeJob
// loads the channel from disk, so the fixture must round-trip loadChannelConfig.
const CHANNEL_TOML = [
  'name = "resume-test"',
  'niche = ["space facts"]',
  'bg_dir = "assets/bg"',
  'videos_per_day = 2',
  '',
  '[voice]',
  'voice_id = "EXAVITQu4vr4xnSDxMaL"',
  '',
  '[budget]',
  'per_video_usd = 8.0',
  'per_day_usd = 20.0',
].join('\n')

describe('jobs/pipeline', () => {
  it('is the six-stage produce order', () => {
    // One wiring for every caller (CLI produce, resume, produce-next): they
    // all import this function, so the order below is the whole contract.
    expect(pipelineStages().map((s) => s.name)).toEqual([
      'script',
      'voice',
      'captions',
      'visuals',
      'assemble',
      'qc',
    ])
  })
})

describe('resumeJob', () => {
  let db: Database
  let channelsDir: string
  let runsRoot: string

  beforeEach(() => {
    db = memDb()
    channelsDir = tmpDir('brainrot-channels-')
    runsRoot = tmpDir('brainrot-runs-')
    writeFileSync(join(channelsDir, 'resume-test.toml'), CHANNEL_TOML)
  })

  afterEach(() => {
    db.close()
  })

  // Mirrors createJob's row shape: one jobs row plus six pending stage rows.
  function seedJob(status: string, opts: { channel?: string; id?: string } = {}): string {
    const id = opts.id ?? `job-${status}`
    seedJobRow(db, id, {
      channel: opts.channel ?? 'resume-test',
      topic: 'why the moon drifts',
      status,
    })
    for (const stage of STAGE_ORDER) seedStage(db, id, stage, { status: 'pending' })
    return id
  }

  // Fake happy-path stages, mirroring runner.test.ts: assemble writes
  // final.mp4, qc writes a passing qc.json, everything else drops a marker.
  function fakeStages(calls: string[] = []): StageDef[] {
    return STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        calls.push(name)
        if (name === 'assemble') {
          writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
        } else if (name === 'qc') {
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        } else {
          writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
        }
      },
    }))
  }

  it('refuses a missing job', async () => {
    await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
      /no-such-job/,
    )
  })

  it('refuses a done job', async () => {
    seedJob('done')
    await expect(resumeJob(db, 'job-done', { runsRoot, channelsDir })).rejects.toThrow(ResumeError)
  })

  it('resumes a queued job (crash before first status write): runs all stages and lands the library row', async () => {
    // A crash (or SQLITE_BUSY) between produce-next's claim transaction
    // committing (job 'queued', topic 'claimed') and runJob's first status
    // write strands the job 'queued'. resumeJob now accepts it: every stage is
    // still pending, so it is simply a full run.
    const jobId = seedJob('queued')
    const calls: string[] = []
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => fakeStages(calls),
    })
    expect(result.status).toBe('ready')
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(jobId) as
      { state: string } | undefined
    expect(lib?.state).toBe('ready')
  })

  it('refuses a running job without force, naming --force in the message', async () => {
    seedJob('running')
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(/--force/)
  })

  it('refuses when the channel TOML is missing from channelsDir', async () => {
    seedJob('failed', { channel: 'ghost-channel' })
    await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
      /ghost-channel\.toml/,
    )
  })

  it('resumes a failed job via the stagesFor seam and flips its claimed topic to used', async () => {
    const jobId = seedJob('failed')
    // A claimed topic bound to this job — the row claimTopic leaves behind.
    seedTopic(db, {
      channel: 'resume-test',
      title: 'T',
      rawTitle: 'R',
      source: 's',
      url: 'u',
      dedupeHash: 'h1',
      score: 80,
      reason: 'r',
      status: 'claimed',
      jobId,
    })
    const calls: string[] = []
    const stagesFor = vi.fn(() => fakeStages(calls))
    const result = await resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor })
    expect(result.status).toBe('ready')
    const assemble = db
      .prepare("SELECT artifact_dir FROM job_stages WHERE job_id = ? AND stage = 'assemble'")
      .get(jobId) as { artifact_dir: string }
    expect(assemble.artifact_dir).toContain(join(runsRoot, jobId, 'attempts'))
    expect(result.videoPath).toBe(join(assemble.artifact_dir, 'final.mp4'))
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
    expect(stagesFor).toHaveBeenCalledTimes(1)
    const topic = db.prepare('SELECT status FROM topics WHERE job_id = ?').get(jobId) as {
      status: string
    }
    expect(topic.status).toBe('used')
  })

  it('resumes a blocked job, skipping stages already done', async () => {
    const jobId = seedJob('blocked')
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)
    const calls: string[] = []
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => fakeStages(calls),
    })
    expect(result.status).toBe('ready')
    // the runner's skip-done resume: sunk stages are not re-run
    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc'])
  })

  it('running + force proceeds (no claimed topic → silent no-op on the flip)', async () => {
    const jobId = seedJob('running')
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      force: true,
      stagesFor: () => fakeStages(),
    })
    expect(result.status).toBe('ready')
  })

  it('leaves the claimed topic bound when the resume fails again', async () => {
    const jobId = seedJob('failed')
    seedTopic(db, {
      channel: 'resume-test',
      title: 'T',
      rawTitle: 'R',
      source: 's',
      url: 'u',
      dedupeHash: 'h2',
      score: 80,
      reason: 'r',
      status: 'claimed',
      jobId,
    })
    const failing: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run() {
        throw new Error('still broken')
      },
    }))
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => failing,
    })
    expect(result.status).toBe('failed')
    const topic = db.prepare('SELECT status FROM topics WHERE job_id = ?').get(jobId) as {
      status: string
    }
    // still bound to its job: the resume path owns recovery, never re-claiming
    expect(topic.status).toBe('claimed')
  })

  it('claimJobForResume: the first claim wins and flips to running, the second loses', () => {
    // Two racers (a manual resume and a produce-next tick) both read a
    // 'blocked'/'failed' job; exactly one may run it or they double-spend.
    const jobId = seedJob('blocked')
    expect(claimJobForResume(db, jobId, false)).toBe(true)
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }
    expect(row.status).toBe('running')
    // the loser sees 'running' — not in the non-force resumable set — and backs off
    expect(claimJobForResume(db, jobId, false)).toBe(false)
  })

  // The produce tick's lease has to survive a resumed render exactly as it
  // survives a fresh one — a resumed job is the one already known to be slow.
  it('renews ownership during a resumed stage beyond the lease TTL', async () => {
    const jobId = seedJob('blocked')
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)
    const calls: string[] = []
    const time = createTestTime(0)
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      time,
      stagesFor: () =>
        fakeStages(calls).map((stage) => ({
          ...stage,
          run: async (ctx) => {
            await time.advanceBy(360_000)
            ctx.assertOwned!()
            await stage.run(ctx)
          },
        })),
    })
    expect(result.status).toBe('ready')
    // progress, not the clock: four stages left to run, four extensions
    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc'])
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('acquires and releases ownership for standalone resume', async () => {
    const jobId = seedJob('blocked')
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => fakeStages(),
    })
    expect(result.status).toBe('ready')
  })

  describe('ResumeError kinds', () => {
    it('classifies a missing job as job/not-found', async () => {
      const err = await resumeJob(db, 'no-such-job', { runsRoot, channelsDir }).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(BrainrotError)
      expect(classify(err)).toMatchObject({ domain: 'job', kind: 'not-found' })
      expect(errorMessage(err)).toBe('job not found: no-such-job')
    })

    it('classifies an already-done job as job/refused', async () => {
      seedJob('done')
      const err = await resumeJob(db, 'job-done', { runsRoot, channelsDir }).catch(
        (e: unknown) => e,
      )
      expect(classify(err)).toMatchObject({ domain: 'job', kind: 'refused' })
    })

    it('classifies a live running job as job/conflict', async () => {
      seedJob('running')
      const err = await resumeJob(db, 'job-running', { runsRoot, channelsDir }).catch(
        (e: unknown) => e,
      )
      expect(classify(err)).toMatchObject({ domain: 'job', kind: 'conflict' })
    })
  })
})

describe('brainrot resume CLI', () => {
  it.concurrent(
    '`resume --help` prints usage with --root/--force',
    async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--root')
      expect(result.stdout).not.toContain('--runs-root')
      expect(result.stdout).not.toContain('--channels-dir')
      expect(result.stdout).toContain('--force')
    },
    60000,
  )

  it.concurrent(
    'a refusal prints the reason to stderr and exits 1 with no JSON on stdout',
    async () => {
      const root = testRoot()
      const result = await runCli(['resume', 'no-such-job', '--root', root.root])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('job not found: no-such-job')
      // just the message — no raw unhandled-rejection stack frames
      expect(result.stderr).not.toMatch(/\n\s+at /)
      expect(result.stdout).toBe('')
    },
    60000,
  )

  it.concurrent(
    'resumes a final-gate-crashed job end to end, printing the JobResult JSON line and exiting 0',
    async () => {
      const root = testRoot()
      writeFileSync(join(root.channelsDir, 'resume-test.toml'), CHANNEL_TOML)

      // A job that crashed at the final gate: every stage 'done' but status
      // 'failed'. Resume skips all stages and re-runs only the final gate —
      // the one real-stage-free path a subprocess test can drive.
      const db = openDb(root.dbPath)
      seedJobRow(db, 'e2e-job', { channel: 'resume-test', topic: 't', status: 'failed' })
      for (const stage of STAGE_ORDER) seedStage(db, 'e2e-job', stage, { status: 'done' })
      db.close()
      const qcDir = join(root.runsRoot, 'e2e-job', 'qc')
      mkdirSync(qcDir, { recursive: true })
      writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))
      const assembleDir = join(root.runsRoot, 'e2e-job', 'assemble')
      mkdirSync(assembleDir, { recursive: true })
      writeFileSync(join(assembleDir, 'final.mp4'), 'FAKEMP4')

      const result = await runCli(['resume', 'e2e-job', '--root', root.root])
      expect(result.exitCode).toBe(0)
      const line = JSON.parse(result.stdout) as {
        jobId: string
        status: string
        videoPath?: string
      }
      expect(line.jobId).toBe('e2e-job')
      expect(line.status).toBe('ready')
      expect(line.videoPath).toBe(join(root.runsRoot, 'e2e-job', 'assemble', 'final.mp4'))
    },
    60000,
  )
})
