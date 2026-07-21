import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { createJob, runJob } from './jobs/runner.js'
import { resumeJob } from './jobs/resume.js'
import { loadChannelConfig, loadChannelsDir } from './config/channel.js'
import { AllSourcesFailedError, scoutAll } from './scout/scout.js'
import { produceNextTick } from './loop/produce-next.js'
import { openDb } from './db/index.js'
import { assertPremiumPreflight, stagesForTier } from './jobs/pipeline.js'
import type { Tier } from './jobs/types.js'

const TIERS: readonly Tier[] = ['volume', 'premium']

/**
 * Validate a --tier flag value. Throws (naming every valid tier) on anything
 * else, BEFORE any db handle or job row is created, so an unsupported tier
 * fails clean rather than deep in a run. The thrown message is surfaced by
 * the parseAsync .catch below (exit 1).
 */
export function parseTier(raw: string): Tier {
  if (!(TIERS as readonly string[]).includes(raw)) {
    throw new Error(
      `unsupported --tier "${raw}": valid tiers are ${TIERS.map((t) => `"${t}"`).join(', ')}`,
    )
  }
  return raw as Tier
}

// Moved to src/jobs/pipeline.ts so the loop code (resume, produce-next) shares
// the exact produce wiring; re-exported so in-process importers (cli.test.ts)
// keep their import path.
export { stagesForTier, assertPremiumPreflight } from './jobs/pipeline.js'

function resolveDbPath(flagDb?: string): string {
  return flagDb ?? process.env.BRAINROT_DB ?? 'data/brainrot.db'
}

const program = new Command()
program.name('brainrot').description('Brainrot Machine CLI')

program
  .command('produce')
  .requiredOption('--channel <path>', 'path to channel TOML')
  .requiredOption('--topic <text>', 'topic text')
  .option('--tier <tier>', 'quality tier: volume | premium', 'volume')
  .option('--db <path>', 'sqlite db path')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .action(async (opts: { channel: string; topic: string; tier: string; db?: string; runsRoot: string }) => {
    const tier = parseTier(opts.tier)
    assertPremiumPreflight(tier)
    const channel = loadChannelConfig(opts.channel)
    const db = openDb(resolveDbPath(opts.db))
    const jobId = createJob(db, channel, { topic: opts.topic, tier })
    const result = await runJob(db, channel, jobId, stagesForTier(tier), { runsRoot: opts.runsRoot })
    // better-sqlite3 is synchronous, so close the handle now; nothing else keeps the
    // event loop alive, letting the process drain stdout and exit on its own.
    db.close()
    process.stdout.write(JSON.stringify(result) + '\n')
    // Set exitCode (not process.exit) so a piped stdout flushes fully before exit —
    // process.exit can truncate the JSON line mid-write. exit 0 for ready/needs-review;
    // exit 1 for failed AND blocked (the JSON line carries the finer distinction).
    process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
  })

program
  .command('scout')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .action(async (opts: { db?: string; channelsDir: string }) => {
    // Config load precedes the db handle so a bad channels dir fails clean.
    const channels = loadChannelsDir(opts.channelsDir)
    const db = openDb(resolveDbPath(opts.db))
    try {
      const results = await scoutAll(db, channels)
      // One cron-greppable JSON line; diagnostics went to stderr.
      process.stdout.write(JSON.stringify({ channels: results }) + '\n')
    } catch (err) {
      if (!(err instanceof AllSourcesFailedError)) throw err
      // Total source failure is systemic (network down, Reddit blocking):
      // still one JSON line — the contract holds on failure outcomes — then
      // exit 1 so cron flags the run.
      process.stdout.write(JSON.stringify({ channels: err.results }) + '\n')
      console.error(err.message)
      process.exitCode = 1
    } finally {
      db.close()
    }
  })

program
  .command('resume')
  .argument('<jobId>', 'job id to resume (failed or blocked; running needs --force)')
  .option('--db <path>', 'sqlite db path')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .option('--force', 'resume a job stuck in running (asserts no live process holds it)')
  .action(
    async (
      jobId: string,
      opts: { db?: string; runsRoot: string; channelsDir: string; force?: boolean },
    ) => {
      const db = openDb(resolveDbPath(opts.db))
      try {
        const result = await resumeJob(db, jobId, {
          runsRoot: opts.runsRoot,
          channelsDir: opts.channelsDir,
          force: opts.force,
        })
        process.stdout.write(JSON.stringify(result) + '\n')
        // Mirror produce: 0 for ready/needs-review, 1 for failed AND blocked.
        // A ResumeError skips the write and reaches the parseAsync catch (exit 1).
        process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
      } finally {
        db.close()
      }
    },
  )

program
  .command('jobs')
  .option('--db <path>', 'sqlite db path')
  .action((opts: { db?: string }) => {
    const db = openDb(resolveDbPath(opts.db))
    const rows = db
      .prepare('SELECT id, channel, tier, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 20')
      .all()
    console.table(rows)
  })

program
  .command('costs')
  .option('--db <path>', 'sqlite db path')
  .action((opts: { db?: string }) => {
    const db = openDb(resolveDbPath(opts.db))
    const rows = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, SUM(usd_micros) AS micros
         FROM costs
         WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
         GROUP BY day
         ORDER BY day DESC`,
      )
      .all() as { day: string; micros: number }[]
    console.table(rows.map((r) => ({ day: r.day, usd: `$${(r.micros / 1e6).toFixed(2)}` })))
  })

program
  .command('produce-next')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .action(async (opts: { db?: string; channelsDir: string; runsRoot: string }) => {
    const db = openDb(resolveDbPath(opts.db))
    try {
      const result = await produceNextTick(db, {
        channelsDir: opts.channelsDir,
        runsRoot: opts.runsRoot,
      })
      // One cron-greppable JSON line. Exit mirrors produce: 0 for
      // ready/needs-review and benign no-ops, 1 for failed AND blocked (the
      // JSON line carries the finer distinction). status is undefined on
      // noops, so the ternary lands on 0 for them.
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
    } finally {
      db.close()
    }
  })

// cli.test.ts imports parseTier/stagesForTier in-process, which must not fire
// the argv parser. Node (and tsx) set argv[1] to the executed script's resolved
// path, so this comparison is true exactly when cli.ts IS the entry script.
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  // A rejected action (bad --channel path, unsupported --tier, etc.) would otherwise
  // print a raw unhandled-rejection stack. Surface just the message and exit 1.
  program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
