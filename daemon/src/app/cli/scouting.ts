import { Command } from 'commander'
import { configErrorNoop, tryLoadChannelsDir } from '../../config/channel.js'
import { resolveBrainrotPaths } from '../../config/paths.js'
import { acquireManagedLease } from '../../infra/coordination/lease.js'
import { ROOT_OPTION_DESC, printJson, reportBlockedTick, withDb } from './context.js'
export function registerScoutingCommands(program: Command): void {
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
        const result = configErrorNoop(loaded.error)
        reportBlockedTick('scout', result)
        printJson(result)
        return
      }
      const channels = loaded.channels
      const { ScoutRunFailedError, scoutAll } = await import('../../features/scouting/run.js')
      await withDb(opts, async (db) => {
        // Same lease discipline as the produce loop: two overlapping scout
        // runs would race the global-budget check and double-spend. A held lease is
        // a benign no-op, exit 0. The pid-tagged holder means an expiry takeover can
        // never be released by the evicted process (releaseLease matches on holder).
        const lease = acquireManagedLease(db, 'scout')
        if (lease === null) {
          printJson({ action: 'noop', reason: 'lease-held' })
          return
        }
        try {
          const results = await scoutAll(db, channels, { force: opts.force, lease })
          // One cron-greppable JSON line; diagnostics went to stderr.
          printJson({ channels: results })
        } catch (err) {
          if (!(err instanceof ScoutRunFailedError)) throw err
          // A systemic run failure — every source dead (network down, Arctic
          // Shift outage) or every channel dead in scoring (expired key, provider
          // outage). Still one JSON line — the contract holds on failure outcomes —
          // then exit 1 so cron flags the run.
          printJson({ channels: err.results })
          console.error(err.message)
          process.exitCode = 1
        } finally {
          lease.release()
        }
      })
    })
}
