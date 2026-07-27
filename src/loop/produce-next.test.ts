import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { loadChannelConfig } from '../config/channel.js'
import { ResumeError, resumeJob } from '../jobs/resume.js'
import { stubStorageEnv } from '../testing/storage.js'
import { createJob } from '../jobs/runner.js'
import { runCli } from '../testing/run-cli.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import { claimTopic } from '../scout/topics.js'
import { produceNextTick } from './produce-next.js'
import { acquireLease, PRODUCE_LEASE_TTL_MS } from './lease.js'
import { memDb } from '../testing/db.js'

// Both lost-claim races are single-instant windows between planning and
// executing that no in-process seeding can open, so the two losing calls are
// spied through to their real implementations and forced to lose once.
vi.mock('../scout/topics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scout/topics.js')>()
  return { ...actual, claimTopic: vi.fn(actual.claimTopic) }
})
vi.mock('../jobs/resume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/resume.js')>()
  return { ...actual, resumeJob: vi.fn(actual.resumeJob) }
})

// Plan-1-shape channel TOML (no [scout] table needed — the loop reads topics,
// not sources). The filename must match `name`: resumeJob resolves the channel
// as `${channelsDir}/${job.channel}.toml`.
const CHANNEL_TOML = [
  'name = "loop-chan"',
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

const cleanupDirs: string[] = []
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
})

// One shared read-only channels dir; each test gets a fresh db and runs root.
const channelsDir = tmpDir('brainrot-loop-channels-')
writeFileSync(join(channelsDir, 'loop-chan.toml'), CHANNEL_TOML)

function setup() {
  const db = memDb()
  const runsRoot = join(tmpDir('brainrot-loop-run-'), 'runs')
  return { db, runsRoot }
}

let topicSeq = 0
function seedTopic(db: Database): number {
  topicSeq += 1
  const info = db
    .prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'loop-chan',
      'Venus rains molten metal',
      'TIL Venus rains metal',
      'reddit:r/space',
      'https://www.reddit.com/r/space/comments/abc',
      `hash-${topicSeq}`,
      80,
      'hooky and on-niche',
      'candidate',
    )
  return Number(info.lastInsertRowid)
}

// The runner's final gate reads qc/qc.json to pick ready vs needs-review, so
// a one-stage fake pipeline that writes it is the cheapest library landing.
function readyStages(): StageDef[] {
  return [
    {
      name: 'qc',
      async run(ctx: JobContext) {
        writeFileSync(
          ctx.artifactPath('qc', 'qc.json'),
          JSON.stringify({ passed: true, checks: [] }),
        )
      },
    },
  ]
}

// Guard seam for paths that must never reach the pipeline.
function neverStages(): StageDef[] {
  throw new Error('stagesFor must not be called on this path')
}

function failingStages(): StageDef[] {
  return [
    {
      name: 'script',
      async run() {
        throw new Error('stage exploded')
      },
    },
  ]
}

beforeEach(() => {
  // Deterministic regardless of the developer's shell or .env: the default
  // $25 global cap.
  vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '')
  // Object storage is required to produce (design spec §3.5), and the tick
  // refuses before the lease when it is unset. These tests inject their own
  // stages and never reach a real store, but they must clear the gate — and
  // they must clear it from stubs rather than the developer's .env, so the
  // suite behaves the same on a machine with R2 configured and one without.
  stubStorageEnv()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('produceNextTick — produce', () => {
  it('claims the eligible topic, produces it, and flips it used on library landing', async () => {
    const { db, runsRoot } = setup()
    const topicId = seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({
      action: 'produced',
      jobId: expect.any(String),
      topicId,
      status: 'ready',
    })
    // topic consumed: claimed → used, bound to the created job
    const topic = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(topicId) as {
      status: string
      job_id: string
    }
    expect(topic).toEqual({ status: 'used', job_id: result.jobId })
    // the job row carries the reframed topic title and landed in the library
    const job = db
      .prepare('SELECT topic, tier, status FROM jobs WHERE id = ?')
      .get(result.jobId) as { topic: string; tier: string; status: string }
    expect(job).toEqual({ topic: 'Venus rains molten metal', tier: 'volume', status: 'done' })
    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(result.jobId) as {
      state: string
    }
    expect(lib.state).toBe('ready')
    db.close()
  })
})

describe('produceNextTick — resume', () => {
  it('resumes the blocked job through resumeJob before claiming anything', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    // an eligible topic exists too: the resume pass must win over the claim pass
    seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({ action: 'resumed', jobId, status: 'ready' })
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as {
      status: string
    }
    expect(job.status).toBe('done')
    // the topic was not claimed: it waits for the next tick
    const topics = db.prepare('SELECT status FROM topics').all() as { status: string }[]
    expect(topics).toEqual([{ status: 'candidate' }])
    db.close()
  })
})

