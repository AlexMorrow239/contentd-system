import { Command } from 'commander'
import { ROOT_OPTION_DESC, withDb } from './context.js'
export function registerDaemonCommands(program: Command): void {
  program
    .command('run')
    .description('run the demand-driven daemon: produce and scout workers plus the daily digest')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (opts: { root?: string }) => {
      const { runDaemon } = await import('../daemon.js')
      await withDb(opts, (db, paths) =>
        runDaemon(db, { channelsDir: paths.channelsDir, runsRoot: paths.runsRoot }),
      )
    })
}
