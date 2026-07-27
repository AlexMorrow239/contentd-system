import { describe, expect, it } from 'vitest'
import { openDb } from './db/index.js'
import { runCli } from './testing/run-cli.js'
import { seedPublishRow, tmpDbPath } from './testing/cli.js'

/**
 * Covers `publish retry`/`publish mark-done` and `publishes list`.
 *
 * Split out of a single 742-line cli.test.ts that held 28 subprocess tests in
 * one describe alongside four pure-function suites. Beyond readability this is
 * a scheduling win: `it.concurrent` batches at maxConcurrency within ONE file,
 * so 28 spawns queued 8 at a time in a single worker; separate files spread
 * across workers instead.
 */
describe('brainrot CLI — publish and publishes', () => {
  it.concurrent(
    '`publish --help` lists the retry/mark-done subcommands',
    async () => {
      const result = await runCli(['publish', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('retry')
      expect(result.stdout).toContain('mark-done')
    },
    60000,
  )

  it.concurrent(
    '`publish retry` on a job with no interrupted publish exits 1 naming the job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publish', 'retry', 'no-such-job', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    },
    60000,
  )

  it.concurrent(
    '`publish retry` on a job with an interrupted publish clears it and returns the job to the pool',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-retry-1',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'interrupted',
      })
      const result = await runCli(['publish', 'retry', 'job-retry-1', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('job-retry-1')
      const db = openDb(dbPath)
      const row = db
        .prepare('SELECT status, error_kind, error FROM publishes WHERE job_id = ?')
        .get('job-retry-1') as { status: string; error_kind: string; error: string }
      db.close()
      expect(row.status).toBe('failed')
      expect(row.error_kind).toBe('transient')
      expect(row.error).toContain('manually cleared')
    },
    60000,
  )

  it.concurrent(
    '`publish mark-done` on a job with no interrupted publish exits 1 naming the job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli([
        'publish',
        'mark-done',
        'no-such-job',
        'yt-post-1',
        '--db',
        dbPath,
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('no interrupted publish for job no-such-job')
    },
    60000,
  )

  it.concurrent(
    '`publish mark-done` on a job with an interrupted publish marks it done and flips the library row',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-done-1',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'interrupted',
      })
      const result = await runCli([
        'publish',
        'mark-done',
        'job-done-1',
        'yt-post-1',
        '--db',
        dbPath,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('https://youtube.com/shorts/yt-post-1')
      const db = openDb(dbPath)
      const publishRow = db
        .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
        .get('job-done-1') as { status: string; post_id: string; url: string }
      const libraryRow = db
        .prepare('SELECT state FROM library WHERE job_id = ?')
        .get('job-done-1') as { state: string }
      db.close()
      expect(publishRow.status).toBe('done')
      expect(publishRow.post_id).toBe('yt-post-1')
      expect(publishRow.url).toBe('https://youtube.com/shorts/yt-post-1')
      expect(libraryRow.state).toBe('published')
    },
    60000,
  )

  it.concurrent(
    '`publishes --help` lists the list subcommand',
    async () => {
      const result = await runCli(['publishes', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('list')
    },
    60000,
  )

  it.concurrent(
    '`publishes list` on an empty db prints a friendly empty message',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publishes', 'list', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('no publishes in the last 7 days')
    },
    60000,
  )

  it.concurrent(
    '`publishes list` prints day/seq/channel/platform/status/attempt/jobId and the url or error',
    async () => {
      const dbPath = tmpDbPath()
      seedPublishRow(dbPath, {
        jobId: 'job-list-done',
        channel: 'demo',
        day: '2026-07-22',
        seq: 1,
        status: 'done',
        postId: 'yt-1',
        url: 'https://youtube.com/shorts/yt-1',
        attempt: 1,
      })
      seedPublishRow(dbPath, {
        jobId: 'job-list-failed',
        channel: 'demo',
        day: '2026-07-22',
        seq: 2,
        status: 'failed',
        error: 'upload rejected: bad file',
        errorKind: 'rejected',
        attempt: 2,
      })
      const result = await runCli(['publishes', 'list', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        '2026-07-22 #1 demo youtube done attempt 1 job-list-done https://youtube.com/shorts/yt-1',
      )
      expect(result.stdout).toContain(
        '2026-07-22 #2 demo youtube failed attempt 2 job-list-failed upload rejected: bad file',
      )
    },
    60000,
  )

  it.concurrent(
    '`publishes list --days garbage` exits 1 before opening the db',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(['publishes', 'list', '--days', 'garbage', '--db', dbPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('invalid --days "garbage"')
    },
    60000,
  )
})
