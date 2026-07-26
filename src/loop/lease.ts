import type { Database } from 'better-sqlite3'

// Generously above any single job's runtime: a crashed holder self-heals by
// expiry instead of wedging the loop forever.
export const PRODUCE_LEASE_TTL_MS = 5_400_000 // 90 min

// One upload per tick, so a much shorter window than produce's suffices —
// generously above a single resumable-upload call's worst case.
export const PUBLISH_LEASE_TTL_MS = 1_800_000 // 30 min

// Acquire-if-free-or-expired in one synchronous transaction. BEGIN IMMEDIATE
// takes the write lock up front so a concurrent process cannot interleave
// between the read and the upsert. ISO-8601 UTC strings compare correctly
// as strings, so no date parsing is needed in the guard.
export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
  const attempt = db.transaction((): boolean => {
    const now = new Date().toISOString()
    const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
      { expires_at: string } | undefined
    if (row !== undefined && row.expires_at > now) return false
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    db.prepare(
      'INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
    ).run(name, holder, expiresAt)
    return true
  })
  return attempt.immediate()
}

// Heartbeat for work that outlives the TTL (a long render): pushes the expiry
// a fresh ttl ahead, but ONLY while this holder still owns the lease. A holder
// already evicted by a takeover gets `false` and stays evicted — re-acquiring
// here would hand one lease to two live processes.
export function extendLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const info = db
    .prepare('UPDATE leases SET expires_at = ? WHERE name = ? AND holder = ?')
    .run(expiresAt, name, holder)
  return info.changes === 1
}

// Deletes only the caller's own lease: after an expiry takeover the evicted
// holder's finally-release must not free the new holder's lease.
export function releaseLease(db: Database, name: string, holder: string): void {
  db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder)
}
