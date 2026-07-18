import 'dotenv/config'
import { Command } from 'commander'
import { createJob, runJob } from './jobs/runner.js'
import { loadChannelConfig } from './config/channel.js'
import { openDb } from './db/index.js'
import { scriptStage } from './stages/script.js'
import { voiceStage } from './stages/voice.js'
import { captionsStage } from './stages/captions.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'
import { assembleStage } from './stages/assemble.js'
import { qcStage } from './stages/qc.js'
import type { Tier } from './jobs/types.js'

function resolveDbPath(flagDb?: string): string {
  return flagDb ?? process.env.BRAINROT_DB ?? 'data/brainrot.db'
}

const program = new Command()
program.name('brainrot').description('Brainrot Machine CLI')

program
  .command('produce')
  .requiredOption('--channel <path>', 'path to channel TOML')
  .requiredOption('--topic <text>', 'topic text')
  .option('--tier <tier>', 'quality tier', 'volume')
  .option('--db <path>', 'sqlite db path')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .action(async (opts: { channel: string; topic: string; tier: string; db?: string; runsRoot: string }) => {
    const channel = loadChannelConfig(opts.channel)
    const db = openDb(resolveDbPath(opts.db))
    const jobId = createJob(db, channel, { topic: opts.topic, tier: opts.tier as Tier })
    const stages = [
      scriptStage,
      voiceStage,
      captionsStage,
      visualsVolumeStage,
      assembleStage,
      qcStage(),
    ]
    const result = await runJob(db, channel, jobId, stages, { runsRoot: opts.runsRoot })
    process.stdout.write(JSON.stringify(result) + '\n')
    // exit 0 for ready/needs-review; exit 1 for failed AND blocked (the JSON line
    // above carries the ready/needs-review/failed/blocked distinction for tooling).
    process.exit(result.status === 'failed' || result.status === 'blocked' ? 1 : 0)
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

program.parseAsync(process.argv)
