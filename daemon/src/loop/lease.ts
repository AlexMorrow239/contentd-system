import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { BrainrotError } from '../errors.js'
import { resolveTime, systemTime, type TimeSource } from '../time.js'

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
  readonly time: TimeSource
  name: string
  token: string
  signal: AbortSignal
  assertOwned(): void
  release(): void
}

export function leaseHolder(label?: string): string {
  return `pid:${process.pid}:${label ?? 'operation'}:${randomUUID()}`
}

export function acquireLease(
  db: Database,
  name: string,
  holder: string,
  ttlMs: number,
  time: TimeSource = systemTime,
): boolean {
  return db
    .transaction(() => {
      const at = time.now()
      const now = at.toISOString()
      const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name) as
        { expires_at: string } | undefined
      if (row !== undefined && row.expires_at > now) return false
      db.prepare(
        'INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at',
      ).run(name, holder, new Date(at.getTime() + ttlMs).toISOString())
      return true
    })
    .immediate()
}

export function extendLease(
  db: Database,
  name: string,
  holder: string,
  ttlMs: number,
  time: TimeSource = systemTime,
): boolean {
  const at = time.now()
  const now = at.toISOString()
  return (
    db
      .prepare('UPDATE leases SET expires_at = ? WHERE name = ? AND holder = ? AND expires_at > ?')
      .run(new Date(at.getTime() + ttlMs).toISOString(), name, holder, now).changes === 1
  )
}

export function releaseLease(db: Database, name: string, holder: string): void {
  db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder)
}

export function ownsLease(
  db: Database,
  name: string,
  token: string,
  time: TimeSource = systemTime,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM leases WHERE name = ? AND holder = ? AND expires_at > ?')
      .get(name, token, time.now().toISOString()) !== undefined
  )
}

/** The timer only requests cancellation. Guarded commits and attempt-local files
 * remain authoritative when a provider or subprocess cannot cancel promptly. */
export function acquireManagedLease(
  db: Database,
  name: string,
  parent?: LeaseContext,
  opts: { time?: TimeSource; token?: string } = {},
): LeaseContext | null {
  const time = resolveTime(opts.time, parent)
  parent?.assertOwned()
  const token = opts.token ?? leaseHolder(name)
  if (!acquireLease(db, name, token, LEASE_TTL_MS, time)) return null
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
      if (released || !ownsLease(db, name, token, time)) throw new LeaseLostError(name)
    } catch (err) {
      lose(err)
      throw controller.signal.reason
    }
  }
  const heartbeat = (): void => {
    if (controller.signal.aborted) return
    try {
      parent?.assertOwned()
      if (!extendLease(db, name, token, LEASE_TTL_MS, time)) lose()
    } catch (err) {
      lose(err)
    }
  }
  let cancel: () => void
  try {
    cancel = time.startInterval(heartbeat, LEASE_HEARTBEAT_MS)
  } catch (err) {
    parent?.signal.removeEventListener('abort', parentLost)
    releaseLease(db, name, token)
    throw err
  }
  return {
    time,
    name,
    token,
    signal: controller.signal,
    assertOwned,
    release() {
      if (released) return
      released = true
      try {
        cancel()
      } finally {
        parent?.signal.removeEventListener('abort', parentLost)
        try {
          releaseLease(db, name, token)
        } catch (err) {
          lose(err)
        }
      }
    },
  }
}

export function requireLease(
  db: Database,
  name: string,
  parent?: LeaseContext,
  opts: { time?: TimeSource; token?: string } = {},
): LeaseContext {
  const lease = acquireManagedLease(db, name, parent, opts)
  if (lease === null)
    throw new BrainrotError(`${name} lease is held by another operation`, {
      domain: 'job',
      kind: 'conflict',
    })
  return lease
}
