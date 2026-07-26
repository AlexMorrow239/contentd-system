import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/index.js'
import type { DashboardConfig } from './config.js'
import { createApp } from './server.js'

function seededConfig(): DashboardConfig {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-dash-'))
  const prod = join(dir, 'brainrot.db')
  openDb(prod).close()
  return {
    dbPaths: { prod, dev: join(dir, 'absent.db') },
    runsRoot: join(dir, 'runs'),
    channelsDir: join(dir, 'channels'),
    port: 8787,
  }
}

describe('createApp', () => {
  it('serves the stylesheet without needing a database', async () => {
    // Static assets are registered BEFORE the db middleware; a missing
    // database must not take the CSS down with it.
    const config = seededConfig()
    config.dbPaths.prod = join(tmpdir(), 'definitely-absent.db')
    const res = await createApp({ config }).request('/static/dashboard.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('renders a missing-database page instead of crashing', async () => {
    const res = await createApp({ config: seededConfig() }).request('/jobs?db=dev')
    expect(res.status).toBe(503)
    const body = await res.text()
    expect(body).toContain('no database at')
    expect(body).toContain('absent.db')
  })

  it('does not create the database file it failed to find', async () => {
    const config = seededConfig()
    await createApp({ config }).request('/jobs?db=dev')
    const { existsSync } = await import('node:fs')
    expect(existsSync(config.dbPaths.dev)).toBe(false)
  })

  it('defaults to the production database', async () => {
    const res = await createApp({ config: seededConfig() }).request('/jobs')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('viewing prod')
  })

  it('returns a readable 404 for an unknown path', async () => {
    const res = await createApp({ config: seededConfig() }).request('/nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('not found')
  })

  it('returns a readable 500 rather than an empty response when a route throws', async () => {
    const app = createApp({ config: seededConfig() })
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('kaboom')
  })
})
