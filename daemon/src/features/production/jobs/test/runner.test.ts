import type { Database } from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testChannel } from '../../../../../testing/channel.js'
import { fileDb } from '../../../../../testing/db.js'
import { createTestTime } from '../../../../../testing/time.js'
import { requireLease } from '../../../../infra/coordination/lease.js'
import type { StageName } from '../../../../shared/contracts/pipeline.js'
import { STAGE_ORDER } from '../../../../shared/contracts/pipeline.js'
import { tagError } from '../../../../shared/errors.js'
import type { StoryPart } from '../../../../shared/stories/types.js'
import { BudgetExceededError } from '../../../billing/costs.js'
import { claimTopic, insertTopics } from '../../../topics/mutations.js'
import { listTopics } from '../../../topics/queries.js'
import type { JobContext, StageDef } from '../../contracts.js'
import { createJob, runJob } from '../runner.js'

/** A real on-disk db plus a runs root beside it; both cleaned up per file. */
function setup() {
  const { db, root } = fileDb('data/contentd.db')
  return { db, runsRoot: join(root, 'runs') }
}

function row<T>(db: Database, sql: string, ...params: unknown[]): T {
  return db.prepare(sql).get(...params) as T
}

function committedArtifact(db: Database, jobId: string, stage: StageName, file: string): string {
  const { artifact_dir } = row<{ artifact_dir: string }>(
    db,
    'SELECT artifact_dir FROM job_stages WHERE job_id = ? AND stage = ?',
    jobId,
    stage,
  )
  expect(artifact_dir).toContain(join(jobId, 'attempts'))
  return join(artifact_dir, file)
}

// Fake happy-path stages: script writes script.json, assemble writes final.mp4,
// qc writes qc.json with the given pass flag, and the others drop a marker.
function buildStages(calls: StageName[], opts: { qcPassed?: boolean } = {}): StageDef[] {
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
          JSON.stringify({ passed: opts.qcPassed ?? true, checks: [] }),
        )
      } else {
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      }
    },
  }))
}

describe('createJob', () => {
  it('inserts a queued job and six pending stages', () => {
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
    expect(stages).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
    const pending = row<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'pending'",
      jobId,
    )
    expect(pending).toEqual({ n: 6 })
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
    expect(result.videoPath).toBe(committedArtifact(db, jobId, 'assemble', 'final.mp4'))
    expect(existsSync(result.videoPath!)).toBe(true)
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])

    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'done'",
        jobId,
      ),
    ).toEqual({ n: 6 })
    const lib = row<{ state: string; video_path: string; metadata_json: string }>(
      db,
      'SELECT state, video_path, metadata_json FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.state).toBe('ready')
    expect(lib.video_path).toBe(result.videoPath)
    expect(JSON.parse(lib.metadata_json).youtube.title).toBe('Space')
  })

  it('persists the whole qc verdict into library.qc_json', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    await runJob(db, channel, jobId, buildStages([], { qcPassed: false }), { runsRoot })

    const raw = readFileSync(committedArtifact(db, jobId, 'qc', 'qc.json'), 'utf8')
    const lib = row<{ qc_json: string }>(db, 'SELECT qc_json FROM library WHERE job_id = ?', jobId)
    // Re-serialized from the gate's own read, so content — not bytes — is the
    // contract: everything qc.json carries lands in the column.
    expect(JSON.parse(lib.qc_json)).toEqual(JSON.parse(raw))
    expect(JSON.parse(lib.qc_json)).toEqual({ passed: false, checks: [] })
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

    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc'])
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

  it('renews ownership while one stage runs beyond the lease TTL', async () => {
    const time = createTestTime(0)
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', time })
    const stages = buildStages([])
    const original = stages[0].run
    stages[0].run = async (ctx) => {
      await time.advanceBy(360_000)
      ctx.assertOwned!()
      await original(ctx)
    }
    expect(await runJob(db, channel, jobId, stages, { runsRoot, time })).toMatchObject({
      status: 'ready',
    })
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('rejects conflicting clocks before starting any stage', async () => {
    const time = createTestTime(0)
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', time })
    const lease = requireLease(db, 'produce', undefined, { time })
    const calls: StageName[] = []
    try {
      await expect(
        runJob(db, channel, jobId, buildStages(calls), {
          runsRoot,
          lease,
          time: createTestTime(0),
        }),
      ).rejects.toThrow('conflicting time sources')
      expect(calls).toEqual([])
      expect(db.prepare('SELECT * FROM execution_attempts').all()).toEqual([])
    } finally {
      lease.release()
    }
  })

  it('artifactPath creates each stage directory on demand', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })
    const seen: Record<string, boolean> = {}
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        const dir = join(ctx.runDir, name)
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
        if (name === 'script') throw new BudgetExceededError('global-day budget exceeded')
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
    ).toEqual({ status: 'failed', error: 'global-day budget exceeded' })
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

    // The persisted result must be returned without creating a new attempt.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(second.status).toBe('ready')
    expect(second.videoPath).toBe(first.videoPath)
    expect(
      db.prepare('SELECT id FROM execution_attempts WHERE job_id = ?').all(jobId),
    ).toHaveLength(1)

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
    const lib = row<{ n: number; state: string; qc_json: string | null }>(
      db,
      'SELECT COUNT(*) AS n, MAX(state) AS state, MAX(qc_json) AS qc_json FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.n).toBe(1)
    expect(lib.state).toBe('ready') // upsert overwrote the stale 'needs-review'
    // The DO UPDATE arm must write qc_json too, or exactly these crash-window
    // resumes would show "no qc verdict" forever.
    expect(lib.qc_json).toBe(JSON.stringify({ passed: true, checks: [] }))
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

  describe('stage failure classification', () => {
    it('parks a job blocked on any budget-kind failure, not just BudgetExceededError', async () => {
      // The old check was `instanceof BudgetExceededError`. The kind check is
      // deliberately wider: an error tagged job/budget means the same thing.
      const { db, runsRoot } = setup()
      const channel = testChannel()
      const jobId = createJob(db, channel, { topic: 'space' })
      const stages = [
        {
          name: 'script' as StageName,
          run: () => {
            throw tagError(new Error('global day cap reached'), {
              domain: 'job',
              kind: 'budget',
            })
          },
        },
      ]
      const result = await runJob(db, channel, jobId, stages, { runsRoot })
      expect(result.status).toBe('blocked')
      const row = db
        .prepare('SELECT error FROM job_stages WHERE job_id = ? AND stage = ?')
        .get(jobId, 'script') as { error: string }
      expect(row.error).toBe('global day cap reached')
    })

    it('parks a job failed on an unclassified throw', async () => {
      const { db, runsRoot } = setup()
      const channel = testChannel()
      const jobId = createJob(db, channel, { topic: 'space' })
      const stages = [
        {
          name: 'script' as StageName,
          run: () => {
            throw new Error('boom')
          },
        },
      ]
      const result = await runJob(db, channel, jobId, stages, { runsRoot })
      expect(result.status).toBe('failed')
    })
  })
})

