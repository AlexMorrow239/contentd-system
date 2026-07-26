import { describe, expect, it } from 'vitest'
import type { PublishRow } from '../../publish/publishes.js'
import { cellKey } from '../queries/publishes.js'
import { renderPublishesPage } from './publishes.js'

function row(overrides: Partial<PublishRow> = {}): PublishRow {
  return {
    id: 1,
    jobId: 'j1',
    platform: 'youtube',
    channel: 'space',
    day: '2026-07-25',
    slot: '09:00',
    status: 'done',
    postId: 'abc',
    url: 'https://youtube.com/shorts/abc',
    error: null,
    errorKind: null,
    attempt: 1,
    createdAt: '2026-07-25T09:00:00.000Z',
    finishedAt: '2026-07-25T09:01:00.000Z',
    ...overrides,
  }
}

function pageData(cells: Map<string, PublishRow>) {
  return {
    grids: [
      {
        channel: 'space',
        rows: [{ platform: 'youtube' as const, slot: '09:00' }],
        days: ['2026-07-25'],
        cells,
      },
    ],
    days: 1,
    quotaUsed: 2,
    quotaCap: 6,
    dbChoice: 'prod' as const,
  }
}

describe('renderPublishesPage', () => {
  it('links a done cell to the published video', () => {
    const cells = new Map([[cellKey('2026-07-25', '09:00', 'youtube'), row()]])
    const out = renderPublishesPage(pageData(cells)).value
    expect(out).toContain('https://youtube.com/shorts/abc')
    expect(out).toContain('status-done')
  })

  it('shows an unfilled slot as a visible gap', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    expect(out).toContain('slot-empty')
  })

  it('shows error kind and attempt on a failed cell', () => {
    const cells = new Map([
      [
        cellKey('2026-07-25', '09:00', 'youtube'),
        row({ status: 'failed', errorKind: 'quota', attempt: 3, url: null, postId: null }),
      ],
    ])
    const out = renderPublishesPage(pageData(cells)).value
    expect(out).toContain('quota')
    expect(out).toContain('attempt 3')
  })

  it('blocks a javascript: url instead of linking it', () => {
    // Not currently reachable — url is constructed server-side with a fixed
    // https:// scheme — but applying the same control as topics.ts keeps the
    // hardening from quietly regressing if that ever changes.
    const cells = new Map([
      [cellKey('2026-07-25', '09:00', 'youtube'), row({ url: 'javascript:alert(1)' })],
    ])
    const out = renderPublishesPage(pageData(cells)).value
    expect(out).not.toContain('href="javascript:alert(1)"')
    expect(out).not.toContain('<a href="javascript:')
  })

  it('labels each row with its platform, and keeps same-slot platforms in separate rows', () => {
    // Regression for the cellKey collision bug: two platforms sharing a slot
    // time must render as two distinct rows/cells, not overwrite one another.
    const cells = new Map([
      [
        cellKey('2026-07-25', '10:00', 'youtube'),
        row({ platform: 'youtube', status: 'done', url: 'https://youtube.com/shorts/yt1' }),
      ],
      [
        cellKey('2026-07-25', '10:00', 'instagram'),
        row({
          platform: 'instagram',
          status: 'failed',
          errorKind: 'transient',
          url: null,
          postId: null,
        }),
      ],
    ])
    const data = {
      grids: [
        {
          channel: 'space',
          rows: [
            { platform: 'instagram' as const, slot: '10:00' },
            { platform: 'youtube' as const, slot: '10:00' },
          ],
          days: ['2026-07-25'],
          cells,
        },
      ],
      days: 1,
      quotaUsed: 0,
      quotaCap: 6,
      dbChoice: 'prod' as const,
    }
    const out = renderPublishesPage(data).value
    expect(out).toContain('10:00 instagram')
    expect(out).toContain('10:00 youtube')
    expect(out).toContain('https://youtube.com/shorts/yt1')
    expect(out).toContain('transient')
  })

  it('reports quota consumption against the cap', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    expect(out).toContain('2 / 6')
  })

  it('surfaces a channel config error without hiding the rest of the page', () => {
    const data = { ...pageData(new Map()), configError: 'channels/bad.toml: unexpected token' }
    const out = renderPublishesPage(data).value
    expect(out).toContain('unexpected token')
    expect(out).toContain('class="warning"')
    expect(out).toContain('space')
  })

  it('says so when no channel has a publish schedule', () => {
    const out = renderPublishesPage({
      grids: [],
      days: 7,
      quotaUsed: 0,
      quotaCap: 6,
      dbChoice: 'prod',
    }).value
    expect(out).toContain('no channel has a [publish] schedule')
  })
})
