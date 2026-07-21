import type { Database } from 'better-sqlite3'

// Generously above any single job's runtime: a crashed holder self-heals by
// expiry instead of wedging the loop forever.
export const PRODUCE_LEASE_TTL_MS = 5_400_000 // 90 min

// Acquire-if-free in one synchronous transaction. BEGIN IMMEDIATE takes the
// write lock up front so a concurrent process cannot interleave between the
// read and the upsert.
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
  const attempt = db.transaction((): boolean => {
    const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
      | { expires_at: string }
      | undefined
    if (row !== undefined) return false
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    db.prepare(
      'INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
    ).run(name, holder, expiresAt)
    return true
  })
  return attempt.immediate()
}
