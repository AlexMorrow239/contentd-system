import { describe, expect, it } from 'vitest'
import type { PublishRow } from '../../../publish/publishes.js'
import { cellKey } from '../../queries/publishes.js'
import type { PlatformQuotaView } from '../publishes.js'
import { renderPublishesPage } from '../publishes.js'

const YOUTUBE_QUOTA: PlatformQuotaView = {
  platform: 'youtube',
  scope: 'global',
  used: 2,
  backedOff: false,
}

function row(overrides: Partial<PublishRow> = {}): PublishRow {
  return {
    id: 1,
    jobId: 'j1',
    platform: 'youtube',
    channel: 'space',
    day: '2026-07-25',
    seq: 1,
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
        rows: [{ platform: 'youtube' as const, seq: 1 }],
        days: ['2026-07-25'],
        cells,
      },
    ],
    days: 1,
    quotas: [YOUTUBE_QUOTA],
    interrupted: [],
    csrfToken: 'tok',
    daemonStale: false,
  }
}

describe('renderPublishesPage', () => {
  it('links a done cell to the published video', () => {
    const cells = new Map([[cellKey('2026-07-25', 1, 'youtube'), row()]])
    const out = renderPublishesPage(pageData(cells)).value
    expect(out).toContain('https://youtube.com/shorts/abc')
    expect(out).toContain('status-done')
  })

  it('shows an ordinal that was never reached as a visible gap', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    expect(out).toContain('cell-empty')
  })

  it('shows error kind and attempt on a failed cell', () => {
    const cells = new Map([
      [
        cellKey('2026-07-25', 1, 'youtube'),
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
      [cellKey('2026-07-25', 1, 'youtube'), row({ url: 'javascript:alert(1)' })],
    ])
    const out = renderPublishesPage(pageData(cells)).value
    expect(out).not.toContain('href="javascript:alert(1)"')
    expect(out).not.toContain('<a href="javascript:')
  })

  it('labels each row with its platform, and keeps same-ordinal platforms in separate rows', () => {
    // Regression for the cellKey collision bug: two platforms sharing an
    // ordinal must render as two distinct rows/cells, not overwrite one another.
    const cells = new Map([
      [
        cellKey('2026-07-25', 2, 'youtube'),
        row({ platform: 'youtube', status: 'done', url: 'https://youtube.com/shorts/yt1' }),
      ],
      [
        cellKey('2026-07-25', 2, 'instagram'),
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
            { platform: 'instagram' as const, seq: 2 },
            { platform: 'youtube' as const, seq: 2 },
          ],
          days: ['2026-07-25'],
          cells,
        },
      ],
      days: 1,
      quotas: [
        { platform: 'youtube', scope: 'global', used: 0, backedOff: false },
      ] as PlatformQuotaView[],
      interrupted: [],
      csrfToken: 'tok',
      daemonStale: false,
    }
    const out = renderPublishesPage(data).value
    expect(out).toContain('#2 instagram')
    expect(out).toContain('#2 youtube')
    expect(out).toContain('https://youtube.com/shorts/yt1')
    expect(out).toContain('transient')
  })

  it('reports today upload usage with no cap figure', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    expect(out).toContain('2 uploads used today')
  })

  it('shows a backed-off badge for a global-scope quota when backed off', () => {
    const out = renderPublishesPage({
      ...pageData(new Map()),
      quotas: [
        { platform: 'youtube', scope: 'global', used: 2, backedOff: true },
      ] as PlatformQuotaView[],
    }).value
    expect(out).toContain('backed off')
  })

  it('does not show a backed-off badge for a global-scope quota when not backed off', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    expect(out).not.toContain('backed off')
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
      quotas: [{ platform: 'youtube', scope: 'global', used: 0, backedOff: false }],
      interrupted: [],
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('no channel has a [publish] schedule')
  })

  it('reports a channel-scoped quota as a per-channel breakdown, not a summed total', () => {
    const data = {
      ...pageData(new Map()),
      quotas: [
        YOUTUBE_QUOTA,
        {
          platform: 'instagram',
          scope: 'channel',
          perChannel: [
            { channel: 'space', used: 5, backedOff: false },
            { channel: 'history', used: 25, backedOff: true },
          ],
        },
      ] as PlatformQuotaView[],
    }
    const out = renderPublishesPage(data).value
    expect(out).toContain('space: 5 uploads used today')
    expect(out).toContain('history: 25 uploads used today')
    // The backed-off channel is flagged; the other must not be.
    const historyIdx = out.indexOf('history: 25 uploads used today')
    expect(out.slice(historyIdx, historyIdx + 80)).toContain('backed off')
    const spaceIdx = out.indexOf('space: 5 uploads used today')
    expect(out.slice(spaceIdx, spaceIdx + 80)).not.toContain('backed off')
  })

  it('says so when no channel has a channel-scoped platform configured', () => {
    const data = {
      ...pageData(new Map()),
      quotas: [
        YOUTUBE_QUOTA,
        { platform: 'instagram', scope: 'channel', perChannel: [] },
      ] as PlatformQuotaView[],
    }
    const out = renderPublishesPage(data).value
    expect(out).toContain('instagram: no channel has a [publish.instagram] target configured')
  })

  it('lists interrupted uploads with both resolution controls', () => {
    const out = renderPublishesPage({
      grids: [],
      days: 14,
      quotas: [],
      interrupted: [
        { jobId: 'j1', channel: 'chan-a', platform: 'youtube', createdAt: '2026-08-01T10:00:00Z' },
      ],
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('interrupted uploads')
    expect(out).toContain('name="kind" value="publish.retry"')
    // mark-done needs confirming, so it is a link to the interstitial, not a form.
    expect(out).toContain('/actions/confirm?kind=publish.markDone')
  })

  it('omits the interrupted section when there is nothing to resolve', () => {
    const out = renderPublishesPage({
      grids: [],
      days: 14,
      quotas: [],
      interrupted: [],
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('interrupted uploads')
  })

  it('offers publish-next behind a confirm link and the dry run as a plain form', () => {
    const out = renderPublishesPage(pageData(new Map())).value
    // confirm:true renders a GET link to the interstitial, never a POST form.
    expect(out).toContain('/actions/confirm?kind=publish.next')
    // confirm:false renders the form directly.
    expect(out).toContain('value="publish.nextDryRun"')
  })
})
