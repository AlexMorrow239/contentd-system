import { describe, expect, it } from 'vitest'
import { openDb } from './index.js'

describe('posts table', () => {
  it('is created by openDb; publishes and oauth_tokens are not', () => {
    const db = openDb(':memory:')
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('posts')
    expect(names).not.toContain('publishes')
    expect(names).not.toContain('oauth_tokens')
    db.close()
  })
})
