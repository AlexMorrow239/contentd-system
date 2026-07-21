import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { loadChannelConfig } from '../config/channel.js'
import { openDb } from '../db/index.js'
import { createJob } from '../jobs/runner.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import { produceNextTick } from './produce-next.js'
import { acquireLease, PRODUCE_LEASE_TTL_MS } from './lease.js'

// Plan-1-shape channel TOML (no [scout] table needed — the loop reads topics,
// not sources). The filename must match `name`: resumeJob resolves the channel
// as `${channelsDir}/${job.channel}.toml`.
const CHANNEL_TOML = [
  'name = "loop-chan"',
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
  const db = openDb(':memory:')
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
  // Deterministic regardless of the developer's shell or .env: no fal key
  // (volume path only) and the default $25 global cap.
  vi.stubEnv('FAL_KEY', '')
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
      tier: 'volume',
      status: 'ready',
    })
    // topic consumed: claimed → used, bound to the created job
    const topic = db
      .prepare('SELECT status, job_id FROM topics WHERE id = ?')
      .get(topicId) as { status: string; job_id: string }
    expect(topic).toEqual({ status: 'used', job_id: result.jobId })
    // the job row carries the reframed topic title and landed in the library
    const job = db
      .prepare('SELECT topic, tier, status FROM jobs WHERE id = ?')
      .get(result.jobId) as { topic: string; tier: string; status: string }
    expect(job).toEqual({ topic: 'Venus rains molten metal', tier: 'volume', status: 'done' })
    const lib = db
      .prepare('SELECT state FROM library WHERE job_id = ?')
      .get(result.jobId) as { state: string }
    expect(lib.state).toBe('ready')
    db.close()
  })
})

describe('produceNextTick — resume', () => {
  it('resumes the blocked job through resumeJob before claiming anything', async () => {
    const { db, runsRoot } = setup()
    const channel = loadChannelConfig(join(channelsDir, 'loop-chan.toml'))
    const jobId = createJob(db, channel, { topic: 'parked by budget', tier: 'volume' })
    db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId)
    // an eligible topic exists too: the resume pass must win over the claim pass
    seedTopic(db)
    const result = await produceNextTick(db, { channelsDir, runsRoot, stagesFor: readyStages })
    expect(result).toEqual({ action: 'resumed', jobId, tier: 'volume', status: 'ready' })
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

  it('releases the lease when the tick throws mid-flight', async () => {
    const { db, runsRoot } = setup()
    // an unparseable channel TOML makes loadChannelsDir throw inside the leased window
    const brokenDir = tmpDir('brainrot-loop-broken-')
    writeFileSync(join(brokenDir, 'broken.toml'), 'this is not toml [')
    await expect(
      produceNextTick(db, { channelsDir: brokenDir, runsRoot, stagesFor: neverStages }),
    ).rejects.toThrow()
    expect(acquireLease(db, 'produce', 'pid:probe', PRODUCE_LEASE_TTL_MS)).toBe(true)
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
      tier: 'volume',
      status: 'failed',
    })
    // claimed + bound to its failed job: the resume path owns recovery, the
    // topic is never re-claimed or lost
    const topic = db
      .prepare('SELECT status, job_id FROM topics WHERE id = ?')
      .get(topicId) as { status: string; job_id: string }
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
    const topic = db
      .prepare("SELECT status FROM topics WHERE dedupe_hash = 'h-repair'")
      .get() as { status: string }
    expect(topic.status).toBe('used')
    db.close()
  })
})

describe('produce-next CLI', () => {
  it('`produce-next --help` prints usage with --db/--channels-dir/--runs-root', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'produce-next', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--db')
    expect(result.stdout).toContain('--channels-dir')
    expect(result.stdout).toContain('--runs-root')
  }, 60000)

  it('`produce-next` with no eligible work prints one noop JSON line and exits 0', async () => {
    const root = tmpDir('brainrot-loop-cli-')
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce-next',
        '--db', join(root, 'brainrot.db'), '--channels-dir', channelsDir, '--runs-root', join(root, 'runs')],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    // exactly one cron-greppable JSON line
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout)).toEqual({ action: 'noop', reason: 'no-eligible-work' })
  }, 60000)
})
