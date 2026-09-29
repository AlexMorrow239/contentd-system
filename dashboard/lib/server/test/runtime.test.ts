import { describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpDir } from '../../../../daemon/testing/tmp.js'
import { fileDb } from '../../../../daemon/testing/db.js'
import { databaseError, withDashboardDb } from '../runtime.js'
describe('withDashboardDb', () => {
  it('does not create missing directories or a missing database', () => {
    const dbPath = join(tmpDir('dashboard-missing-'), 'absent', 'database.db')
    expect(() => withDashboardDb(dbPath, () => null)).toThrow()
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(join(dbPath, '..'))).toBe(false)
  })
  it('closes its readonly handle after a failing query', () => {
    const { dbPath } = fileDb()
    let closed = () => false
    expect(() =>
      withDashboardDb(dbPath, (db) => {
        closed = () => !db.open
        db.prepare('SELECT * FROM nonexistent').all()
      }),
    ).toThrow()
    expect(closed()).toBe(true)
    expect(() =>
      withDashboardDb(dbPath, (db) => db.exec('CREATE TABLE should_not_exist (id)')),
    ).toThrow()
  })
  it('distinguishes corruption from missing state and logs failures', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dbPath = join(tmpDir('dashboard-corrupt-'), 'broken.db')
    expect(databaseError(dbPath, new Error('missing'))).toContain('Database missing')
    writeFileSync(dbPath, 'not sqlite')
    expect(() => withDashboardDb(dbPath, () => null)).toThrow()
    expect(databaseError(dbPath, new Error('malformed'))).toContain('malformed')
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })
})
