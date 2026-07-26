import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { DEFAULT_SCOUT } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import { BudgetExceededError } from './costs.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'
import { createJob, runJob } from './runner.js'
import type { StoreArtifact } from '../stages/store.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'brainrot-run-'))
  const db = openDb(join(root, 'data', 'brainrot.db'))
  return { db, runsRoot: join(root, 'runs') }
}

function testChannel(): ChannelConfig {
  return {
    name: 'test',
    niche: ['space'],
    videosPerDay: 2,
    voice: { volume: 'af_heart' },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: ['assets/bg'],
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    scout: { ...DEFAULT_SCOUT },
    publish: null,
  }
}

function row<T>(db: Database, sql: string, ...params: unknown[]): T {
  return db.prepare(sql).get(...params) as T
}

// Fake happy-path stages: script writes script.json, assemble writes final.mp4,
// qc writes qc.json with the given pass flag, others drop a marker.
function buildStages(
  calls: StageName[],
  opts: { qcPassed: boolean } = { qcPassed: true },
): StageDef[] {
  return STAGE_ORDER.map((name) => ({
    name,
    async run(ctx: JobContext) {
      calls.push(name)
      if (name === 'script') {
        writeFileSync(
          ctx.artifactPath('script', 'script.json'),
          JSON.stringify({
            hook: 'Did you know?',
            segments: [{ text: 'Space is big.', visualDirection: 'stars' }],
            platformMeta: {
              youtube: { title: 'Space', description: 'd', hashtags: ['#space'] },
              tiktok: { title: 'Space', description: 'd', hashtags: ['#space'] },
              instagram: { title: 'Space', description: 'd', hashtags: ['#space'] },
            },
          }),
        )
      } else if (name === 'assemble') {
        writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
      } else if (name === 'qc') {
        writeFileSync(
          ctx.artifactPath('qc', 'qc.json'),
          JSON.stringify({ passed: opts.qcPassed, checks: [] }),
        )
      } else {
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      }
    },
  }))
}

describe('createJob', () => {
  it('inserts a queued job and seven pending stages', () => {
    const { db } = setup()
    const jobId = createJob(db, testChannel(), { topic: 'space' })
    expect(typeof jobId).toBe('string')
    expect(jobId.length).toBeGreaterThan(0)
    const job = row<{ channel: string; tier: string; topic: string; status: string }>(
      db,
      'SELECT channel, tier, topic, status FROM jobs WHERE id = ?',
      jobId,
    )
    expect(job).toEqual({ channel: 'test', tier: 'volume', topic: 'space', status: 'queued' })
    const stages = (
      db.prepare('SELECT stage FROM job_stages WHERE job_id = ? ORDER BY rowid').all(jobId) as {
        stage: string
      }[]
    ).map((r) => r.stage)
    expect(stages).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store'])
    const pending = row<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'pending'",
      jobId,
    )
    expect(pending).toEqual({ n: 7 })
  })
})

