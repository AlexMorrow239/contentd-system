import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { DEFAULT_ROOT, resolveBrainrotPaths, resolvePaths, resolveRoot } from './paths.js'

describe('resolveRoot', () => {
  it('prefers the flag over the env var', () => {
    expect(resolveRoot('/app/state', { BRAINROT_ROOT: 'local' })).toBe('/app/state')
  })

  it('falls back to the env var when no flag is passed', () => {
    expect(resolveRoot(undefined, { BRAINROT_ROOT: '/app/state' })).toBe('/app/state')
  })

  it('defaults to the dev root when neither is set', () => {
    // The whole point of the default: omission can never reach production.
    expect(resolveRoot(undefined, {})).toBe(DEFAULT_ROOT)
    expect(DEFAULT_ROOT).toBe('local')
  })

  it('treats an empty flag or env value as unset', () => {
    // compose pins some keys to "" deliberately; "" must not become a root of "".
    expect(resolveRoot('', { BRAINROT_ROOT: '/app/state' })).toBe('/app/state')
    expect(resolveRoot(undefined, { BRAINROT_ROOT: '  ' })).toBe(DEFAULT_ROOT)
  })
})

describe('resolvePaths', () => {
  it('derives the documented layout from the root', () => {
    expect(resolvePaths('local')).toEqual({
      root: 'local',
      dbPath: path.join('local', 'db', 'brainrot.db'),
      runsRoot: path.join('local', 'runs'),
      channelsDir: path.join('local', 'channels'),
    })
  })

  it('works for an absolute container root', () => {
    const paths = resolvePaths('/app/state')
    expect(paths.dbPath).toBe('/app/state/db/brainrot.db')
    expect(paths.runsRoot).toBe('/app/state/runs')
    expect(paths.channelsDir).toBe('/app/state/channels')
  })

  it('uses the same db filename in both modes', () => {
    // No dev.db: the root disambiguates, so a path never has to be read to
    // learn which mode it belongs to.
    expect(path.basename(resolvePaths('local').dbPath)).toBe(
      path.basename(resolvePaths('/app/state').dbPath),
    )
  })
})

describe('resolveBrainrotPaths', () => {
  it('composes resolveRoot and resolvePaths', () => {
    expect(resolveBrainrotPaths(undefined, { BRAINROT_ROOT: '/app/state' })).toEqual(
      resolvePaths('/app/state'),
    )
  })
})
