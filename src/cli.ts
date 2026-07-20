import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { createJob, runJob } from './jobs/runner.js'
import { loadChannelConfig } from './config/channel.js'
import { openDb } from './db/index.js'
import { scriptStage } from './stages/script.js'
import { voiceStage } from './stages/voice.js'
import { captionsStage } from './stages/captions.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'
import { visualsPremiumStage } from './stages/visuals-premium.js'
import { assembleStage } from './stages/assemble.js'
import { qcStage } from './stages/qc.js'
import type { StageDef, Tier } from './jobs/types.js'

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

/**
 * Premium pre-flight: premium visuals require a fal key, so refuse the run
 * before any config load, db handle, or job row exists when FAL_KEY is absent —
 * a job that could only ever fail for a missing key should never be created.
 * ELEVENLABS_API_KEY is deliberately NOT required: premium voice falls back to
 * kokoro when it is unset. Exported so cli.test.ts can assert it in-process.
 */
export function assertPremiumPreflight(tier: Tier): void {
  if (tier === 'premium' && !process.env.FAL_KEY) {
    throw new Error(
      'premium tier requires FAL_KEY in the environment (see .env.example); aborting before any spend',
    )
  }
}

/**
 * The stage list for one produce run. Only the visuals slot branches by tier;
 * script/voice/captions/qc branch internally on ctx.tier. Exported so tests
 * can assert the premium wiring without spawning a subprocess.
 */
export function stagesForTier(tier: Tier): StageDef[] {
  return [
    scriptStage,
    voiceStage,
    captionsStage,
    tier === 'premium' ? visualsPremiumStage : visualsVolumeStage,
    assembleStage,
    qcStage(),
  ]
}

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