describe('runJob', () => {
  it('happy path: qc pass → library ready with videoPath and metadata', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls), { runsRoot })

    expect(result.status).toBe('ready')
    expect(result.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(existsSync(result.videoPath!)).toBe(true)
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store'])

    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'done'",
        jobId,
      ),
    ).toEqual({ n: 7 })
    const lib = row<{ state: string; video_path: string; metadata_json: string }>(
      db,
      'SELECT state, video_path, metadata_json FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.state).toBe('ready')
    expect(lib.video_path).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(JSON.parse(lib.metadata_json).youtube.title).toBe('Space')
  })

  it('qc fail → library needs-review, job still done', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls, { qcPassed: false }), {
      runsRoot,
    })

    expect(result.status).toBe('needs-review')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ state: string }>(db, 'SELECT state FROM library WHERE job_id = ?', jobId).state,
    ).toBe('needs-review')
  })

  it('middle-stage throw → job failed, later stages untouched, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const calls: StageName[] = []
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        calls.push(name)
        if (name === 'captions') throw new Error('boom captions')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('failed')
    expect(result.videoPath).toBeUndefined()
    expect(calls).toEqual(['script', 'voice', 'captions'])

    const status = (stage: StageName) =>
      row<{ status: string }>(
        db,
        'SELECT status FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        stage,
      ).status
    expect(status('script')).toBe('done')
    expect(status('voice')).toBe('done')
    expect(status('captions')).toBe('failed')
    expect(status('visuals')).toBe('pending')
    expect(status('assemble')).toBe('pending')
    expect(status('qc')).toBe('pending')

    expect(
      row<{ error: string }>(
        db,
        'SELECT error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'captions',
      ).error,
    ).toBe('boom captions')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('resume: pre-done stages are skipped and their run fns are not called', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    // Simulate a prior partial run: first two stages already done.
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)

    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls), { runsRoot })

    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc', 'store'])
    expect(result.status).toBe('ready')
    // script stage was skipped, so script.json was never written → metadata falls back to '{}'
    expect(
      row<{ metadata_json: string }>(
        db,
        'SELECT metadata_json FROM library WHERE job_id = ?',
        jobId,
      ).metadata_json,
    ).toBe('{}')
  })

  it('heartbeat fires once per stage actually run, never for skipped ones', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)

    const calls: StageName[] = []
    const heartbeat = vi.fn()
    await runJob(db, channel, jobId, buildStages(calls), { runsRoot, heartbeat })

    // The produce lease is kept alive by work, not by the clock: five stages
    // ran, so five extensions.
    expect(heartbeat).toHaveBeenCalledTimes(5)
  })

  it('a throwing heartbeat never kills the job', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const calls: StageName[] = []
    const heartbeat = vi.fn(() => {
      throw new Error('database is locked')
    })
    const result = await runJob(db, channel, jobId, buildStages(calls), { runsRoot, heartbeat })

    // Best-effort keep-alive: a failed extension risks a lease takeover, which
    // is exactly the pre-heartbeat behavior — not worth losing a live render.
    expect(result.status).toBe('ready')
    expect(calls).toEqual([...STAGE_ORDER])
  })

  it('artifactPath creates each stage directory on demand', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const seen: Record<string, boolean> = {}
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        const dir = join(runsRoot, jobId, name)
        seen[`${name}:before`] = existsSync(dir)
        const file = name === 'qc' ? 'qc.json' : name === 'assemble' ? 'final.mp4' : `${name}.txt`
        const p = ctx.artifactPath(name, file)
        seen[`${name}:after`] = existsSync(dir)
        writeFileSync(p, name === 'qc' ? JSON.stringify({ passed: true, checks: [] }) : 'x')
      },
    }))
    await runJob(db, channel, jobId, stages, { runsRoot })

    for (const name of STAGE_ORDER) {
      expect(seen[`${name}:before`]).toBe(false)
      expect(seen[`${name}:after`]).toBe(true)
    }
  })

  it('budget breach → job blocked, result blocked, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'script') throw new BudgetExceededError('per-video budget exceeded')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('blocked')
    expect(result.videoPath).toBeUndefined()
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'blocked',
    )
    expect(
      row<{ status: string; error: string }>(
        db,
        'SELECT status, error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'script',
      ),
    ).toEqual({ status: 'failed', error: 'per-video budget exceeded' })
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('rejects a path-traversal job id without creating anything outside runsRoot', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const root = dirname(runsRoot)
    await expect(runJob(db, channel, '../outside', buildStages([]), { runsRoot })).rejects.toThrow(
      /invalid job id/,
    )
    // The traversal target join(runsRoot, '../outside') === join(root, 'outside').
    expect(existsSync(join(root, 'outside'))).toBe(false)
  })

  it('is idempotent: a second runJob on a completed job returns cleanly with one library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })

    const first = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(first.status).toBe('ready')

    // Second run: every stage is already 'done', so the runner skips straight to the
    // final library upsert + job-done update. It must not throw a PRIMARY KEY conflict.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(second.status).toBe('ready')
    expect(second.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))

    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(1)
  })

  it('is idempotent even with a pre-seeded library row (crash before job marked done)', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })

    // Simulate a crash after the library row was written but before the job was
    // marked done: mark every stage done and pre-seed a stale library row.
    db.prepare("UPDATE job_stages SET status = 'done' WHERE job_id = ?").run(jobId)
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, '{}', 'needs-review')",
    ).run(jobId, join(runsRoot, jobId, 'assemble', 'final.mp4'))

    // qc.json must exist for the final gate; seed a passing one (stages are skipped).
    const qcDir = join(runsRoot, jobId, 'qc')
    mkdirSync(qcDir, { recursive: true })
    writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))

    const result = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(result.status).toBe('ready')
    const lib = row<{ n: number; state: string }>(
      db,
      'SELECT COUNT(*) AS n, MAX(state) AS state FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.n).toBe(1)
    expect(lib.state).toBe('ready') // upsert overwrote the stale 'needs-review'
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'done',
    )
  })

  it('final gate: corrupt qc.json → job failed in DB (not stuck running), no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'qc') {
          // The stage itself "succeeds" but leaves a corrupt artifact behind.
          writeFileSync(ctx.artifactPath('qc', 'qc.json'), 'not json {{{')
        } else {
          writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
        }
      },
    }))

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    const job = row<{ status: string; finished_at: string | null }>(
      db,
      'SELECT status, finished_at FROM jobs WHERE id = ?',
      jobId,
    )
    expect(job.status).toBe('failed')
    expect(job.finished_at).not.toBeNull()
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('final gate: missing qc.json → job failed in DB, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'qc') return // stage completes but never writes qc.json
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('final gate: corrupt script.json → job failed, not an unhandled throw', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'script') {
          writeFileSync(ctx.artifactPath('script', 'script.json'), '{ truncated')
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

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('resume after a failed stage clears the stale job_stages.error on success', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })

    // First run: captions blows up and records an error on its stage row.
    const failing: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'captions') throw new Error('boom captions')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const first = await runJob(db, channel, jobId, failing, { runsRoot })
    expect(first.status).toBe('failed')
    expect(
      row<{ error: string | null }>(
        db,
        'SELECT error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'captions',
      ).error,
    ).toBe('boom captions')

    // Resume with healthy stages: captions succeeds this time. Its stage row
    // must come out status='done' with the stale error cleared to NULL.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(second.status).toBe('ready')
    const captions = row<{ status: string; error: string | null }>(
      db,
      'SELECT status, error FROM job_stages WHERE job_id = ? AND stage = ?',
      jobId,
      'captions',
    )
    expect(captions.status).toBe('done')
    expect(captions.error).toBeNull()
  })
})

