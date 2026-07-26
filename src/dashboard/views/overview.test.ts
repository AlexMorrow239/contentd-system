import { describe, expect, it } from 'vitest'
import type { OverviewData } from '../queries/overview.js'
import { renderOverviewPage } from './overview.js'

function data(overrides: Partial<OverviewData> = {}): OverviewData {
  return {
    jobsByStatus: [{ status: 'done', count: 3 }],
    jobsLast24h: 2,
    attention: [],
    libraryByState: [{ status: 'needs-review', count: 1 }],
    globalSpend: { spentUsdMicros: 2_500_000, capUsdMicros: 12_000_000 },
    channelSpend: [],
    unattributedUsdMicros: 0,
    leases: [],
    quotaUsed: 1,
    quotaCap: 6,
    ...overrides,
  }
}

describe('renderOverviewPage', () => {
  it('shows spend against the cap in dollars', () => {
    const out = renderOverviewPage(data(), 'prod').value
    expect(out).toContain('$2.50')
    expect(out).toContain('$12.00')
  })

  it('says all clear when nothing needs attention', () => {
    const out = renderOverviewPage(data(), 'prod').value
    expect(out).toContain('nothing failed or blocked')
  })

  it('lists an attention job with its stage and error, linked to the drill-in', () => {
    const out = renderOverviewPage(
      data({
        attention: [
          {
            id: 'j1',
            channel: 'space',
            topic: 'Venus',
            status: 'failed',
            stage: 'voice',
            error: 'elevenlabs 401',
          },
        ],
      }),
      'prod',
    ).value
    expect(out).toContain('href="/jobs/j1"')
    expect(out).toContain('voice')
    expect(out).toContain('elevenlabs 401')
  })

  it('distinguishes a budget block from a crash', () => {
    const out = renderOverviewPage(
      data({
        attention: [
          {
            id: 'j1',
            channel: 'space',
            topic: 'Venus',
            status: 'blocked',
            stage: null,
            error: null,
          },
        ],
      }),
      'prod',
    ).value
    expect(out).toContain('status-blocked')
    expect(out).toContain('budget')
  })

  it('flags an expired lease', () => {
    const out = renderOverviewPage(
      data({
        leases: [
          {
            name: 'produce',
            holder: 'host-1',
            expiresAt: '2026-07-25T11:00:00.000Z',
            expired: true,
          },
        ],
      }),
      'prod',
    ).value
    expect(out).toContain('expired')
  })

  it('warns when spend is over cap', () => {
    const out = renderOverviewPage(
      data({ globalSpend: { spentUsdMicros: 13_000_000, capUsdMicros: 12_000_000 } }),
      'prod',
    ).value
    expect(out).toContain('over cap')
  })

  it('surfaces a channel config error without hiding the rest', () => {
    const out = renderOverviewPage(data(), 'prod', 'channels/bad.toml: boom').value
    expect(out).toContain('boom')
    expect(out).toContain('class="warning"')
    expect(out).toContain('$2.50')
  })

  it('renders the unattributed spend row when it is greater than zero', () => {
    const out = renderOverviewPage(data({ unattributedUsdMicros: 1_500_000 }), 'prod').value
    expect(out).toContain('unattributed')
    expect(out).toContain('$1.50')
  })

  it('does not render the unattributed spend row when it is zero', () => {
    const out = renderOverviewPage(data({ unattributedUsdMicros: 0 }), 'prod').value
    expect(out).not.toContain('unattributed')
  })

  it('escapes a hostile topic in the attention list', () => {
    const out = renderOverviewPage(
      data({
        attention: [
          {
            id: 'j1',
            channel: 'space',
            topic: '<script>alert(1)</script>',
            status: 'failed',
            stage: 'voice',
            error: null,
          },
        ],
      }),
      'prod',
    ).value
    expect(out).not.toContain('<script>alert(1)</script>')
  })
})
