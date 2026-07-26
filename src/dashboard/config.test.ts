import { describe, expect, it } from 'vitest'
import { resolveDashboardConfig, resolveDbChoice } from './config.js'

describe('resolveDashboardConfig', () => {
  it('falls back to the same defaults the CLI uses', () => {
    const cfg = resolveDashboardConfig({})
    expect(cfg.dbPaths.prod).toBe('data/brainrot.db')
    expect(cfg.dbPaths.dev).toBe('data/dev.db')
    expect(cfg.runsRoot).toBe('runs')
    expect(cfg.channelsDir).toBe('channels')
    expect(cfg.port).toBe(8787)
  })

  it('reads the pipeline env vars so the dashboard sees what the pipeline sees', () => {
    const cfg = resolveDashboardConfig({
      BRAINROT_DB: '/app/data/brainrot.db',
      BRAINROT_DEV_DB: '/app/data/other.db',
      BRAINROT_RUNS_ROOT: '/app/runs',
      BRAINROT_CHANNELS_DIR: '/app/channels',
      BRAINROT_DASHBOARD_PORT: '9000',
    })
    expect(cfg.dbPaths.prod).toBe('/app/data/brainrot.db')
    expect(cfg.dbPaths.dev).toBe('/app/data/other.db')
    expect(cfg.runsRoot).toBe('/app/runs')
    expect(cfg.channelsDir).toBe('/app/channels')
    expect(cfg.port).toBe(9000)
  })

  it('rejects a non-numeric port loudly rather than listening somewhere surprising', () => {
    expect(() => resolveDashboardConfig({ BRAINROT_DASHBOARD_PORT: 'eight' })).toThrow(
      /BRAINROT_DASHBOARD_PORT/,
    )
  })

  it('treats an empty env value as unset, matching costs.ts and youtube.ts', () => {
    // compose pins some keys to "" deliberately; "" must not mean port 0.
    expect(resolveDashboardConfig({ BRAINROT_DASHBOARD_PORT: '' }).port).toBe(8787)
  })
})

describe('resolveDbChoice', () => {
  it('defaults to prod', () => {
    expect(resolveDbChoice(undefined)).toBe('prod')
  })

  it('accepts dev', () => {
    expect(resolveDbChoice('dev')).toBe('dev')
  })

  it('falls back to prod for anything unrecognized', () => {
    // A viewer must never be the thing that 500s. An unknown ?db= value shows
    // production rather than erroring — and the banner says which one it is.
    expect(resolveDbChoice('nonsense')).toBe('prod')
    expect(resolveDbChoice('')).toBe('prod')
  })
})
