import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { createJob, runJob } from './jobs/runner.js'
import { resumeJob } from './jobs/resume.js'
import { loadChannelConfig, loadChannelsDir } from './config/channel.js'
import { AllSourcesFailedError, scoutAll } from './scout/scout.js'
import { produceNextTick } from './loop/produce-next.js'
import { publishNextTick } from './loop/publish-next.js'
import { buildDigest } from './loop/digest.js'
import { openDb } from './db/index.js'
import { approveTopics, listTopics, rejectTopics } from './scout/topics.js'
import type { TopicStatus } from './scout/topics.js'
import { assertPremiumPreflight, stagesForTier } from './jobs/pipeline.js'
import type { Tier } from './jobs/types.js'
import { approveLibrary, listLibrary, rejectLibrary } from './jobs/library.js'
import type { LibraryState } from './jobs/library.js'
import { runYoutubeAuthFlow } from './publish/oauth-flow.js'
import { parseTokenKey } from './publish/crypto.js'
import { upsertToken } from './publish/tokens.js'

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
 * Validate `topics approve/reject` id arguments. Throws naming the FIRST bad
 * token, BEFORE any db handle exists, so one typo means exit 1 with no writes.
 * Canonical positive decimal integers only — "0", "-3", "12abc" all reject.
 * Exported so cli.test.ts can assert it in-process.
 */
export function parseTopicIds(raw: string[]): number[] {
  return raw.map((token) => {
    if (!/^[1-9]\d*$/.test(token)) {
      throw new Error(`invalid topic id "${token}": ids must be positive integers`)
    }
    return Number(token)
  })
}

/**
 * Validate `library approve/reject` id arguments. jobIds are nanoid strings
 * (unlike topic ids, no numeric parsing) — the only invalid token is
 * empty/whitespace-only. Throws naming the FIRST bad token, BEFORE any db
 * handle exists, so one typo means exit 1 with no writes. Exported so
 * library.test.ts can assert it in-process.
 */
export function parseLibraryJobIds(raw: string[]): string[] {
  return raw.map((token) => {
    if (/^\s*$/.test(token)) {
      throw new Error(`invalid job id "${token}": ids must not be empty or whitespace`)
    }
    return token
  })
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

program
  .command('publish-next')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .option('--dry-run', 'preview the next publish without writing anything')
  .action(async (opts: { db?: string; channelsDir: string; dryRun?: boolean }) => {
    const db = openDb(resolveDbPath(opts.db))
    try {
      const result = await publishNextTick(db, { channelsDir: opts.channelsDir, dryRun: opts.dryRun })
      // One cron-greppable JSON line. Exit 1 only for a completed-but-failed
      // upload attempt (the video stays 'ready' for the next slot); every
      // noop and dry-run preview is a benign exit 0.
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = result.action === 'publish-failed' ? 1 : 0
    } finally {
      db.close()
    }
  })

// Operator gate over the scouted topic queue. Actions are thin: id validation
// lives in parseTopicIds, state transitions in the topics DAO.
const topics = program.command('topics')

topics
  .command('list')
  .option('--db <path>', 'sqlite db path')
  .option('--channel <name>', 'filter by channel')
  .option('--status <status>', 'filter by topic status')
  .action((opts: { db?: string; channel?: string; status?: string }) => {
    const db = openDb(resolveDbPath(opts.db))
    // An unknown --status matches no rows (the DAO filters verbatim), so the
    // operator sees an empty table rather than an error.
    const rows = listTopics(db, {
      channel: opts.channel,
      status: opts.status as TopicStatus | undefined,
    })
    console.table(
      rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        score: r.score,
        status: r.status,
        title: r.title,
        reason: r.reason,
      })),
    )
  })

topics
  .command('approve <ids...>')
  .option('--db <path>', 'sqlite db path')
  .action((rawIds: string[], opts: { db?: string }) => {
    // Ids parse BEFORE the db opens: a bad token throws to the parseAsync
    // .catch (message on stderr, exit 1) with no writes.
    const ids = parseTopicIds(rawIds)
    const db = openDb(resolveDbPath(opts.db))
    const changed = approveTopics(db, ids)
    // changed < ids.length flags ids that were not in 'candidate' state.
    console.log(`approved ${changed} of ${ids.length}`)
  })

topics
  .command('reject <ids...>')
  .option('--db <path>', 'sqlite db path')
  .action((rawIds: string[], opts: { db?: string }) => {
    const ids = parseTopicIds(rawIds)
    const db = openDb(resolveDbPath(opts.db))
    const changed = rejectTopics(db, ids)
    // reject takes candidate AND approved; claimed/used rows are skipped.
    console.log(`rejected ${changed} of ${ids.length}`)
  })

