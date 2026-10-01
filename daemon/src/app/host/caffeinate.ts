import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'dotenv'
import { errorMessage } from '../../shared/errors.js'
import { systemTime, type TimeSource } from '../../shared/time.js'

const exec = promisify(execFile)

export function readCaffeinateEnabled(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let file: Record<string, string> = {}
  try {
    file = parse(readFileSync(join(root, '.env')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const value = env.CONTENTD_CAFFEINATE ?? file.CONTENTD_CAFFEINATE ?? 'true'
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('CONTENTD_CAFFEINATE must be true or false')
}

interface Assertion {
  isRunning(): boolean
  stop(): void
}

export async function watchDaemon(opts: {
  signal: AbortSignal
  enabled: () => boolean
  isRunning: () => Promise<boolean>
  start: () => Assertion | Promise<Assertion>
  log: (message: string) => void
  time?: TimeSource
}): Promise<void> {
  const time = opts.time ?? systemTime
  let assertion: Assertion | undefined
  let lastError: string | undefined
  const release = (): void => {
    if (!assertion) return
    assertion.stop()
    assertion = undefined
    opts.log('Sleep prevention released')
  }
  opts.signal.addEventListener('abort', release, { once: true })
  try {
    while (!opts.signal.aborted) {
      try {
        const wanted = opts.enabled() && (await opts.isRunning())
        if (opts.signal.aborted) break
        if (assertion && !assertion.isRunning()) release()
        if (wanted && !assertion) {
          assertion = await opts.start()
          if (opts.signal.aborted) break
          opts.log('Preventing Mac sleep while the daemon runs; display sleep is allowed')
        } else if (!wanted) release()
        lastError = undefined
      } catch (error) {
        release()
        const message = errorMessage(error)
        if (message !== lastError) opts.log(message)
        lastError = message
      }
      await time.sleep(30_000, opts.signal)
    }
  } finally {
    opts.signal.removeEventListener('abort', release)
    release()
  }
}

export async function daemonContainerRunning(root: string, signal: AbortSignal): Promise<boolean> {
  const { stdout } = await exec(
    'docker',
    ['compose', '--project-directory', root, 'ps', '--status', 'running', '--quiet', 'contentd'],
    { cwd: root, signal, timeout: 10_000, maxBuffer: 64 * 1024 },
  )
  return stdout.trim().length > 0
}

export function startCaffeinate(): Promise<Assertion> {
  return new Promise((resolve, reject) => {
    // -w releases the assertion even if the helper is killed without cleanup.
    // -i prevents idle sleep; -s additionally prevents system sleep on AC power.
    // Do not use -d or -u: the display should still be allowed to sleep.
    const child = spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], {
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () =>
      resolve({
        isRunning: () => child.exitCode === null && child.signalCode === null && !child.killed,
        stop: () => {
          child.kill('SIGTERM')
        },
      }),
    )
  })
}
