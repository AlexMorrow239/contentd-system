import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProgram } from './app/cli/program.js'
import { errorMessage } from './shared/errors.js'

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  createProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(errorMessage(err))
      process.exitCode = 1
    })
}
