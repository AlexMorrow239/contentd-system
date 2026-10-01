import { Command } from 'commander'
import { daySpendBreakdown } from '../../features/billing/costs.js'
import { formatUsdMicros } from '../../shared/money.js'
import { ROOT_OPTION_DESC, withDb } from './context.js'
export function registerBillingCommands(program: Command): void {
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
}
