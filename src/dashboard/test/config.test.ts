import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveDashboardConfig } from '../config.js'

describe('resolveDashboardConfig', () => {
  it('derives its paths from the same root the CLI uses', () => {
    const cfg = resolveDashboardConfig({ BRAINROT_ROOT: '/app/state' })
    expect(cfg.paths.dbPath).toBe('/app/state/db/brainrot.db')
    expect(cfg.paths.runsRoot).toBe('/app/state/runs')
    expect(cfg.paths.channelsDir).toBe('/app/state/channels')
  })

  it('defaults to the dev root, never production', () => {
    const cfg = resolveDashboardConfig({})
    expect(cfg.paths.root).toBe('local')
    expect(cfg.paths.dbPath).toBe(path.join('local', 'db', 'brainrot.db'))
    expect(cfg.port).toBe(8787)
  })

  it('reads the port', () => {
    expect(resolveDashboardConfig({ BRAINROT_DASHBOARD_PORT: '9000' }).port).toBe(9000)
  })

  it('rejects a non-numeric port loudly rather than listening somewhere surprising', () => {
    expect(() => resolveDashboardConfig({ BRAINROT_DASHBOARD_PORT: 'eight' })).toThrow(
      /BRAINROT_DASHBOARD_PORT/,
    )
  })

  it('treats an empty env value as unset, matching costs.ts and youtube.ts', () => {
    expect(resolveDashboardConfig({ BRAINROT_DASHBOARD_PORT: '' }).port).toBe(8787)
  })
})
