import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { Command } from 'commander'
import { errorMessage } from './errors.js'
import { loadChannelConfig, tryLoadChannelsDir } from './config/channel.js'
import { acquireLease, leaseHolder, releaseLease } from './loop/lease.js'
import { openDb } from './db/index.js'
import { pruneMedia } from './scout/prune-media.js'
import { listTopics, rejectTopics, requeueTopic } from './scout/topics.js'
import type { TopicStatus } from './scout/topics.js'
import { daySpendBreakdown } from './jobs/costs.js'
import { formatUsdMicros } from './money.js'
import { approveLibrary, listLibrary, rejectLibraryAndFreeObjects } from './jobs/library.js'
import type { LibraryState } from './jobs/library.js'
// storage/s3.js is imported dynamically at the commands that need it — a
// static import puts the AWS SDK on the startup path of every command.
// storage/config.js carries no SDK import, so this one is free.
import { s3ConfigError } from './storage/config.js'
import { resolveBrainrotPaths } from './config/paths.js'
import type { BrainrotPaths } from './config/paths.js'

/**
 * The pipeline, the runner, resume, the two loop ticks, the daemon and the
 * scout are all reached through `await import(...)` inside the actions that
 * need them, never statically at the top of this file. Between them they pull
 * Remotion, kokoro/edge-tts and the Anthropic client, which is ~310ms of
 * startup an operator running `brainrot jobs` or `brainrot topics list` would
 * otherwise pay to read three rows out of SQLite. Commander resolves one
 * action per invocation, so each command loads exactly the graph it runs.
 *
 * Keep it that way: a static import of any of those specifiers here silently
 * re-imposes the cost on every other command, and nothing fails to make it
 * visible.
 */

/**
 * Validate `topics reject`/`requeue` id arguments. Throws naming the FIRST bad
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

// Production pins the root in Compose; test subprocesses supply a temp root.
const ROOT_OPTION_DESC =
  'runtime root holding db/, runs/ and channels/ (required: flag or $BRAINROT_ROOT)'

/**
 * The one resolve → open → work → close sequence every db-touching command
 * runs. Half of them used to leak the handle (no close at all) and the other
 * half spelled the try/finally out again; both are this wrapper's job now.
 *
 * The finally is guarded rather than unconditional because `produce` closes
 * mid-action on purpose (see its comment) — a command may hand the handle
 * back already closed, and that must not be a double-close error.
 *
 * A command whose work must precede the db handle — `scout` loads its
 * channels first, deliberately — resolves paths itself and calls this after.
 */
async function withDb<T>(
  opts: { root?: string },
  fn: (db: Database, paths: BrainrotPaths) => T | Promise<T>,
): Promise<T> {
  const paths = resolveBrainrotPaths(opts.root)
  const db = openDb(paths.dbPath)
  try {
    return await fn(db, paths)
  } finally {
    if (db.open) db.close()
  }
}

/**
 * Prints the human-readable cause of a tick that could not run at all, on
 * stderr, beside the JSON line stdout gets — an operator grepping only for
 * `action` would otherwise see a bare `config-error` and no file name.
 *
 * This lives at the ONE-SHOT CLI, not inside the tick functions, and that is
 * the whole point: the same ticks now run under `brainrot run` every 30
 * seconds, where an unstructured print bypasses runWorker's idle dedupe and
 * turns one bad channel TOML into 2,880 stderr lines a day. The daemon
 * reports these through the deduped `{"action":"noop","reason":...}` line
 * instead; a one-shot invocation has a human reading its stderr right now.
 */
function reportBlockedTick(
  command: string,
  result: { action: string; reason?: string; error?: string },
): void {
  if (result.action !== 'noop') return
  if (result.reason !== 'config-error') return
  if (result.error !== undefined) console.error(`${command}: ${result.error}`)
}

const program = new Command()
program.name('brainrot').description('Brainrot Machine CLI')

program
  .command('produce')
  .requiredOption('--channel <path>', 'path to channel TOML')
  .requiredOption('--topic <text>', 'topic text')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { channel: string; topic: string; root?: string }) => {
    // Object storage is optional (src/stages/store.ts): warn, don't refuse.
    // The `store` stage runs last and simply no-ops with no S3 config, so an
    // unconfigured deployment still produces a normal ready/needs-review job
    // — it just has no cloud copy to hand to the (now manual) publish step.
    const storageError = s3ConfigError()
    if (storageError !== undefined) {
      console.error(`produce: ${storageError}`)
    }
    // Both before the db handle, as they were: a bad --channel path must
    // exit 1 without having opened (or created) a database.
    const channel = loadChannelConfig(opts.channel)
    const { pipelineStages } = await import('./jobs/pipeline.js')
    const { createJob, exitCodeFor, runJob } = await import('./jobs/runner.js')
    await withDb(opts, async (db, paths) => {
      const jobId = createJob(db, channel, { topic: opts.topic })
      const result = await runJob(db, channel, jobId, pipelineStages(), {
        runsRoot: paths.runsRoot,
      })
      // better-sqlite3 is synchronous, so close the handle now; nothing else keeps the
      // event loop alive, letting the process drain stdout and exit on its own.
      db.close()
      process.stdout.write(JSON.stringify(result) + '\n')
      // Set exitCode (not process.exit) so a piped stdout flushes fully before exit —
      // process.exit can truncate the JSON line mid-write. exit 0 for ready/needs-review;
      // exit 1 for failed AND blocked (the JSON line carries the finer distinction).
      process.exitCode = exitCodeFor(result)
    })
  })

