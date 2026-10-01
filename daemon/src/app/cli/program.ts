import { Command } from 'commander'
import { registerBillingCommands } from './billing.js'
import { registerDaemonCommands } from './daemon.js'
import { registerLibraryCommands } from './library.js'
import { registerProductionCommands } from './production.js'
import { registerReportingCommands } from './reporting.js'
import { registerScoutingCommands } from './scouting.js'
import { registerTopicsCommands } from './topics.js'

/** Register commands without loading providers, rendering, or daemon workers.
 * Command callbacks dynamically import their execution graphs. */
export function createProgram(): Command {
  const program = new Command()
  program.name('contentd').description('contentd daemon and utilities for contentd-system')
  registerProductionCommands(program)
  registerScoutingCommands(program)
  registerBillingCommands(program)
  registerDaemonCommands(program)
  registerTopicsCommands(program)
  registerLibraryCommands(program)
  registerReportingCommands(program)
  return program
}
