import { describe, expect, it } from 'vitest'
import { openDb } from '../db/index.js'
import { loadRefreshToken, upsertToken } from './tokens.js'

// AES-256-GCM key sized for crypto.ts's parseTokenKey output; filler bytes
// are fine — these tests never touch parseTokenKey or a real secret.
const TEST_KEY = Buffer.alloc(32, 0x42)

describe('upsertToken / loadRefreshToken', () => {
  it('round-trips a stored refresh token through encrypt/decrypt', () => {
    const db = openDb(':memory:')
    upsertToken(
      db,
      'youtube',
      'chan-a',
      'rt-test-token',
      'https://www.googleapis.com/auth/youtube.upload',
      TEST_KEY,
    )
    expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBe('rt-test-token')
    db.close()
  })

  it('overwrites the token and scopes on re-upsert, keeping a single row', () => {
    const db = openDb(':memory:')
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-1', 'scope-a', TEST_KEY)
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-2', 'scope-b', TEST_KEY)
    expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBe('rt-test-token-2')
    const rows = db.prepare('SELECT scopes FROM oauth_tokens').all() as { scopes: string }[]
    expect(rows).toEqual([{ scopes: 'scope-b' }])
    db.close()
  })

  it('returns null when no row exists for that platform/channel', () => {
    const db = openDb(':memory:')
    expect(loadRefreshToken(db, 'youtube', 'no-such-channel', TEST_KEY)).toBeNull()
    db.close()
  })
})
