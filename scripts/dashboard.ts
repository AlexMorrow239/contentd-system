import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveDashboardConfig } from '../src/dashboard/config.js'
import { mintCsrfToken } from '../src/dashboard/csrf.js'
const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'start') throw new Error('Expected dev or start')
const config = resolveDashboardConfig()
const require = createRequire(import.meta.url)
const child = spawn(
  process.execPath,
  [
    require.resolve('next/dist/bin/next'),
    mode,
    ...(mode === 'dev' ? ['--webpack'] : []),
    fileURLToPath(new URL('../dashboard', import.meta.url)),
    '--port',
    String(config.port),
    '--hostname',
    config.host,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, BRAINROT_DASHBOARD_CSRF: mintCsrfToken() },
  },
)
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
