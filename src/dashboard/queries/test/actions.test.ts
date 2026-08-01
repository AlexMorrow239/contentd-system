import { describe, expect, it } from 'vitest'
import { memDb, seedAction, seedDaemonState } from '../../../testing/db.js'
import { actionsTableExists, buildActionsPage } from '../actions.js'

describe('buildActionsPage', () => {
  it('reports the daemon stale when nothing has ever stamped', () => {
    const page = buildActionsPage(memDb(), new Date('2026-08-01T10:00:00Z'))
    expect(page.daemonStale).toBe(true)
    expect(page.daemonState).toBeNull()
  })

  it('reports the daemon live inside the heartbeat window', () => {
    const db = memDb()
    seedDaemonState(db, { lastSeenAt: new Date('2026-08-01T10:00:00Z') })
    expect(buildActionsPage(db, new Date('2026-08-01T10:00:10Z')).daemonStale).toBe(false)
  })

  it('lists actions newest first', () => {
    const db = memDb()
    const a = seedAction(db)
    const b = seedAction(db)
    expect(buildActionsPage(db, new Date()).actions.map((r) => r.id)).toEqual([b, a])
  })
})

describe('actionsTableExists', () => {
  it('is true on a migrated database', () => {
    expect(actionsTableExists(memDb())).toBe(true)
  })
})