program
  .command('scout')
  .option('--root <path>', ROOT_OPTION_DESC)
  .option('--force', 'bypass the per-channel scout recheck cooldown (SCOUT_RECHECK_MS)')
  .action(async (opts: { root?: string; force?: boolean }) => {
    const paths = resolveBrainrotPaths(opts.root)
    // Config load precedes the db handle AND the lease, exactly as in
    // produce-next: a broken channel TOML blocks the whole run either way,
    // and letting it throw meant exit 1 with NO JSON line every
    // firing — the one shape the cron log's every-tick-prints-a-line contract
    // cannot survive. The message also goes to stderr, since a line grepped
    // only for `action` would otherwise carry the cause silently. This is why
    // the load sits here rather than inside the withDb callback below.
    const loaded = tryLoadChannelsDir(paths.channelsDir)
    if (loaded.error !== undefined) {
      console.error(`scout: ${loaded.error}`)
      process.stdout.write(
        JSON.stringify({ action: 'noop', reason: 'config-error', error: loaded.error }) + '\n',
      )
      return
    }
    const channels = loaded.channels
    const { SCOUT_LEASE_TTL_MS, ScoutRunFailedError, scoutAll } = await import('./scout/scout.js')
    await withDb(opts, async (db) => {
      // Same lease discipline as the produce loop: two overlapping scout
      // runs would race the global-budget check and double-spend. A held lease is
      // a benign no-op, exit 0. The pid-tagged holder means an expiry takeover can
      // never be released by the evicted process (releaseLease matches on holder).
      const holder = leaseHolder()
      if (!acquireLease(db, 'scout', holder, SCOUT_LEASE_TTL_MS)) {
        process.stdout.write(JSON.stringify({ action: 'noop', reason: 'lease-held' }) + '\n')
        return
      }
      try {
        const results = await scoutAll(db, channels, { force: opts.force })
        // One cron-greppable JSON line; diagnostics went to stderr.
        process.stdout.write(JSON.stringify({ channels: results }) + '\n')
      } catch (err) {
        if (!(err instanceof ScoutRunFailedError)) throw err
        // A systemic run failure — every source dead (network down, Arctic
        // Shift outage) or every channel dead in scoring (expired key, provider
        // outage). Still one JSON line — the contract holds on failure outcomes —
        // then exit 1 so cron flags the run.
        process.stdout.write(JSON.stringify({ channels: err.results }) + '\n')
        console.error(err.message)
        process.exitCode = 1
      } finally {
        releaseLease(db, 'scout', holder)
      }
    })
  })

program
  .command('resume')
  .argument('<jobId>', 'job id to resume (failed or blocked; running needs --force)')
  .option('--root <path>', ROOT_OPTION_DESC)
  .option('--force', 'resume a job stuck in running (asserts no live process holds it)')
  .action(
    async (
      jobId: string,
      opts: {
        root?: string
        force?: boolean
      },
    ) => {
      const { resumeJob } = await import('./jobs/resume.js')
      const { exitCodeFor } = await import('./jobs/runner.js')
      await withDb(opts, async (db, paths) => {
        const result = await resumeJob(db, jobId, {
          runsRoot: paths.runsRoot,
          channelsDir: paths.channelsDir,
          force: opts.force,
        })
        process.stdout.write(JSON.stringify(result) + '\n')
        // Mirror produce: 0 for ready/needs-review, 1 for failed AND blocked.
        // A ResumeError skips the write and reaches the parseAsync catch (exit 1).
        process.exitCode = exitCodeFor(result)
      })
    },
  )

program
  .command('jobs')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    await withDb(opts, (db) => {
      const rows = db
        .prepare(
          'SELECT id, channel, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 20',
        )
        .all()
      console.table(rows)
    })
  })

program
  .command('costs')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    await withDb(opts, (db) => {
      // The window and its SQL belong to the ledger module; what stays here is
      // the presentation — money formatting and the table.
      const rows = daySpendBreakdown(db, 7)
      console.table(rows.map((r) => ({ day: r.day, usd: formatUsdMicros(r.micros) })))
    })
  })

