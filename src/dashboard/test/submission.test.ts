import { describe, it, expect } from 'vitest'
import { openDb } from '../../db/index.js'
import { seedDaemonState } from '../../testing/db.js'
import { testRoot, trackDb } from '../../testing/tmp.js'
import { submitAction } from '../submission.js'

function setup() {
  const paths = testRoot('dashboard-submit-')
  const db = openDb(paths.dbPath)
  trackDb(db)
  seedDaemonState(db, { lastSeenAt: new Date() })
  return { db, deps: { config: { paths, port: 8787, host: '127.0.0.1' }, csrfToken: 'test-token' } }
}
function request(fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:8787/api/actions', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: new URLSearchParams({ kind: 'topics.reject', ids: '1', csrf: 'test-token', ...fields }),
  })
}
describe('submitAction', () => {
  it('accepts a validated action once without executing it', async () => {
    const { db, deps } = setup()
    const response = await submitAction(request(), deps)
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ actionId: 1 })
    expect(db.prepare('SELECT kind, status, args FROM operator_actions').all()).toEqual([
      { kind: 'topics.reject', status: 'pending', args: '{"ids":[1]}' },
    ])
  })
  it.each([
    [{ csrf: 'stale' }, {}, 403],
    [{ csrf: '' }, {}, 403],
    [{ kind: 'unknown' }, {}, 400],
    [{ ids: 'invalid' }, {}, 400],
    [{}, { origin: 'http://evil.example' }, 403],
    [{}, { 'sec-fetch-site': 'cross-site' }, 403],
    [{}, { host: 'evil.example', origin: 'http://evil.example' }, 403],
  ])('rejects invalid submission %# without writing', async (fields, headers, status) => {
    const { db, deps } = setup()
    const response = await submitAction(request(fields, headers), deps)
    expect(response.status).toBe(status)
    expect(await response.json()).toHaveProperty('error')
    expect(db.prepare('SELECT * FROM operator_actions').all()).toEqual([])
  })
  it('refuses a stale daemon without writing', async () => {
    const { db, deps } = setup()
    seedDaemonState(db, { lastSeenAt: new Date(0) })
    expect((await submitAction(request(), deps)).status).toBe(409)
    expect(db.prepare('SELECT * FROM operator_actions').all()).toEqual([])
  })
  it('groups repeated fields into a list', async () => {
    const { db, deps } = setup()
    const req = request()
    const form = new URLSearchParams(await req.text())
    form.append('ids', '2')
    const response = await submitAction(
      new Request(req.url, { method: 'POST', headers: req.headers, body: form }),
      deps,
    )
    expect(response.status).toBe(202)
    expect(db.prepare('SELECT args FROM operator_actions').get()).toEqual({ args: '{"ids":[1,2]}' })
  })
  it('rejects malformed form bodies', async () => {
    const { db, deps } = setup()
    const response = await submitAction(
      new Request('http://localhost/api/actions', { method: 'POST', body: '{}' }),
      deps,
    )
    expect(response.status).toBe(400)
    expect(db.prepare('SELECT * FROM operator_actions').all()).toEqual([])
  })
})
