import { describe, expect, it } from 'vitest'
import { openDb } from './db/index.js'
import { runCli } from './testing/run-cli.js'
import { storageEnvVars } from './testing/storage.js'
import { countJobs, tmpDbPath } from './testing/cli.js'

/**
 * Covers `jobs` and `produce`, plus the shared --help surface.
 *
 * Split out of a single 742-line cli.test.ts that held 28 subprocess tests in
 * one describe alongside four pure-function suites. Beyond readability this is
 * a scheduling win: `it.concurrent` batches at maxConcurrency within ONE file,
 * so 28 spawns queued 8 at a time in a single worker; separate files spread
 * across workers instead.
 */
describe('brainrot CLI — jobs and produce', () => {
  it.concurrent(
    '`jobs` opens the db and prints a table header, exiting 0',
    async () => {
      const dbPath = tmpDbPath()
      // Seed one job so console.table renders column headers (empty tables print nothing).
      const db = openDb(dbPath)
      db.prepare(
        "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1', 'example', 'volume', 'venus', 'queued')",
      ).run()
      db.close()

      const result = await runCli(['jobs', '--db', dbPath])
      expect(result.exitCode).toBe(0)
      // console.table header row names the selected columns.
      expect(result.stdout).toContain('status')
    },
    60000,
  )

  it.concurrent(
    '`produce --help` prints usage with --channel/--topic',
    async () => {
      const result = await runCli(['produce', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--channel')
      expect(result.stdout).toContain('--topic')
    },
    60000,
  )

  it.concurrent(
    '`produce --help` lists --dev',
    async () => {
      const result = await runCli(['produce', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`resume --help` lists --dev',
    async () => {
      const result = await runCli(['resume', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--dev')
    },
    60000,
  )

  it.concurrent(
    '`produce` with a nonexistent --channel exits 1 with a clean one-line error (no stack)',
    async () => {
      const dbPath = tmpDbPath()
      // Storage env passed explicitly: produce gates on it before opening the
      // channel file, so without this the assertion below depends on whether
      // the machine happens to have a .env.
      const result = await runCli(
        ['produce', '--channel', '/no/such/channel.toml', '--topic', 'venus', '--db', dbPath],
        { env: storageEnvVars() },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/ENOENT|no such file/)
      // Just the message — no raw unhandled-rejection stack frames ("    at ...").
      expect(result.stderr).not.toMatch(/\n\s+at /)
      expect(countJobs(dbPath)).toBe(0)
    },
    60000,
  )

  // The `store` stage runs last, so an unconfigured deployment would otherwise
  // pay for a full Remotion render and only then fail. Object storage is
  // required (design spec §3.5) — so refuse up front, before any job row.
  it.concurrent(
    '`produce` exits 1 naming the missing storage keys, before creating a job',
    async () => {
      const dbPath = tmpDbPath()
      const result = await runCli(
        ['produce', '--channel', 'channels/test.toml', '--topic', 'venus', '--db', dbPath],
        // Empty, not absent: dotenv does not override a key already present in
        // the child env, so this holds whether or not the machine has a .env
        // with real R2 credentials in it.
        {
          env: {
            BRAINROT_S3_ENDPOINT: '',
            BRAINROT_S3_BUCKET: '',
            BRAINROT_S3_ACCESS_KEY_ID: '',
            BRAINROT_S3_SECRET_ACCESS_KEY: '',
          },
        },
      )
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('BRAINROT_S3_BUCKET')
      expect(result.stderr).toContain('object storage is not configured')
      expect(countJobs(dbPath)).toBe(0)
    },
    60000,
  )
})
