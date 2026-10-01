import { Command } from 'commander'
import type { LibraryState } from '../../features/library/library.js'
import { approveLibrary, listLibrary } from '../../features/library/library.js'
import { parseLibraryJobIds } from './arguments.js'
import { ROOT_OPTION_DESC, withDb } from './context.js'
export function registerLibraryCommands(program: Command): void {
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
        const approved = approveLibrary(db, jobIds)
        // approved < jobIds.length flags ids that were not in 'needs-review' state.
        console.log(`approved ${approved} of ${jobIds.length}`)
      })
    })
}