describe('final gate: library_objects', () => {
  // Stages identical to buildStages()'s happy path, but the store stage writes
  // a caller-supplied artifact (or nothing, to simulate a pre-storage job).
  function stagesWithStore(storeArtifact: StoreArtifact | null): StageDef[] {
    return STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'assemble') {
          writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
        } else if (name === 'qc') {
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        } else if (name === 'store') {
          if (storeArtifact !== null) {
            writeFileSync(ctx.artifactPath('store', 'store.json'), JSON.stringify(storeArtifact))
          }
        } else {
          writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
        }
      },
    }))
  }

  it('records the object row from store.json inside the library transaction', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const artifact: StoreArtifact = { objectKey: 'videos/test/job-1.mp4', bytes: 4096, etag: 'abc' }

    await runJob(db, channel, jobId, stagesWithStore(artifact), { runsRoot })

    const objectRow = row<{ objectKey: string; bytes: number; etag: string } | undefined>(
      db,
      'SELECT object_key AS objectKey, bytes, etag FROM library_objects WHERE job_id = ?',
      jobId,
    )
    expect(objectRow).toEqual(artifact)
  })

  // Jobs produced before this plan have no store.json. The gate must stay
  // survivable for them, exactly as it already tolerates a missing script.json.
  it('finishes the job with no object row when store.json is absent', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })

    const result = await runJob(db, channel, jobId, stagesWithStore(null), { runsRoot })

    expect(result.status).toBe('ready')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library_objects WHERE job_id = ?', jobId),
    ).toEqual({ n: 0 })
  })

  it('is idempotent when the gate runs a second time', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const artifact: StoreArtifact = { objectKey: 'videos/test/job-1.mp4', bytes: 4096, etag: 'abc' }

    await runJob(db, channel, jobId, stagesWithStore(artifact), { runsRoot })
    // Second call: every stage is already 'done', so this re-enters only the
    // final gate.
    await runJob(db, channel, jobId, stagesWithStore(artifact), { runsRoot })

    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library_objects WHERE job_id = ?', jobId),
    ).toEqual({ n: 1 })
  })
})
