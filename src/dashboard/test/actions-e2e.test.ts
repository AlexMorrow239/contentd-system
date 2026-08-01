import { describe, expect, it } from 'vitest'
import { openDb } from '../../db/index.js'
import { actionsUnit } from '../../loop/actions-worker.js'
import { resolvePaths } from '../../config/paths.js'
import { seedTopic } from '../../testing/db.js'
import { tmpDir } from '../../testing/tmp.js'
import { createApp } from '../server.js'
import type { DashboardConfig } from '../config.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

describe('dashboard to daemon action round trip', () => {
  it('enqueues from an HTTP form and executes in the worker against one file db', async () => {
    // The unit tests stub each side of the seam; this one proves a real
    // file-backed SQLite database carries an action from the dashboard's
    // write handle to the daemon's worker.
    const paths = resolvePaths(tmpDir('brainrot-e2e-'))
    mkdirSync(join(paths.root, 'db'), { recursive: true })
    mkdirSync(paths.channelsDir, { recursive: true })
    const db = openDb(paths.dbPath)
    const topicId = seedTopic(db, { status: 'candidate' })
    const config: DashboardConfig = { paths, port: 8787 }

    const form = new URLSearchParams({
      kind: 'topics.reject',
      csrf: 'tok',
      ids: String(topicId),
      from: '/topics',
    })
    const res = await createApp({ config, csrfToken: 'tok' }).request('/actions', {
      method: 'POST',
      body: form,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:8787',
        origin: 'http://127.0.0.1:8787',
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(res.status).toBe(303)

    const tick = actionsUnit(db, 'fast', {
      channelsDir: paths.channelsDir,
      runsRoot: paths.runsRoot,
    })
    expect((await tick()).worked).toBe(true)

    const topic = db.prepare('SELECT status FROM topics WHERE id = ?').get(topicId) as {
      status: string
    }
    expect(topic.status).toBe('rejected')
    db.close()
  })
})
