import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  assertNoLegacyPathEnv,
  DEFAULT_ROOT,
  resolveBrainrotPaths,
  resolvePaths,
  resolveRoot,
} from './paths.js'

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

  it('rejects a removed path variable even when a root flag is passed', () => {
    // A stale variable is a config error, not something a flag can paper over:
    // the operator's intent is genuinely ambiguous at that point.
    expect(() => resolveRoot('local', { BRAINROT_DB: 'data/dev.db' })).toThrow(/BRAINROT_DB/)
  })
})

describe('assertNoLegacyPathEnv', () => {
  it('names each removed variable and its replacement', () => {
    for (const key of [
      'BRAINROT_DB',
      'BRAINROT_RUNS_ROOT',
      'BRAINROT_CHANNELS_DIR',
      'BRAINROT_DEV_DB',
    ]) {
      expect(() => assertNoLegacyPathEnv({ [key]: 'x' })).toThrow(
        new RegExp(`${key}.*BRAINROT_ROOT`, 's'),
      )
    }
  })

  it('classifies as a config error so a surface can match on the domain', () => {
    try {
      assertNoLegacyPathEnv({ BRAINROT_DB: 'data/dev.db' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toMatchObject({ domain: 'config', kind: 'invalid' })
    }
  })

  it('treats an empty value as unset', () => {
    expect(() => assertNoLegacyPathEnv({ BRAINROT_DB: '', BRAINROT_DEV_DB: '  ' })).not.toThrow()
  })

  it('passes on a clean environment', () => {
    expect(() => assertNoLegacyPathEnv({ BRAINROT_ROOT: 'local' })).not.toThrow()
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
