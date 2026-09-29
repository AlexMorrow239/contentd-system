import { describe, expect, it } from 'vitest'
import { memDb, seedAction } from '../../../../../daemon/testing/db.js'
import { actionsTableExists, hasActiveAction } from '../actions.js'

describe('hasActiveAction', () => {
  it('is false when every action has finished', () => {
    const db = memDb()
    seedAction(db, { status: 'done' })
    seedAction(db, { status: 'failed' })
    expect(hasActiveAction(db)).toBe(false)
  })

  it('is true while an action is pending', () => {
    const db = memDb()
    seedAction(db)
    expect(hasActiveAction(db)).toBe(true)
  })
})

describe('actionsTableExists', () => {
  it('is true on a migrated database', () => {
    expect(actionsTableExists(memDb())).toBe(true)
  })
})
