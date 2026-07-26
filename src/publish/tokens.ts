import type { Database } from 'better-sqlite3'
import { decryptToken, encryptToken } from './crypto.js'
import type { Platform } from './types.js'

export interface StoredToken {
  token: string
  expiresAt: string | null
}

// One row per platform x channel — each channel's brand account has its own
// consent grant (design spec §3.2, generalized in Plan 6 decision 5).
// expiresAt is null for a token with no expiry (YouTube's refresh token);
// Instagram's long-lived token always carries one.
export function upsertToken(
  db: Database,
  platform: Platform,
  channel: string,
  token: string,
  scopes: string,
  key: Buffer,
  expiresAt: string | null = null,
): void {
  const ciphertext = encryptToken(token, key)
  db.prepare(
    'INSERT INTO oauth_tokens (platform, channel, token_ciphertext, scopes, expires_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(platform, channel) DO UPDATE SET ' +
      'token_ciphertext = excluded.token_ciphertext, scopes = excluded.scopes, ' +
      'expires_at = excluded.expires_at, ' +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ).run(platform, channel, ciphertext, scopes, expiresAt)
}

// null covers both "never authed" (no row) and "can't be trusted" (decrypt
// failure — tampered blob, or a rotated BRAINROT_TOKEN_KEY that no longer
// opens old ciphertext), so callers treat both the same way: skip this
// candidate, never crash the tick. A decrypt failure is reported once to
// stderr naming platform+channel — never token bytes.
export function loadToken(
  db: Database,
  platform: Platform,
  channel: string,
  key: Buffer,
): StoredToken | null {
  const row = db
    .prepare(
      'SELECT token_ciphertext, expires_at FROM oauth_tokens WHERE platform = ? AND channel = ?',
    )
    .get(platform, channel) as { token_ciphertext: Buffer; expires_at: string | null } | undefined
  if (row === undefined) return null
  try {
    return { token: decryptToken(row.token_ciphertext, key), expiresAt: row.expires_at }
  } catch {
    process.stderr.write(`loadToken: decrypt failed for ${platform}/${channel}\n`)
    return null
  }
}
