import { Command } from 'commander'
import { loadChannelConfig } from '../../config/channel.js'
import { requireLease } from '../../infra/coordination/lease.js'
import { ROOT_OPTION_DESC, printJson, reportBlockedTick, withDb } from './context.js'
export function registerProductionCommands(program: Command): void {
  program
    .command('produce')
    .requiredOption('--channel <path>', 'path to channel TOML')
    .requiredOption('--topic <text>', 'topic text')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (opts: { channel: string; topic: string; root?: string }) => {
      // Both before the db handle, as they were: a bad --channel path must
      // exit 1 without having opened (or created) a database.
      const channel = loadChannelConfig(opts.channel)
      const { pipelineStages } = await import('../../features/production/pipeline.js')
      const { createJob, exitCodeFor, runJob } =
        await import('../../features/production/jobs/runner.js')
      await withDb(opts, async (db, paths) => {
        const lease = requireLease(db, 'produce')
        try {
          const jobId = db
            .transaction(() => {
              lease.assertOwned()
              return createJob(db, channel, { topic: opts.topic })
            })
            .immediate()
          const result = await runJob(db, channel, jobId, pipelineStages(), {
            runsRoot: paths.runsRoot,
            lease,
          })
          // better-sqlite3 is synchronous, so close the handle now; nothing else keeps the
          // event loop alive, letting the process drain stdout and exit on its own.
          printJson(result)
          // Set exitCode (not process.exit) so a piped stdout flushes fully before exit —
          // process.exit can truncate the JSON line mid-write. exit 0 for ready/needs-review;
          // exit 1 for failed AND blocked (the JSON line carries the finer distinction).
          process.exitCode = exitCodeFor(result)
        } finally {
          lease.release()
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
        const { resumeJob } = await import('../../features/production/jobs/resume.js')
        const { exitCodeFor } = await import('../../features/production/jobs/runner.js')
        await withDb(opts, async (db, paths) => {
          const result = await resumeJob(db, jobId, {
            runsRoot: paths.runsRoot,
            channelsDir: paths.channelsDir,
            force: opts.force,
          })
          printJson(result)
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
            'SELECT id, channel, status, created_at FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20',
          )
          .all()
        console.table(rows)
      })
    })

  program
    .command('produce-next')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (opts: { root?: string }) => {
      const { produceNextTick } = await import('../../features/production/produce-next.js')
      const { exitCodeFor } = await import('../../features/production/jobs/runner.js')
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
        printJson(result)
        process.exitCode =
          result.status === undefined
            ? 0
            : exitCodeFor({ jobId: result.jobId ?? '', status: result.status })
      })
    })
}
