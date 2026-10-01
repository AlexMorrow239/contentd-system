import { describe, expect, it } from 'vitest'
import { resolveDashboardConfig } from '../config.js'

describe('resolveDashboardConfig', () => {
  it('derives its paths from the same root the CLI uses', () => {
    const cfg = resolveDashboardConfig({ NODE_ENV: 'test', CONTENTD_ROOT: '/app/state' })
    expect(cfg.paths.dbPath).toBe('/app/state/db/contentd.db')
    expect(cfg.paths.runsRoot).toBe('/app/state/runs')
    expect(cfg.paths.channelsDir).toBe('/app/state/channels')
  })

  it('requires an explicit root', () => {
    expect(() => resolveDashboardConfig({ NODE_ENV: 'test' })).toThrow(/CONTENTD_ROOT.*required/)
  })

  it('reads the port', () => {
    expect(
      resolveDashboardConfig({
        NODE_ENV: 'test',
        CONTENTD_ROOT: '/app/state',
        CONTENTD_DASHBOARD_PORT: '9000',
      }).port,
    ).toBe(9000)
  })

  it('defaults the host to loopback, treating a blank value as unset', () => {
    expect(resolveDashboardConfig({ NODE_ENV: 'test', CONTENTD_ROOT: '/app/state' }).host).toBe(
      '127.0.0.1',
    )
    expect(
      resolveDashboardConfig({
        NODE_ENV: 'test',
        CONTENTD_ROOT: '/app/state',
        CONTENTD_DASHBOARD_HOST: ' ',
      }).host,
    ).toBe('127.0.0.1')
    expect(
      resolveDashboardConfig({
        NODE_ENV: 'test',
        CONTENTD_ROOT: '/app/state',
        CONTENTD_DASHBOARD_HOST: '0.0.0.0',
      }).host,
    ).toBe('0.0.0.0')
  })

  it('rejects a non-numeric port loudly rather than listening somewhere surprising', () => {
    expect(() =>
      resolveDashboardConfig({
        NODE_ENV: 'test',
        CONTENTD_ROOT: '/app/state',
        CONTENTD_DASHBOARD_PORT: 'eight',
      }),
    ).toThrow(/CONTENTD_DASHBOARD_PORT/)
  })

  it('treats an empty env value as unset, matching costs.ts and youtube.ts', () => {
    expect(
      resolveDashboardConfig({
        NODE_ENV: 'test',
        CONTENTD_ROOT: '/app/state',
        CONTENTD_DASHBOARD_PORT: '',
      }).port,
    ).toBe(8787)
  })
})