// Operator gate over the produced-video library. Actions are thin: id
// validation lives in parseLibraryJobIds, state transitions in the library DAO.
const library = program.command('library')

library
  .command('list')
  .option('--db <path>', 'sqlite db path')
  .option('--state <state>', 'filter by library state')
  .option('--channel <name>', 'filter by channel')
  .action((opts: { db?: string; state?: string; channel?: string }) => {
    const db = openDb(resolveDbPath(opts.db))
    // An unknown --state matches no rows (the DAO filters verbatim), so the
    // operator sees an empty table rather than an error.
    const rows = listLibrary(db, {
      state: opts.state as LibraryState | undefined,
      channel: opts.channel,
    })
    console.table(
      rows.map((r) => ({
        jobId: r.jobId,
        channel: r.channel,
        tier: r.tier,
        state: r.state,
        topic: r.topic,
        createdAt: r.createdAt,
      })),
    )
  })

library
  .command('approve <jobIds...>')
  .option('--db <path>', 'sqlite db path')
  .action((rawIds: string[], opts: { db?: string }) => {
    // jobIds parse BEFORE the db opens: an empty/whitespace token throws to
    // the parseAsync .catch (message on stderr, exit 1) with no writes.
    const jobIds = parseLibraryJobIds(rawIds)
    const db = openDb(resolveDbPath(opts.db))
    const changed = approveLibrary(db, jobIds)
    // changed < jobIds.length flags ids that were not in 'needs-review' state.
    console.log(`approved ${changed} of ${jobIds.length}`)
  })

library
  .command('reject <jobIds...>')
  .option('--db <path>', 'sqlite db path')
  .action((rawIds: string[], opts: { db?: string }) => {
    const jobIds = parseLibraryJobIds(rawIds)
    const db = openDb(resolveDbPath(opts.db))
    const changed = rejectLibrary(db, jobIds)
    // reject takes needs-review AND ready; published rows are skipped.
    console.log(`rejected ${changed} of ${jobIds.length}`)
  })

// Interactive per-channel OAuth grant (design spec §4.2). Thin glue: all flow
// logic and error taxonomy live in runYoutubeAuthFlow; this action only
// resolves the channel/env inputs around it and persists the result.
const auth = program.command('auth')

auth
  .command('youtube')
  .requiredOption('--channel <name>', 'channel name to authorize')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .action(async (opts: { channel: string; db?: string; channelsDir: string }) => {
    // Channel + env checks precede any db handle or browser launch, so a typo
    // or missing credential fails clean before Alex is asked to click through
    // a Google consent screen.
    const channels = loadChannelsDir(opts.channelsDir)
    const channel = channels.find((c) => c.name === opts.channel)
    if (!channel) {
      throw new Error(`auth youtube: unknown channel "${opts.channel}" (checked ${opts.channelsDir})`)
    }
    const key = parseTokenKey(process.env.BRAINROT_TOKEN_KEY)
    const clientId = process.env.YT_CLIENT_ID
    if (!clientId) {
      throw new Error('auth youtube: YT_CLIENT_ID is not set (add it to .env)')
    }
    const clientSecret = process.env.YT_CLIENT_SECRET
    if (!clientSecret) {
      throw new Error('auth youtube: YT_CLIENT_SECRET is not set (add it to .env)')
    }
    const granted = await runYoutubeAuthFlow({ clientId, clientSecret })
    const db = openDb(resolveDbPath(opts.db))
    try {
      upsertToken(db, 'youtube', channel.name, granted.refreshToken, granted.scopes, key)
    } finally {
      db.close()
    }
    // Confirmation only — never the refresh token itself (house rule: token
    // material never touches logs or stdout).
    console.log(`authorized youtube for channel "${channel.name}" — scopes: ${granted.scopes}`)
  })

program
  .command('digest')
  .option('--db <path>', 'sqlite db path')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .action((opts: { db?: string; channelsDir: string }) => {
    // A report, not a check: nothing here may set a non-zero exit — cron
    // MAILTO should deliver whatever printed, so even a config/db error is
    // reported on stderr and the process still exits 0.
    try {
      const channels = loadChannelsDir(opts.channelsDir)
      const db = openDb(resolveDbPath(opts.db))
      try {
        process.stdout.write(buildDigest(db, channels) + '\n')
      } finally {
        db.close()
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
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
