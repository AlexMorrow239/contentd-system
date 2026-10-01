import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { errorMessage } from '../../shared/errors.js'
import { systemTime } from '../../shared/time.js'
import {
  daemonContainerRunning,
  readCaffeinateEnabled,
  startCaffeinate,
  watchDaemon,
} from './caffeinate.js'

// src/ and the mirrored dist/ tree have the same depth beneath the checkout.
export const checkoutRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const label = 'com.brainrot.caffeinate'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

function xml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  )
}

function launchctl(...args: string[]): void {
  execFileSync('/bin/launchctl', args, { stdio: 'pipe' })
}

function unload(service: string): void {
  try {
    launchctl('print', service)
  } catch {
    return // Not currently loaded (including a first install).
  }
  launchctl('bootout', service)
}

async function bootstrap(domain: string): Promise<void> {
  // bootout can return before launchd has finished removing the old job.
  // A bootstrap in that window fails with EIO (5). Bound retries so permanent
  // configuration/permission errors still surface instead of looping forever.
  for (let attempt = 0; ; attempt++) {
    try {
      launchctl('bootstrap', domain, plistPath)
      return
    } catch (error) {
      if ((error as { status?: number }).status !== 5 || attempt >= 20) throw error
      await systemTime.sleep(250)
    }
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('This helper must run on the macOS host, outside Docker')
  const mode = process.argv[2] ?? 'run'
  const domain = `gui/${process.getuid!()}`
  if (mode === 'install') {
    readCaffeinateEnabled(checkoutRoot) // Validate before replacing an existing service.
    const args = [process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url), 'run']
    const log = join(checkoutRoot, 'logs', 'caffeinate.log')
    mkdirSync(dirname(log), { recursive: true })
    mkdirSync(dirname(plistPath), { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(checkoutRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`
    unload(`${domain}/${label}`)
    writeFileSync(plistPath, plist, { mode: 0o600 })
    await bootstrap(domain)
    console.log(`Installed ${label}. Starts now and at login. Log: ${log}`)
    console.log(
      'Set BRAINROT_CAFFEINATE=false in .env to disable sleep prevention within 30 seconds.',
    )
    return
  }
  if (mode === 'uninstall') {
    unload(`${domain}/${label}`)
    rmSync(plistPath, { force: true })
    console.log('Removed the caffeinate login service.')
    return
  }
  if (mode !== 'run') throw new Error('Usage: pnpm daemon:caffeinate [install|uninstall|run]')

  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await watchDaemon({
      signal: controller.signal,
      enabled: () => readCaffeinateEnabled(checkoutRoot),
      isRunning: () => daemonContainerRunning(checkoutRoot, controller.signal),
      start: startCaffeinate,
      log: (message) => console.log(`${systemTime.now().toISOString()} ${message}`),
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
