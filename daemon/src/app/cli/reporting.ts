import { Command } from 'commander'
import { errorMessage } from '../../shared/errors.js'
import { ROOT_OPTION_DESC, withDb } from './context.js'
export function registerReportingCommands(program: Command): void {
  program
    .command('digest')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (opts: { root?: string }) => {
      // A report, not a check: nothing here may set a non-zero exit — cron
      // MAILTO should deliver whatever printed, so even a config/db error is
      // reported on stderr and the process still exits 0.
      try {
        const { digestForChannelsDir } = await import('../../features/reporting/digest.js')
        // A channels dir that fails to load is reported inside the digest, not
        // instead of it. The catch below stays for genuinely unexpected digest
        // failures (a db that will not open).
        await withDb(opts, (db, paths) => {
          process.stdout.write(digestForChannelsDir(db, paths.channelsDir) + '\n')
        })
      } catch (err) {
        console.error(errorMessage(err))
      }
    })
}
