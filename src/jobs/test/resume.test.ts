import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../../db/index.js'
import { pipelineStages as cliStages } from '../../cli.js'
import { STAGE_ORDER } from '../types.js'
import type { JobContext, StageDef } from '../types.js'
import { pipelineStages } from '../pipeline.js'
import { claimJobForResume, ResumeError, resumeJob } from '../resume.js'
import { runCli } from '../../testing/run-cli.js'
import { memDb } from '../../testing/db.js'

// Real minimal channel TOML (plan-1 shape; [scout] is optional): resumeJob
// loads the channel from disk, so the fixture must round-trip loadChannelConfig.
const CHANNEL_TOML = [
  'name = "resume-test"',
  'niche = ["space facts"]',
  'bg_dir = "assets/bg"',
  'bgm_dir = "assets/bgm"',
  'videos_per_day = 2',
  '',
  '[voice]',
  'volume = "af_heart"',
  '',
  '[caption_style]',
  'font = "Inter"',
  'font_size_px = 72',
  'active_color = "#FFD700"',
  'inactive_color = "#FFFFFF"',
  'stroke_px = 8',
  '',
  '[budget]',
  'per_video_usd = 8.0',
  'per_day_usd = 20.0',
].join('\n')

describe('jobs/pipeline', () => {
  it('cli.ts re-exports the moved helper with identical identity', () => {
    // Re-export, not copy: the loop code and the CLI must share ONE wiring.
    expect(cliStages).toBe(pipelineStages)
    // The move is verbatim: the seven-stage produce order is unchanged.
    expect(pipelineStages().map((s) => s.name)).toEqual([
      'script',
      'voice',
      'captions',
      'visuals',
      'assemble',
      'qc',
      'store',
    ])
  })
})

describe('resumeJob', () => {
  let db: Database
  let channelsDir: string
  let runsRoot: string

  beforeEach(() => {
    db = memDb()
    channelsDir = mkdtempSync(join(tmpdir(), 'brainrot-channels-'))
    runsRoot = mkdtempSync(join(tmpdir(), 'brainrot-runs-'))
    writeFileSync(join(channelsDir, 'resume-test.toml'), CHANNEL_TOML)
  })

  afterEach(() => {
    db.close()
    rmSync(channelsDir, { recursive: true, force: true })
    rmSync(runsRoot, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  // Mirrors createJob's row shape: one jobs row plus seven pending stage rows.
  function seedJob(status: string, opts: { channel?: string; id?: string } = {}): string {
    const id = opts.id ?? `job-${status}`
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, 'volume', ?, ?)",
    ).run(id, opts.channel ?? 'resume-test', 'why the moon drifts', status)
    for (const stage of STAGE_ORDER) {
      db.prepare('INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)').run(
        id,
        stage,
        'pending',
      )
    }
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
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store'])
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
    db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
        "VALUES ('resume-test', 'T', 'R', 's', 'u', 'h1', 80, 'r', 'claimed', ?)",
    ).run(jobId)
    const calls: string[] = []
    const stagesFor = vi.fn(() => fakeStages(calls))
    const result = await resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor })
    expect(result.status).toBe('ready')
    expect(result.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store'])
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
    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc', 'store'])
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
    db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
        "VALUES ('resume-test', 'T', 'R', 's', 'u', 'h2', 80, 'r', 'claimed', ?)",
    ).run(jobId)
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
  it('forwards the heartbeat to runJob: one call per stage actually run', async () => {
    const jobId = seedJob('blocked')
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)
    const calls: string[] = []
    const heartbeat = vi.fn()
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => fakeStages(calls),
      heartbeat,
    })
    expect(result.status).toBe('ready')
    // progress, not the clock: five stages left to run, five extensions
    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc', 'store'])
    expect(heartbeat).toHaveBeenCalledTimes(5)
  })

  it('resumes without a heartbeat (the manual CLI holds no lease)', async () => {
    const jobId = seedJob('blocked')
    const result = await resumeJob(db, jobId, {
      runsRoot,
      channelsDir,
      stagesFor: () => fakeStages(),
    })
    expect(result.status).toBe('ready')
  })
})

describe('brainrot resume CLI', () => {
  const cleanup: string[] = []
  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }
  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  it.concurrent(
    '`resume --help` prints usage with --db/--runs-root/--channels-dir/--force',
    async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--runs-root')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--force')
    },
    60000,
  )

  it.concurrent(
    'a refusal prints the reason to stderr and exits 1 with no JSON on stdout',
    async () => {
      const dbPath = join(tmpDir('brainrot-resume-db-'), 'brainrot.db')
      openDb(dbPath).close() // create the schema
      const result = await runCli(['resume', 'no-such-job', '--db', dbPath])
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
      const root = tmpDir('brainrot-resume-e2e-')
      const dbPath = join(root, 'brainrot.db')
      const runsRootDir = join(root, 'runs')
      const channelsDirPath = join(root, 'channels')
      mkdirSync(channelsDirPath, { recursive: true })
      writeFileSync(join(channelsDirPath, 'resume-test.toml'), CHANNEL_TOML)

      // A job that crashed at the final gate: every stage 'done' but status
      // 'failed'. Resume skips all stages and re-runs only the final gate —
      // the one real-stage-free path a subprocess test can drive.
      const db = openDb(dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('e2e-job', 'resume-test', 'volume', 't', 'failed')",
      ).run()
      for (const stage of STAGE_ORDER) {
        db.prepare(
          "INSERT INTO job_stages (job_id, stage, status) VALUES ('e2e-job', ?, 'done')",
        ).run(stage)
      }
      db.close()
      const qcDir = join(runsRootDir, 'e2e-job', 'qc')
      mkdirSync(qcDir, { recursive: true })
      writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))
      const assembleDir = join(runsRootDir, 'e2e-job', 'assemble')
      mkdirSync(assembleDir, { recursive: true })
      writeFileSync(join(assembleDir, 'final.mp4'), 'FAKEMP4')

      const result = await runCli([
        'resume',
        'e2e-job',
        '--db',
        dbPath,
        '--runs-root',
        runsRootDir,
        '--channels-dir',
        channelsDirPath,
      ])
      expect(result.exitCode).toBe(0)
      const line = JSON.parse(result.stdout) as {
        jobId: string
        status: string
        videoPath?: string
      }
      expect(line.jobId).toBe('e2e-job')
      expect(line.status).toBe('ready')
      expect(line.videoPath).toBe(join(runsRootDir, 'e2e-job', 'assemble', 'final.mp4'))
    },
    60000,
  )
})
