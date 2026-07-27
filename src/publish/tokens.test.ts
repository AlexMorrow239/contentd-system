import { describe, expect, it, vi } from 'vitest'
import { loadToken, upsertToken } from './tokens.js'
import { memDb } from '../testing/db.js'

// AES-256-GCM key sized for crypto.ts's parseTokenKey output; filler bytes
// are fine — these tests never touch parseTokenKey or a real secret.
const TEST_KEY = Buffer.alloc(32, 0x42)

describe('upsertToken / loadToken', () => {
  it('round-trips a stored refresh token through encrypt/decrypt', () => {
    const db = memDb()
    upsertToken(
      db,
      'youtube',
      'chan-a',
      'rt-test-token',
      'https://www.googleapis.com/auth/youtube.upload',
      TEST_KEY,
    )
    expect(loadToken(db, 'youtube', 'chan-a', TEST_KEY)).toEqual({
      token: 'rt-test-token',
      expiresAt: null,
    })
    db.close()
  })

  it('overwrites the token and scopes on re-upsert, keeping a single row', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-1', 'scope-a', TEST_KEY)
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token-2', 'scope-b', TEST_KEY)
    expect(loadToken(db, 'youtube', 'chan-a', TEST_KEY)).toEqual({
      token: 'rt-test-token-2',
      expiresAt: null,
    })
    const rows = db.prepare('SELECT scopes FROM oauth_tokens').all() as { scopes: string }[]
    expect(rows).toEqual([{ scopes: 'scope-b' }])
    db.close()
  })

  it('returns null when no row exists for that platform/channel', () => {
    const db = memDb()
    expect(loadToken(db, 'youtube', 'no-such-channel', TEST_KEY)).toBeNull()
    db.close()
  })

  it('returns null and writes one stderr line naming platform+channel when the stored ciphertext is tampered', () => {
    const db = memDb()
    upsertToken(db, 'youtube', 'chan-a', 'rt-test-token', 'scope-a', TEST_KEY)
    db.prepare(
      'UPDATE oauth_tokens SET token_ciphertext = ? WHERE platform = ? AND channel = ?',
    ).run(Buffer.alloc(40, 0xff), 'youtube', 'chan-a')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(loadToken(db, 'youtube', 'chan-a', TEST_KEY)).toBeNull()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const line = String(stderrSpy.mock.calls[0][0])
    expect(line).toContain('youtube')
    expect(line).toContain('chan-a')
    expect(line).not.toContain('rt-test-token')
    stderrSpy.mockRestore()
    db.close()
  })

  describe('expires_at', () => {
    it('stores and returns a non-null expiry', () => {
      const db = memDb()
      upsertToken(
        db,
        'instagram',
        'chan',
        'ig-token',
        'instagram_content_publish',
        TEST_KEY,
        '2026-09-01T00:00:00.000Z',
      )
      expect(loadToken(db, 'instagram', 'chan', TEST_KEY)).toEqual({
        token: 'ig-token',
        expiresAt: '2026-09-01T00:00:00.000Z',
      })
      db.close()
    })

    it('defaults expiresAt to null when omitted (YouTube has no expiry)', () => {
      const db = memDb()
      upsertToken(db, 'youtube', 'chan', 'rt-token', 'scope', TEST_KEY)
      expect(loadToken(db, 'youtube', 'chan', TEST_KEY)).toEqual({
        token: 'rt-token',
        expiresAt: null,
      })
      db.close()
    })

    it('an upsert overwrites a prior expiry', () => {
      const db = memDb()
      upsertToken(db, 'instagram', 'chan', 't1', 'scope', TEST_KEY, '2026-08-01T00:00:00.000Z')
      upsertToken(db, 'instagram', 'chan', 't2', 'scope', TEST_KEY, '2026-09-01T00:00:00.000Z')
      expect(loadToken(db, 'instagram', 'chan', TEST_KEY)?.expiresAt).toBe(
        '2026-09-01T00:00:00.000Z',
      )
      db.close()
    })
  })
})
