import type { Database } from 'better-sqlite3'
import { decryptToken, encryptToken } from './crypto.js'
import type { Platform } from './types.js'

// One row per platform x channel — each YouTube channel is its own brand
// account with its own consent grant (design spec §3.2). Only the
// long-lived refresh token is stored; access tokens are minted per tick
// and never persisted.
export function upsertToken(
  db: Database,
  platform: Platform,
  channel: string,
  refreshToken: string,
  scopes: string,
  key: Buffer,
): void {
  const ciphertext = encryptToken(refreshToken, key)
  db.prepare(
    'INSERT INTO oauth_tokens (platform, channel, token_ciphertext, scopes) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(platform, channel) DO UPDATE SET ' +
      'token_ciphertext = excluded.token_ciphertext, scopes = excluded.scopes, ' +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ).run(platform, channel, ciphertext, scopes)
}

// null covers both "never authed" (no row) and "can't be trusted" (decrypt
// failure — tampered blob, or a rotated BRAINROT_TOKEN_KEY that no longer
// opens old ciphertext), so callers treat both the same way: skip this
// candidate, never crash the tick. A decrypt failure is reported once to
// stderr naming platform+channel — never token bytes.
export function loadRefreshToken(
  db: Database,
  platform: Platform,
  channel: string,
  key: Buffer,
): string | null {
  const row = db
    .prepare('SELECT token_ciphertext FROM oauth_tokens WHERE platform = ? AND channel = ?')
    .get(platform, channel) as { token_ciphertext: Buffer } | undefined
  if (row === undefined) return null
  try {
    return decryptToken(row.token_ciphertext, key)
  } catch {
    process.stderr.write(`loadRefreshToken: decrypt failed for ${platform}/${channel}\n`)
    return null
  }
}
