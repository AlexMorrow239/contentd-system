import { describe, expect, it } from 'vitest'
import { openDb } from './db/index.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runCli } from './testing/run-cli.js'
import { tmpDir } from './testing/tmp.js'
import { tmpDbPath } from './testing/cli.js'

/**
 * Covers `scout`: help, the sourceless and broken channels dirs, and the lease.
 *
 * Split out of a single 742-line cli.test.ts that held 28 subprocess tests in
 * one describe alongside four pure-function suites. Beyond readability this is
 * a scheduling win: `it.concurrent` batches at maxConcurrency within ONE file,
 * so 28 spawns queued 8 at a time in a single worker; separate files spread
 * across workers instead.
 */
describe('brainrot CLI — scout', () => {
  // Plan-1-shape channel TOML with no [scout] table: loadChannelsDir parses it,
  // scoutAll skips it (DEFAULT_SCOUT has no sources) — the cheapest full E2E.
  const SCOUTLESS_TOML = [
    'name = "cli-scout-test"',
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

  it.concurrent(
    '`scout --help` prints usage with --db/--channels-dir',
    async () => {
      const result = await runCli(['scout', '--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('--db')
      expect(result.stdout).toContain('--channels-dir')
    },
    60000,
  )

  it.concurrent(
    '`scout` over a sourceless channels dir prints one JSON line and exits 0',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-channels-')
      // filename must equal the channel name (loadChannelsDir invariant)
      writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const result = await runCli(['scout', '--db', dbPath, '--channels-dir', channelsDir])
      expect(result.exitCode).toBe(0)
      // exactly one cron-greppable JSON line on stdout
      expect(JSON.parse(result.stdout)).toEqual({ channels: [] })
    },
    60000,
  )

  // The same G14 symptom the two loops already fixed: a broken channels dir
  // used to exit 1 with an empty stdout, punching a hole in the cron log of
  // JSON lines every scout firing until someone noticed.
  it.concurrent(
    '`scout` over a broken channels dir still prints one JSON line and exits 0',
    async () => {
      const dbPath = tmpDbPath()
      const brokenDir = tmpDir('brainrot-scout-broken-')
      writeFileSync(path.join(brokenDir, 'broken.toml'), 'this is not toml [')
      const result = await runCli(['scout', '--db', dbPath, '--channels-dir', brokenDir])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      const line = JSON.parse(result.stdout) as { action: string; reason: string; error: string }
      expect(line.action).toBe('noop')
      expect(line.reason).toBe('config-error')
      expect(line.error).toContain('broken.toml')
      // stderr keeps the cause visible where the JSON line is only grepped
      expect(result.stderr).toContain('broken.toml')
      // The failure precedes the lease: nothing was leased on a config's behalf.
      const after = openDb(dbPath)
      const leases = after.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      after.close()
      expect(leases).toEqual({ n: 0 })
    },
    60000,
  )

  it.concurrent(
    '`scout` no-ops under a held lease, and releases its own lease on a clean run',
    async () => {
      const dbPath = tmpDbPath()
      const channelsDir = tmpDir('brainrot-scout-lease-')
      writeFileSync(path.join(channelsDir, 'cli-scout-test.toml'), SCOUTLESS_TOML)
      const seeded = openDb(dbPath)
      seeded
        .prepare('INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)')
        .run('scout', 'pid:999999', new Date(Date.now() + 600_000).toISOString())
      seeded.close()

      const args = ['scout', '--db', dbPath, '--channels-dir', channelsDir]
      const held = await runCli(args)
      // A held lease is the normal overlap case: benign one-line noop, exit 0.
      expect(held.exitCode).toBe(0)
      expect(JSON.parse(held.stdout)).toEqual({ action: 'noop', reason: 'lease-held' })
      const afterNoop = openDb(dbPath)
      const foreign = afterNoop.prepare("SELECT holder FROM leases WHERE name = 'scout'").get() as {
        holder: string
      }
      // the other holder's lease is untouched
      expect(foreign.holder).toBe('pid:999999')
      afterNoop.prepare("DELETE FROM leases WHERE name = 'scout'").run()
      afterNoop.close()

      const free = await runCli(args)
      expect(free.exitCode).toBe(0)
      expect(JSON.parse(free.stdout)).toEqual({ channels: [] })
      const afterRun = openDb(dbPath)
      const leases = afterRun.prepare("SELECT COUNT(*) AS n FROM leases WHERE name = 'scout'").get()
      afterRun.close()
      expect(leases).toEqual({ n: 0 })
    },
    60000,
  )
})
