import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'

export const LEASE_TTL_MS = 300_000
export const LEASE_HEARTBEAT_MS = 60_000
export const PRODUCE_LEASE_TTL_MS = LEASE_TTL_MS

export class LeaseLostError extends BrainrotError {
  constructor(name: string, cause?: unknown) {
    super(`ownership of ${name} lease was lost`, { domain: 'job', kind: 'conflict', cause })
    this.name = 'LeaseLostError'
  }
}

export interface LeaseContext {
  name: string
  token: string
  signal: AbortSignal
  assertOwned(): void
  release(): void
}

export function leaseHolder(label?: string): string {
  return `pid:${process.pid}:${label ?? 'operation'}:${randomUUID()}`
}

export function acquireLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
  return db
    .transaction(() => {
      const now = new Date().toISOString()
      const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
        { expires_at: string } | undefined
      if (row !== undefined && row.expires_at > now) return false
      db.prepare(
        'INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
      ).run(name, holder, new Date(Date.now() + ttlMs).toISOString())
      return true
    })
    .immediate()
}

export function extendLease(db: Database, name: string, holder: string, ttlMs: number): boolean {
  const now = new Date().toISOString()
  return (
    db
      .prepare('UPDATE leases SET expires_at = ? WHERE name = ? AND holder = ? AND expires_at > ?')
      .run(new Date(Date.now() + ttlMs).toISOString(), name, holder, now).changes === 1
  )
}

export function releaseLease(db: Database, name: string, holder: string): void {
  db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder)
}

export function ownsLease(db: Database, name: string, token: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM leases WHERE name = ? AND holder = ? AND expires_at > ?')
      .get(name, token, new Date().toISOString()) !== undefined
  )
}

/** The timer only requests cancellation. Guarded commits and attempt-local files
 * remain authoritative when a provider or subprocess cannot cancel promptly. */
export function acquireManagedLease(
  db: Database,
  name: string,
  parent?: LeaseContext,
): LeaseContext | null {
  parent?.assertOwned()
  const token = leaseHolder(name)
  if (!acquireLease(db, name, token, LEASE_TTL_MS)) return null
  const controller = new AbortController()
  let released = false
  const lose = (cause?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(new LeaseLostError(name, cause))
  }
  const parentLost = (): void => lose(parent?.signal.reason)
  parent?.signal.addEventListener('abort', parentLost, { once: true })
  const assertOwned = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason
    try {
      parent?.assertOwned()
      if (released || !ownsLease(db, name, token)) throw new LeaseLostError(name)
    } catch (err) {
      lose(err)
      throw controller.signal.reason
    }
  }
  const timer = setInterval(() => {
    if (controller.signal.aborted) return
    try {
      parent?.assertOwned()
      if (!extendLease(db, name, token, LEASE_TTL_MS)) lose()
    } catch (err) {
      lose(err)
    }
  }, LEASE_HEARTBEAT_MS)
  timer.unref()
  return {
    name,
    token,
    signal: controller.signal,
    assertOwned,
    release() {
      if (released) return
      released = true
      clearInterval(timer)
      parent?.signal.removeEventListener('abort', parentLost)
      try {
        releaseLease(db, name, token)
      } catch (err) {
        lose(err)
      }
    },
  }
}

export function requireLease(db: Database, name: string, parent?: LeaseContext): LeaseContext {
  const lease = acquireManagedLease(db, name, parent)
  if (lease === null)
    throw new BrainrotError(`${name} lease is held by another operation`, {
      domain: 'job',
      kind: 'conflict',
    })
  return lease
}
