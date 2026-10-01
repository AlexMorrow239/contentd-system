import { describe, expect, it } from 'vitest'
import { memDb } from '../../../../testing/db.js'
import {
  DAEMON_STALE_MS,
  daemonIsStale,
  readDaemonState,
  stampDaemonSeen,
} from '../daemon-state.js'

describe('daemon state', () => {
  it('returns null before the daemon has ever run', () => {
    expect(readDaemonState(memDb())).toBeNull()
  })

  it('records pid and both timestamps on the first stamp', () => {
    const db = memDb()
    stampDaemonSeen(db, 42, new Date('2026-08-01T10:00:00Z'))
    expect(readDaemonState(db)).toEqual({
      pid: 42,
      startedAt: '2026-08-01T10:00:00.000Z',
      lastSeenAt: '2026-08-01T10:00:00.000Z',
    })
  })

  it('advances last_seen_at without rewriting started_at', () => {
    // started_at is how long this daemon has been up; a heartbeat must not
    // reset it.
    const db = memDb()
    stampDaemonSeen(db, 42, new Date('2026-08-01T10:00:00Z'))
    stampDaemonSeen(db, 42, new Date('2026-08-01T10:00:30Z'))
    expect(readDaemonState(db)).toEqual({
      pid: 42,
      startedAt: '2026-08-01T10:00:00.000Z',
      lastSeenAt: '2026-08-01T10:00:30.000Z',
    })
  })

  it('resets started_at when a different pid takes over', () => {
    const db = memDb()
    stampDaemonSeen(db, 42, new Date('2026-08-01T10:00:00Z'))
    stampDaemonSeen(db, 99, new Date('2026-08-01T11:00:00Z'))
    expect(readDaemonState(db)?.startedAt).toBe('2026-08-01T11:00:00.000Z')
  })

  it('treats a never-run daemon as stale', () => {
    expect(daemonIsStale(null, new Date())).toBe(true)
  })

  it('treats a heartbeat inside the window as live and outside it as stale', () => {
    const db = memDb()
    const start = new Date('2026-08-01T10:00:00Z')
    stampDaemonSeen(db, 42, start)
    const state = readDaemonState(db)
    expect(daemonIsStale(state, new Date(start.getTime() + DAEMON_STALE_MS - 1))).toBe(false)
    expect(daemonIsStale(state, new Date(start.getTime() + DAEMON_STALE_MS + 1))).toBe(true)
  })
})
