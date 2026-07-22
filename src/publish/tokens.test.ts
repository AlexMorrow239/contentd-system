import { describe, expect, it, vi } from 'vitest'
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

  it('returns null and writes one stderr line naming platform+channel when the stored ciphertext is tampered', () => {
    const db = openDb(':memory:')
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope-a', TEST_KEY)
    db.prepare(
      'UPDATE oauth_tokens SET token_ciphertext = ? WHERE platform = ? AND channel = ?',
    ).run(Buffer.alloc(40, 0xff), 'youtube', 'chan-a')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(loadRefreshToken(db, 'youtube', 'chan-a', TEST_KEY)).toBeNull()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = String(stderrSpy.mock.calls[0][0])
    expect(line).toContain('youtube')
    expect(line).toContain('chan-a')
    expect(line).not.toContain('rt-test-token')
    stderrSpy.mockRestore()
    db.close()
  })
})