program
  .command('produce-next')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    const { produceNextTick } = await import('./loop/produce-next.js')
    const { exitCodeFor } = await import('./jobs/runner.js')
    await withDb(opts, async (db, paths) => {
      const result = await produceNextTick(db, {
        channelsDir: paths.channelsDir,
        runsRoot: paths.runsRoot,
      })
      reportBlockedTick('produce-next', result)
      // One cron-greppable JSON line. Exit mirrors produce: 0 for
      // ready/needs-review and benign no-ops, 1 for failed AND blocked (the
      // JSON line carries the finer distinction). status is undefined on
      // noops, which is what the undefined check below lands on 0.
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode =
        result.status === undefined
          ? 0
          : exitCodeFor({ jobId: result.jobId ?? '', status: result.status })
    })
  })

program
  .command('run')
  .description('run the demand-driven daemon: produce and scout workers plus the daily digest')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    const { runDaemon } = await import('./loop/daemon.js')
    await withDb(opts, (db, paths) =>
      runDaemon(db, { channelsDir: paths.channelsDir, runsRoot: paths.runsRoot }),
    )
  })

// Operator veto (reject) and repair (requeue) over the scouted topic queue.
// Actions are thin: id validation lives in parseTopicIds, state transitions
// in the topics DAO.
const topics = program.command('topics')

topics
  .command('list')
  .option('--root <path>', ROOT_OPTION_DESC)
  .option('--channel <name>', 'filter by channel')
  .option('--status <status>', 'filter by topic status')
  .action(async (opts: { root?: string; channel?: string; status?: string }) => {
    await withDb(opts, (db) => {
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
  })

topics
  .command('reject <ids...>')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (rawIds: string[], opts: { root?: string }) => {
    const ids = parseTopicIds(rawIds)
    await withDb(opts, (db) => {
      const changed = rejectTopics(db, ids)
      // reject takes candidate only; claimed/used rows are skipped.
      console.log(`rejected ${changed} of ${ids.length}`)
    })
  })

topics
  .command('requeue <id>')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (rawId: string, opts: { root?: string }) => {
    // Same pre-db id validation as reject: a bad token throws to the
    // parseAsync .catch (message on stderr, exit 1) with no writes.
    const [id] = parseTopicIds([rawId])
    await withDb(opts, (db) => {
      const outcome = requeueTopic(db, id)
      if (outcome.ok) {
        process.stdout.write(JSON.stringify({ action: 'requeued', topicId: id }) + '\n')
        return
      }
      // Refusals keep the one-JSON-line contract (the guard's details live in
      // the line) and add the human sentence on stderr, mirroring `scout`.
      const refused = { action: 'refused' as const, topicId: id, reason: outcome.reason }
      if (outcome.reason === 'job-active') {
        process.stdout.write(
          JSON.stringify({ ...refused, jobId: outcome.jobId, jobStatus: outcome.jobStatus }) + '\n',
        )
        console.error(
          `topic ${id} is still held by job ${outcome.jobId} (${outcome.jobStatus}) — resolve that job first`,
        )
      } else if (outcome.reason === 'not-claimed') {
        process.stdout.write(JSON.stringify({ ...refused, status: outcome.status }) + '\n')
        console.error(`topic ${id} is "${outcome.status}", not "claimed" — nothing to requeue`)
      } else {
        process.stdout.write(JSON.stringify(refused) + '\n')
        console.error(`unknown topic id ${id}`)
      }
      process.exitCode = 1
    })
  })

topics
  .command('prune-media')
  .description('re-check scouted reddit candidates and reject image-sourced ones')
  .option('--root <path>', ROOT_OPTION_DESC)
  .option('--channel <name>', 'limit to one channel (default: all)')
  .option('--dry-run', 'report what would change without writing')
  .action(async (opts: { root?: string; channel?: string; dryRun?: boolean }) => {
    await withDb(opts, async (db) => {
      const dryRun = opts.dryRun === true
      // Reddit's rate limit forces ~20s per row, so this runs for minutes.
      // Report each row as it resolves — on stderr, so stdout keeps its single
      // JSON line — rather than going silent until the end and looking hung.
      const result = await pruneMedia(db, {
        channel: opts.channel,
        dryRun,
        onProgress: (p) =>
          console.error(`prune-media: [${p.index}/${p.total}] topic ${p.topicId}: ${p.outcome}`),
      })
      process.stdout.write(
        JSON.stringify({
          action: 'prune-media',
          dryRun,
          checked: result.checked,
          rejected: result.rejected,
          skipped: result.skipped.length,
        }) + '\n',
      )
    })
  })

// Operator gate over the produced-video library. Actions are thin: id
// validation lives in parseLibraryJobIds, state transitions in the library DAO.
const library = program.command('library')

