import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { loadChannelConfig } from '../../config/channel.js'
import { ResumeError, resumeJob } from '../../jobs/resume.js'
import { createJob } from '../../jobs/runner.js'
import { runCli } from '../../testing/run-cli.js'
import type { JobContext, StageDef } from '../../jobs/types.js'
import { claimTopic } from '../../scout/topics.js'
import { produceNextTick } from '../produce-next.js'
import { acquireLease, PRODUCE_LEASE_TTL_MS } from '../lease.js'
import { memDb, seedJob, seedLibrary, seedTopic as seedTopicRow } from '../../testing/db.js'
import { testRoot, tmpDir } from '../../testing/tmp.js'

// Both lost-claim races are single-instant windows between planning and
// executing that no in-process seeding can open, so the two losing calls are
// spied through to their real implementations and forced to lose once.
vi.mock('../../scout/topics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scout/topics.js')>()
  return { ...actual, claimTopic: vi.fn(actual.claimTopic) }
})
vi.mock('../../jobs/resume.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/resume.js')>()
  return { ...actual, resumeJob: vi.fn(actual.resumeJob) }
})

// Plan-1-shape channel TOML (no [scout] table needed — the loop reads topics,
// not sources). The filename must match `name`: resumeJob resolves the channel
// as `${channelsDir}/${job.channel}.toml`.
const CHANNEL_TOML = [
  'name = "loop-chan"',
  'niche = ["space facts"]',
  'bg_dir = "assets/bg"',
  'videos_per_day = 2',
  '',
  '[voice]',
  'volume = "af_heart"',
  '',
  '[budget]',
  'per_video_usd = 8.0',
  'per_day_usd = 20.0',
].join('\n')

// One shared read-only channels dir; each test gets a fresh db and runs root.
const channelsDir = tmpDir('brainrot-loop-channels-')
writeFileSync(join(channelsDir, 'loop-chan.toml'), CHANNEL_TOML)

function setup() {
  const db = memDb()
  const runsRoot = join(tmpDir('brainrot-loop-run-'), 'runs')
  return { db, runsRoot }
}

// A loop-flavoured call shape (no arguments, unique hash per call) over the
// shared row builder — the _digest.fixtures.ts pattern.
let topicSeq = 0
function seedTopic(db: Database): number {
  topicSeq += 1
  return seedTopicRow(db, {
    channel: 'loop-chan',
    title: 'Venus rains molten metal',
    rawTitle: 'TIL Venus rains metal',
    source: 'reddit:r/space',
    url: 'https://www.reddit.com/r/space/comments/abc',
    dedupeHash: `hash-${topicSeq}`,
    score: 80,
    reason: 'hooky and on-niche',
    status: 'candidate',
  })
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

describe('produceNextTick — retired storage configuration', () => {
  it('ignores legacy storage variables and produces normally', async () => {
    const { db, runsRoot } = setup()
    const topicId = seedTopic(db)
    vi.stubEnv('BRAINROT_S3_ENDPOINT', 'http://127.0.0.1:9100')
    vi.stubEnv('BRAINROT_S3_BUCKET', 'legacy-bucket')
    vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', 'legacy-access')
    vi.stubEnv('BRAINROT_S3_SECRET_ACCESS_KEY', 'legacy-secret')
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({
      action: 'produced',
      jobId: expect.any(String),
      topicId,
      status: 'ready',
    })
    db.close()
  })
})

describe('produceNextTick — config errors', () => {
  it('no-ops with reason config-error on an unparseable channel TOML, naming the file', async () => {
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
    // ...and nothing on stderr: the cause travels in the result only. The
    // one-shot CLI's own test ('`produce-next` over a broken channels dir
    // ...') pins the human-readable copy at the surface that still prints it.
    expect(stderr).not.toHaveBeenCalled()
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
    seedJob(db, 'landed-job', { channel: 'loop-chan', topic: 't', status: 'done' })
    seedLibrary(db, 'landed-job', { videoPath: '/tmp/out.mp4', state: 'ready' })
    seedTopicRow(db, {
      channel: 'loop-chan',
      title: 'T',
      rawTitle: 'R',
      source: 's',
      url: 'u',
      dedupeHash: 'h-repair',
      score: 80,
      reason: 'r',
      status: 'claimed',
      jobId: 'landed-job',
    })
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
      new ResumeError(`job ${jobId} was picked up by another process`, 'conflict'),
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

describe('produceNextTick — resume refusal routing', () => {
  it('reports a real claim race as claim-conflict', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(
      new ResumeError(`job ${jobId} was picked up by another process`, 'conflict'),
    )
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({ action: 'noop', reason: 'claim-conflict' })
    db.close()
  })

  it('reports a missing channel TOML as resume-refused, carrying the reason', async () => {
    // Previously reported as `claim-conflict`, which reads as a benign
    // self-healing race — it is not: no tick can heal a deleted TOML.
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(
      new ResumeError('channel config not found: channels/gone.toml', 'not-found'),
    )
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({
      action: 'noop',
      reason: 'resume-refused',
      error: 'channel config not found: channels/gone.toml',
    })
    db.close()
  })

  it('reports an already-done job as resume-refused', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(
      new ResumeError(`job ${jobId} is already done; nothing to resume`, 'refused'),
    )
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result.reason).toBe('resume-refused')
    db.close()
  })

  it('still rethrows a non-ResumeError', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    vi.mocked(resumeJob).mockRejectedValueOnce(new Error('disk on fire'))
    await expect(
      produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages }),
    ).rejects.toThrow('disk on fire')
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
    '`produce-next --help` prints usage with --root',
    async () => {
      const result = await runCli(['produce-next', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--root')
      expect(result.stdout).not.toContain('--channels-dir')
      expect(result.stdout).not.toContain('--runs-root')
    },
    60000,
  )

  it.concurrent(
    '`produce-next` with no eligible work prints one noop JSON line and exits 0',
    async () => {
      const root = testRoot('brainrot-loop-cli-')
      writeFileSync(join(root.channelsDir, 'loop-chan.toml'), CHANNEL_TOML)
      const result = await runCli(['produce-next', '--root', root.root])
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
      const root = testRoot('brainrot-loop-cli-broken-')
      writeFileSync(join(root.channelsDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['produce-next', '--root', root.root])
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
