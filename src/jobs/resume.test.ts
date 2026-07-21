import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { assertPremiumPreflight as cliPreflight, stagesForTier as cliStages } from '../cli.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, Tier } from './types.js'
import { assertPremiumPreflight, stagesForTier } from './pipeline.js'
import { ResumeError, resumeJob } from './resume.js'

// Real minimal channel TOML (plan-1 shape; [scout] is optional): resumeJob
// loads the channel from disk, so the fixture must round-trip loadChannelConfig.
const CHANNEL_TOML = [
  'name = "resume-test"',
  'niche = ["space facts"]',
  'bg_dir = "assets/bg"',
  'bgm_dir = "assets/bgm"',
  '',
  '[tier_mix]',
  'volume = 2',
  'premium = 1',
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
  it('cli.ts re-exports the moved helpers with identical identity', () => {
    // Re-export, not copy: the loop code and the CLI must share ONE wiring.
    expect(cliStages).toBe(stagesForTier)
    expect(cliPreflight).toBe(assertPremiumPreflight)
    // The move is verbatim: the six-stage produce order is unchanged.
    expect(stagesForTier('volume').map((s) => s.name)).toEqual([
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
    db = openDb(':memory:')
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

  // Mirrors createJob's row shape: one jobs row plus six pending stage rows.
  function seedJob(
    status: string,
    opts: { tier?: Tier; channel?: string; id?: string } = {},
  ): string {
    const id = opts.id ?? `job-${status}`
    db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
      id,
      opts.channel ?? 'resume-test',
      opts.tier ?? 'volume',
      'why the moon drifts',
      status,
    )
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
    await expect(resumeJob(db, 'job-done', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
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
      | { state: string }
      | undefined
    expect(lib?.state).toBe('ready')
  })

  it('refuses a running job without force, naming --force in the message', async () => {
    seedJob('running')
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
      /--force/,
    )
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
    const stagesFor = vi.fn((_tier: Tier) => fakeStages(calls))
    const result = await resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor })
    expect(result.status).toBe('ready')
    expect(result.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
    // the seam receives the job row's tier, not a caller guess
    expect(stagesFor).toHaveBeenCalledWith('volume')
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

  it('premium resume without FAL_KEY refuses before any stage or status change', async () => {
    vi.stubEnv('FAL_KEY', undefined)
    const jobId = seedJob('failed', { tier: 'premium' })
    const calls: string[] = []
    await expect(
      resumeJob(db, jobId, { runsRoot, channelsDir, stagesFor: () => fakeStages(calls) }),
    ).rejects.toThrow('premium tier requires FAL_KEY')
    expect(calls).toEqual([])
    // refused before runJob: the job row was never flipped to 'running'
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as {
      status: string
    }
    expect(row.status).toBe('failed')
  })

  it('premium resume proceeds when FAL_KEY is set', async () => {
    vi.stubEnv('FAL_KEY', 'fal-test-key')
    const jobId = seedJob('failed', { tier: 'premium' })
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

  it('`resume --help` prints usage with --db/--runs-root/--channels-dir/--force', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'resume', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--db')
    expect(result.stdout).toContain('--runs-root')
    expect(result.stdout).toContain('--channels-dir')
    expect(result.stdout).toContain('--force')
  }, 60000)

  it('a refusal prints the reason to stderr and exits 1 with no JSON on stdout', async () => {
    const dbPath = join(tmpDir('brainrot-resume-db-'), 'brainrot.db')
    openDb(dbPath).close() // create the schema
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'resume', 'no-such-job', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('job not found: no-such-job')
    // just the message — no raw unhandled-rejection stack frames
    expect(result.stderr).not.toMatch(/\n\s+at /)
    expect(result.stdout).toBe('')
  }, 60000)

  it('resumes a final-gate-crashed job end to end, printing the JobResult JSON line and exiting 0', async () => {
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
      db.prepare("INSERT INTO job_stages (job_id, stage, status) VALUES ('e2e-job', ?, 'done')").run(
        stage,
      )
    }
    db.close()
    const qcDir = join(runsRootDir, 'e2e-job', 'qc')
    mkdirSync(qcDir, { recursive: true })
    writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))
    const assembleDir = join(runsRootDir, 'e2e-job', 'assemble')
    mkdirSync(assembleDir, { recursive: true })
    writeFileSync(join(assembleDir, 'final.mp4'), 'FAKEMP4')

    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'resume', 'e2e-job',
        '--db', dbPath, '--runs-root', runsRootDir, '--channels-dir', channelsDirPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    const line = JSON.parse(result.stdout) as { jobId: string; status: string; videoPath?: string }
    expect(line.jobId).toBe('e2e-job')
    expect(line.status).toBe('ready')
    expect(line.videoPath).toBe(join(runsRootDir, 'e2e-job', 'assemble', 'final.mp4'))
  }, 60000)
})
