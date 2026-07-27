import { describe, expect, it } from 'vitest'
import { openDb } from './db/index.js'
import { runCli } from './testing/run-cli.js'
import { tmpDbPath } from './testing/cli.js'

/**
 * Covers `topics`, mostly the `requeue` repair path.
 *
 * Split out of a single 742-line cli.test.ts that held 28 subprocess tests in
 * one describe alongside four pure-function suites. Beyond readability this is
 * a scheduling win: `it.concurrent` batches at maxConcurrency within ONE file,
 * so 28 spawns queued 8 at a time in a single worker; separate files spread
 * across workers instead.
 */
describe('brainrot CLI — topics', () => {
  it.concurrent(
    '`topics --help` lists the list/reject/requeue subcommands',
    async () => {
      const result = await runCli(['topics', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('reject')
      expect(result.stdout).toContain('requeue')
      expect(result.stdout).not.toContain('approve')
    },
    60000,
  )

  // Claimed topic + (optionally) the job holding it — the state `topics
  // requeue` exists to repair.
  function seedClaimedTopic(dbPath: string, opts: { jobId: string; jobStatus?: string }): number {
    const db = openDb(dbPath)
    if (opts.jobStatus !== undefined) {
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, 'demo', 'volume', 'venus', ?)",
      ).run(opts.jobId, opts.jobStatus)
    }
    const res = db
      .prepare(
        'INSERT INTO topics (channel, title, raw_title, source, url, dedupe_hash, score, reason, status, job_id) ' +
          "VALUES ('demo', 'T', 'R', 'reddit:r/space', 'https://example.com/1', 'h1', 80, 'seeded', 'claimed', ?)",
      )
      .run(opts.jobId)
    db.close()
    return Number(res.lastInsertRowid)
  }

  it.concurrent(
    '`topics requeue` returns an orphaned claimed topic to the queue',
    async () => {
      const dbPath = tmpDbPath()
      const id = seedClaimedTopic(dbPath, { jobId: 'job-stranded', jobStatus: 'failed' })
      const result = await runCli(['topics', 'requeue', String(id), '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ action: 'requeued', topicId: id })
      const db = openDb(dbPath)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      db.close()
      expect(row).toEqual({ status: 'candidate', job_id: null })
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` refuses while a live job holds the topic, naming the job',
    async () => {
      const dbPath = tmpDbPath()
      const id = seedClaimedTopic(dbPath, { jobId: 'job-live', jobStatus: 'running' })
      const result = await runCli(['topics', 'requeue', String(id), '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'refused',
        topicId: id,
        reason: 'job-active',
        jobId: 'job-live',
        jobStatus: 'running',
      })
      expect(result.stderr).toContain('job-live')
      const db = openDb(dbPath)
      const row = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(id) as {
        status: string
        job_id: string | null
      }
      db.close()
      expect(row).toEqual({ status: 'claimed', job_id: 'job-live' })
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` on an unknown id exits 1 with one JSON line and no stack',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['topics', 'requeue', '9999', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        action: 'refused',
        topicId: 9999,
        reason: 'unknown',
      })
      expect(result.stderr).not.toMatch(/\n\s+at /)
    },
    60000,
  )

  it.concurrent(
    '`topics requeue` rejects a non-integer id before opening the db',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['topics', 'requeue', 'abc', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid topic id "abc"')
    },
    60000,
  )
})