describe('produceNextTick — lease', () => {
  it('no-ops with reason lease-held while another process holds the lease', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    acquireLease(db, 'produce', 'pid:other-process', PRODUCE_LEASE_TTL_MS)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: neverStages })
    expect(result).toEqual({ action: 'noop', reason: 'lease-held' })
    // the holder's lease survives untouched and nothing was claimed or created
    const lease = db.prepare("SELECT holder FROM leases WHERE name = 'produce'").get() as {
      holder: string
    }
    expect(lease.holder).toBe('pid:other-process')
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('releases the lease after a successful tick', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result.status).toBe('ready')
    // freed for the next cron firing: a fresh holder acquires immediately
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })
})

// Object storage is required, not optional (design spec §3.5, decision 1: the
// cloud copy is the durable one). The `store` stage runs LAST, so without this
// gate an unconfigured deployment pays for a full Remotion render and only
// then fails the job — with no library row to show for it.
describe('produceNextTick — object storage not configured', () => {
  it('no-ops with reason bad-env before rendering anything', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    vi.stubEnv('BRAINROT_S3_BUCKET', '')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    // neverStages throws if the pipeline is reached at all: the gate must
    // refuse before any stage runs, which is the entire point of the fix.
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: neverStages })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('bad-env')
    expect(result.error).toContain('BRAINROT_S3_BUCKET')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('BRAINROT_S3_BUCKET'))
    stderr.mockRestore()
    db.close()
  })

  it('leaves the topic unclaimed and takes no lease', async () => {
    const { db, runsRoot } = setup()
    const topicId = seedTopic(db)
    vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', '')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await produceNextTick(db, { channelsDir, runsRoot, stagesFor: neverStages })
    // Nothing consumed: the next tick, once configured, produces this topic.
    const topic = db.prepare('SELECT status FROM topics WHERE id = ?').get(topicId) as {
      status: string
    }
    expect(topic.status).toBe('candidate')
    // The gate sits ahead of the lease for the same reason the channels-dir
    // check does: burning a lease slot on it would only make the next firing
    // wait on a lease that was never going to do work.
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    stderr.mockRestore()
    db.close()
  })
})

describe('produceNextTick — config errors', () => {
  it('no-ops with reason config-error on an unparseable channel TOML, naming the file on stderr', async () => {
    const { db, runsRoot } = setup()
    const brokenDir = tmpDir('brainrot-loop-broken-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await produceNextTick(db, {
      channelsDir: brokenDir,
      runsRoot,
      stagesFor: neverStages,
    })
    // The whole point of the fix: a well-formed JSON line (exit 0 at the CLI)
    // instead of a throw that escapes with no line at all, every firing.
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    expect(result.error).toContain('broken.toml')
    // ...and the cause on stderr, where cron mail (or the log) will show it.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('broken.toml'))
    stderr.mockRestore()
    db.close()
  })

  it('no-ops with reason config-error when the channels dir does not exist', async () => {
    const { db, runsRoot } = setup()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await produceNextTick(db, {
      channelsDir: join(tmpdir(), 'brainrot-no-such-channels-dir'),
      runsRoot,
      stagesFor: neverStages,
    })
    expect(result.action).toBe('noop')
    expect(result.reason).toBe('config-error')
    stderr.mockRestore()
    db.close()
  })

  it('never takes the produce lease on a broken config', async () => {
    const { db, runsRoot } = setup()
    const brokenDir = tmpDir('brainrot-loop-broken-lease-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await produceNextTick(db, { channelsDir: brokenDir, runsRoot, stagesFor: neverStages })
    // Not merely released — never acquired: the row does not exist at all, so
    // a config error can never cost the next firing its own lease attempt.
    expect(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'produce'").get()).toEqual({
      n: 0,
    })
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    stderr.mockRestore()
    db.close()
  })

  it('a healthy channels dir is unaffected: the tick produces as before', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result.action).toBe('produced')
    expect(result.reason).toBeUndefined()
    db.close()
  })
})

describe('produceNextTick — failed produce', () => {
  it('keeps the topic claimed and job-bound when a stage fails', async () => {
    const { db, runsRoot } = setup()
    const topicId = seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: failingStages })
    expect(result).toEqual({
      action: 'produced',
      jobId: expect.any(String),
      topicId,
      status: 'failed',
    })
    // claimed + bound to its failed job: the resume path owns recovery, the
    // topic is never re-claimed or lost
    const topic = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(topicId) as {
      status: string
      job_id: string
    }
    expect(topic).toEqual({ status: 'claimed', job_id: result.jobId })
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(result.jobId) as {
      status: string
    }
    expect(job.status).toBe('failed')
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })
})

