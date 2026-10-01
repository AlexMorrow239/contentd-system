import { test as base, expect } from '@playwright/test'
import type { Database } from 'better-sqlite3'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrainrotPaths } from '../../daemon/src/config/paths'
import { openDb } from '../../daemon/src/infra/db/index'
import { PLATFORM_META, channelToml, writeChannelsDir } from '../../daemon/testing/channel'
import { seedDaemonState, seedJob, seedLibrary, seedTopic } from '../../daemon/testing/db'
import { sweep, testRoot } from '../../daemon/testing/tmp'

interface DashboardFixture {
  db: Database
  paths: BrainrotPaths
  url: string
  videoPath: string
}
export const test = base.extend<object, { dashboard: DashboardFixture }>({
  dashboard: [
    async ({}, use) => {
      const paths = testRoot('next-dashboard-browser-')
      const db = openDb(paths.dbPath)
      writeChannelsDir(
        { 'chan-a.toml': channelToml({ name: 'chan-a', platforms: ['youtube', 'tiktok'] }) },
        paths.channelsDir,
      )
      const videoPath = join(paths.runsRoot, 'job-video', 'assemble', 'final.mp4')
      mkdirSync(join(paths.runsRoot, 'job-video', 'assemble'), { recursive: true })
      execFileSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=96x160:r=10:d=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        videoPath,
      ])
      const portServer = createServer()
      portServer.listen(0, '127.0.0.1')
      await once(portServer, 'listening')
      const address = portServer.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await new Promise<void>((resolve) => portServer.close(() => resolve()))
      const url = `http://127.0.0.1:${address.port}`
      const require = createRequire(import.meta.url)
      const child = spawn(
        process.execPath,
        [
          '--import',
          require.resolve('tsx'),
          fileURLToPath(new URL('../launch.ts', import.meta.url)),
          'start',
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            NODE_ENV: 'production',
            BRAINROT_ROOT: paths.root,
            BRAINROT_DASHBOARD_PORT: String(address.port),
            TZ: 'UTC',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      try {
        await expect
          .poll(
            async () => {
              if (child.exitCode !== null) throw new Error(output)
              try {
                return (await fetch(url)).status
              } catch {
                return 0
              }
            },
            { timeout: 20000 },
          )
          .toBe(200)
        await use({ db, paths, url, videoPath })
      } finally {
        child.kill('SIGTERM')
        if (child.exitCode === null) await once(child, 'exit')
        db.close()
        sweep()
      }
    },
    { scope: 'worker' },
  ],
})
export { expect }
export function resetFixture({ db, videoPath }: DashboardFixture) {
  for (const table of [
    'operator_actions',
    'posts',
    'library',
    'job_stages',
    'costs',
    'topics',
    'jobs',
  ])
    db.prepare(`DELETE FROM ${table}`).run()
  seedDaemonState(db, { lastSeenAt: new Date() })
  seedJob(db, 'job-video', { topic: 'A video to post' })
  seedJob(db, 'job-failed', { topic: 'Recover this job', status: 'failed' })
  seedLibrary(db, 'job-video', {
    videoPath,
    metadataJson: JSON.stringify(PLATFORM_META),
    qcJson: '{"checks":[]}',
  })
  seedTopic(db, { title: '<script>untrusted topic</script>', url: 'javascript:alert(1)' })
}