describe('final gate: local library', () => {
  it('is idempotent when the gate runs a second time', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space' })

    await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    // Second call: every stage is already 'done', so this re-enters only the
    // final gate.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })

    expect(second.status).toBe('ready')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId),
    ).toEqual({ n: 1 })
  })
})

// The topic flip belongs to the write that makes it true, not to each
// caller's postlude — produce-next and resume no longer do it themselves, so
// the runner is the only place that still can.
describe('final gate: claimed topic', () => {
  const claimedTopicJob = (db: Database, channel: ReturnType<typeof testChannel>): string => {
    insertTopics(db, [
      {
        channel: channel.name,
        title: 'a scouted topic',
        rawTitle: 'a scouted topic',
        source: 'reddit:r/space',
        url: 'https://reddit.com/c/abc/',
        dedupeHash: 'h-used',
        score: 90,
        reason: 'r',
        status: 'candidate',
      },
    ])
    const jobId = createJob(db, channel, { topic: 'a scouted topic' })
    const [topic] = listTopics(db, { channel: channel.name })
    claimTopic(db, topic.id, jobId)
    return jobId
  }

  const topicStatus = (db: Database, jobId: string): string =>
    row<{ status: string }>(db, 'SELECT status FROM topics WHERE job_id = ?', jobId).status

  it('flips the claimed topic to used when the job lands in the library', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = claimedTopicJob(db, channel)

    await runJob(db, channel, jobId, buildStages([]), { runsRoot })

    expect(topicStatus(db, jobId)).toBe('used')
  })

  // needs-review is library-landed too: the video exists and cost money, so
  // its topic is consumed exactly as a passing one's is.
  it('flips the topic on a needs-review outcome as well', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = claimedTopicJob(db, channel)

    await runJob(db, channel, jobId, buildStages([], { qcPassed: false }), { runsRoot })

    expect(topicStatus(db, jobId)).toBe('used')
  })

  // A failed job keeps its topic 'claimed' and bound to the job — the resume
  // path owns recovery, so the topic is never re-claimed or lost.
  it('leaves the topic claimed when a stage fails', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = claimedTopicJob(db, channel)
    const stages = buildStages([]).map((s) =>
      s.name === 'voice' ? { name: s.name, run: () => Promise.reject(new Error('boom')) } : s,
    )

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('failed')
    expect(topicStatus(db, jobId)).toBe('claimed')
  })
})

describe('runJob story context', () => {
  it('resolves the story payload from the claimed topic row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel({ name: 'aita', story: { maxParts: 4 } })
    insertTopics(db, [
      {
        channel: 'aita',
        title: 'She blended the fruit (2/3)',
        rawTitle: 'AITA?',
        source: 'reddit:r/AmItheAsshole',
        url: 'https://reddit.com/c/abc/',
        dedupeHash: 'h2',
        score: 88,
        reason: 'r',
        status: 'candidate',
        bodyText: 'Then she called my mother.',
        seriesKey: 's',
        partIndex: 2,
        partCount: 3,
        truncated: true,
      },
    ])
    const jobId = createJob(db, channel, { topic: 'She blended the fruit (2/3)' })
    const [topic] = listTopics(db, { channel: 'aita' })
    claimTopic(db, topic.id, jobId)

    let seen: StoryPart | undefined
    const stage: StageDef = {
      name: 'script',
      run: async (ctx) => {
        seen = ctx.story
      },
    }
    await runJob(db, channel, jobId, [stage], { runsRoot })

    expect(seen).toEqual({
      bodyText: 'Then she called my mother.',
      partIndex: 2,
      partCount: 3,
      sourceUrl: 'https://reddit.com/c/abc/',
      truncated: true,
    })
  })

  it('leaves story undefined for a job with no topic row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'manual topic' })
    let seen: StoryPart | undefined = {
      bodyText: 'x',
      partIndex: 1,
      partCount: 1,
      sourceUrl: 'u',
      truncated: false,
    }
    const stage: StageDef = {
      name: 'script',
      run: async (ctx) => {
        seen = ctx.story
      },
    }
    await runJob(db, channel, jobId, [stage], { runsRoot })
    expect(seen).toBeUndefined()
  })
})
