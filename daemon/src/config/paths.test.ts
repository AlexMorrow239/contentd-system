import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveContentdPaths, resolvePaths, resolveRoot } from './paths.js'

describe('resolveRoot', () => {
  it('prefers the flag over the env var', () => {
    expect(resolveRoot('/app/state', { CONTENTD_ROOT: 'fixture' })).toBe('/app/state')
  })

  it('falls back to the env var when no flag is passed', () => {
    expect(resolveRoot(undefined, { CONTENTD_ROOT: '/app/state' })).toBe('/app/state')
  })

  it('requires an explicit root instead of creating local operational state', () => {
    expect(() => resolveRoot(undefined, {})).toThrow(/CONTENTD_ROOT.*required/)
  })

  it('treats an empty flag or env value as unset', () => {
    // compose pins some keys to "" deliberately; "" must not become a root of "".
    expect(resolveRoot('', { CONTENTD_ROOT: '/app/state' })).toBe('/app/state')
    expect(() => resolveRoot(undefined, { CONTENTD_ROOT: '  ' })).toThrow(/required/)
  })
})

describe('resolvePaths', () => {
  it('derives the documented layout from the root', () => {
    expect(resolvePaths('fixture')).toEqual({
      root: 'fixture',
      dbPath: path.join('fixture', 'db', 'contentd.db'),
      runsRoot: path.join('fixture', 'runs'),
      channelsDir: path.join('fixture', 'channels'),
    })
  })

  it('works for an absolute container root', () => {
    const paths = resolvePaths('/app/state')
    expect(paths.dbPath).toBe('/app/state/db/contentd.db')
    expect(paths.runsRoot).toBe('/app/state/runs')
    expect(paths.channelsDir).toBe('/app/state/channels')
  })

  it('uses the same db filename across runtime roots', () => {
    // Disposable fixtures use the same layout as the production container.
    expect(path.basename(resolvePaths('fixture').dbPath)).toBe(
      path.basename(resolvePaths('/app/state').dbPath),
    )
  })
})

describe('resolveContentdPaths', () => {
  it('composes resolveRoot and resolvePaths', () => {
    expect(resolveContentdPaths(undefined, { CONTENTD_ROOT: '/app/state' })).toEqual(
      resolvePaths('/app/state'),
    )
  })
})