library
  .command('list')
  .option('--root <path>', ROOT_OPTION_DESC)
  .option('--state <state>', 'filter by library state')
  .option('--channel <name>', 'filter by channel')
  .action(async (opts: { root?: string; state?: string; channel?: string }) => {
    await withDb(opts, (db) => {
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
          state: r.state,
          topic: r.topic,
          createdAt: r.createdAt,
        })),
      )
    })
  })

library
  .command('approve <jobIds...>')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (rawIds: string[], opts: { root?: string }) => {
    // jobIds parse BEFORE the db opens: an empty/whitespace token throws to
    // the parseAsync .catch (message on stderr, exit 1) with no writes.
    const jobIds = parseLibraryJobIds(rawIds)
    await withDb(opts, (db) => {
      const { approved, reclaimed } = approveLibrary(db, jobIds)
      // approved < jobIds.length flags ids that were not in 'needs-review' state.
      console.log(`approved ${approved} of ${jobIds.length}`)
      // A distinct diagnostic, because it is a distinct condition: the row was
      // approvable in every way except that its bytes are gone, so approving it
      // would have put an unpublishable video into the pool.
      if (reclaimed.length > 0) {
        console.error(
          `not approved — stored object already reclaimed, nothing left to publish: ${reclaimed.join(', ')} ` +
            `— retire with brainrot library reject ${reclaimed.join(' ')}`,
        )
        // Refusal is an outcome a wrapper has to see. exitCode rather than
        // process.exit for the same reason every other command here uses it: a
        // piped stdout must flush the line above first. Ids that were simply in
        // the wrong state stay exit 0 — `approved N of M` already says so, and
        // re-approving an already-approved id is a no-op, not a failure.
        process.exitCode = 1
      }
    })
  })

library
  .command('reject <jobIds...>')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (rawIds: string[], opts: { root?: string }) => {
    const jobIds = parseLibraryJobIds(rawIds)
    await withDb(opts, async (db) => {
      // The whole sequence — keys read before the state change, best-effort
      // deletes after — lives in the library module, shared with the
      // dashboard's `library.reject` action so the two cannot drift. What is
      // this command's own is where the warnings go and what prints.
      const result = await rejectLibraryAndFreeObjects({
        db,
        jobIds,
        warn: (message) => console.warn(message),
      })
      // reject takes needs-review AND ready; those are the only two states a
      // row can be pulled back from — there is no 'published' state any more.
      console.log(`rejected ${result.rejected} of ${result.requested}`)
      // A failure here leaves an orphaned object, which this warning line —
      // not an ObjectStore.list() sweep — is how you find.
      if (result.storageUnavailable !== undefined) {
        console.warn(
          `object storage unavailable, ${result.objects} object(s) left in place: ${result.storageUnavailable}`,
        )
      }
    })
  })

library
  .command('backfill-store')
  .description('upload finished videos that have no stored object yet')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    const { backfillStore } = await import('./jobs/backfill-store.js')
    await withDb(opts, async (db) => {
      const res = await backfillStore({
        db,
        store: (await import('./storage/s3.js')).storeFromEnv(),
      })
      console.log(`uploaded ${res.uploaded.length}, skipped ${res.skipped.length}`)
      for (const jobId of res.skipped) {
        console.log(`  skipped ${jobId}: local video file is gone, nothing to upload`)
      }
    })
  })

program
  .command('digest')
  .option('--root <path>', ROOT_OPTION_DESC)
  .action(async (opts: { root?: string }) => {
    // A report, not a check: nothing here may set a non-zero exit — cron
    // MAILTO should deliver whatever printed, so even a config/db error is
    // reported on stderr and the process still exits 0.
    try {
      const { buildDigest } = await import('./loop/digest.js')
      // A channels dir that fails to load used to take the entire report with
      // it (one stderr line, nothing else) — exactly when the operator needs
      // the report. Every sqlite-derived section still renders; the config
      // failure becomes the first action item instead. The catch below stays
      // for genuinely unexpected digest failures (a db that will not open).
      await withDb(opts, (db, paths) => {
        const loaded = tryLoadChannelsDir(paths.channelsDir)
        process.stdout.write(
          buildDigest(db, loaded.channels, { channelsError: loaded.error }) + '\n',
        )
      })
    } catch (err) {
      console.error(errorMessage(err))
    }
  })

// cli.test.ts imports argument parsers in-process, which must not
// fire the argv parser. Node (and tsx) set argv[1] to the executed script's
// resolved path, so this comparison is true exactly when cli.ts IS the entry
// script.
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  // A rejected action (bad --channel path, etc.) would otherwise print a raw
  // unhandled-rejection stack. Surface just the message and exit 1.
  program.parseAsync(process.argv).catch((err) => {
    console.error(errorMessage(err))
    process.exitCode = 1
  })
}