describe('produceNextTick — repair sweep', () => {
  it('flips a claimed topic bound to a library-landed job to used, then no-ops', async () => {
    const { db, runsRoot } = setup()
    // A job that committed its library row but crashed before markTopicUsedByJob:
    // its topic is stranded 'claimed' and bound to a now-'done' job (resume
    // refuses 'done', so nothing else can ever recover it).
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('landed-job', 'loop-chan', 'volume', 't', 'done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('landed-job', '/tmp/out.mp4', '{}', 'ready')",
    ).run()
    db.prepare(
      'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
        "VALUES ('loop-chan', 'T', 'R', 's', 'u', 'h-repair', 80, 'r', 'claimed', 'landed-job')",
    ).run()
    // queue is otherwise empty (the claimed topic is not eligible) → noop, and
    // neverStages guards that no production runs on this path
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: neverStages })
    expect(result).toEqual({ action: 'noop', reason: 'no-eligible-work' })
    const topic = db.prepare("SELECT status FROM topics WHERE dedupe_hash = 'h-repair'").get() as {
      status: string
    }
    expect(topic.status).toBe('used')
    db.close()
  })
})

describe('produceNextTick — lost claims', () => {
  it('no-ops with claim-conflict when the topic was taken since planning', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    // `topics reject` landing between planTick's SELECT and this claim.
    vi.mocked(claimTopic).mockReturnValueOnce(false)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({ action: 'noop', reason: 'claim-conflict' })
    // the job row rolled back with the failed claim, and the lease is free
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0)
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('no-ops with claim-conflict when a manual resume won the blocked job', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(
      new ResumeError(`job ${jobId} was picked up by another process`),
    )
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({ action: 'noop', reason: 'claim-conflict' })
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })

  it('still propagates a non-refusal failure from the resume path', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(new Error('disk full'))
    await expect(
      produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages }),
    ).rejects.toThrow('disk full')
    // A throw mid-flight still releases the lease on the way out (the finally),
    // so one crash cannot wedge the loop until the TTL expires.
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
    db.close()
  })
})

describe('produceNextTick — lease heartbeat', () => {
  it('a stage start pushes the produce lease expiry back into the future', async () => {
    const { db, runsRoot } = setup()
    seedTopic(db)
    let observed = ''
    // Stage one drifts the expiry into the past (standing in for a render
    // longer than the 90-min TTL); stage two reads what its own heartbeat left
    // behind, before the finally-release deletes the row.
    const stages: StageDef[] = [
      {
        name: 'script',
        async run() {
          db.prepare(
            "UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE name = 'produce'",
          ).run()
        },
      },
      {
        name: 'qc',
        async run(ctx: JobContext) {
          observed = (
            db.prepare("SELECT expires_at FROM leases WHERE name = 'produce'").get() as {
              expires_at: string
            }
          ).expires_at
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        },
      },
    ]
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: () => stages })
    expect(result.status).toBe('ready')
    expect(Date.parse(observed)).toBeGreaterThan(Date.now())
    db.close()
  })

  // Same guarantee down the resume path, which is where the long renders are:
  // a blocked premium job resumes with its expensive stages already done, so
  // the remaining work is exactly what blew the budget (or the clock) before.
  it('a resumed job heartbeats the lease too', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    let observed = ''
    const stages: StageDef[] = [
      {
        name: 'script',
        async run() {
          db.prepare(
            "UPDATE leases SET expires_at = '2020-01-01T00:00:00.000Z' WHERE name = 'produce'",
          ).run()
        },
      },
      {
        name: 'qc',
        async run(ctx: JobContext) {
          observed = (
            db.prepare("SELECT expires_at FROM leases WHERE name = 'produce'").get() as {
              expires_at: string
            }
          ).expires_at
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        },
      },
    ]
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: () => stages })
    expect(result.action).toBe('resumed')
    expect(Date.parse(observed)).toBeGreaterThan(Date.now())
    db.close()
  })
})

describe('produce-next CLI', () => {
  it.concurrent(
    '`produce-next --help` prints usage with --db/--channels-dir/--runs-root',
    async () => {
      const result = await runCli(['produce-next', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
      expect(result.stdout).toContain('--runs-root')
    },
    60000,
  )

  it.concurrent(
    '`produce-next` with no eligible work prints one noop JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-loop-cli-')
      const result = await runCli([
        'produce-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        channelsDir,
        '--runs-root',
        join(root, 'runs'),
      ])
      expect(result.exitCode).toBe(0)
      // exactly one cron-greppable JSON line
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-eligible-work' })
    },
    60000,
  )

  // The G14 symptom end to end: this used to exit 1 with an empty stdout, so a
  // cron log of JSON lines simply had a hole in it every 25 minutes.
  it.concurrent(
    '`produce-next` over a broken channels dir still prints one JSON line and exits 0',
    async () => {
      const root = tmpDir('brainrot-loop-cli-broken-')
      const brokenDir = tmpDir('brainrot-loop-cli-broken-channels-')
      writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli([
        'produce-next',
        '--db',
        join(root, 'brainrot.db'),
        '--channels-dir',
        brokenDir,
        '--runs-root',
        join(root, 'runs'),
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const line = JSON.parse(result.stdout) as { action: string; reason: string; error: string }
      expect(line.action).toBe('noop')
      expect(line.reason).toBe('config-error')
      expect(line.error).toContain('broken.toml')
      // stderr keeps the cause visible where the JSON line is only grepped
      expect(result.stderr).toContain('broken.toml')
    },
    60000,
  )
})
