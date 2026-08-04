import { describe, expect, it } from 'vitest'
import type { TopicRow } from '../../../scout/topics.js'
import { renderTopicsPage } from '../topics.js'

function topic(overrides: Partial<TopicRow> = {}): TopicRow {
  return {
    id: 1,
    channel: 'space',
    title: 'Why Venus is hot',
    rawTitle: 'why venus is hot',
    source: 'reddit:r/space',
    url: 'https://reddit.com/r/space/1',
    targetUrl: null,
    bodyText: null,
    seriesKey: null,
    partIndex: null,
    partCount: null,
    truncated: false,
    dedupeHash: 'abc',
    score: 82,
    reason: 'strong hook',
    status: 'candidate',
    jobId: null,
    createdAt: '2026-07-25T10:00:00.000Z',
    ...overrides,
  }
}

describe('renderTopicsPage', () => {
  it('sorts by score descending, highest first', () => {
    const out = renderTopicsPage({
      topics: [
        topic({ id: 1, score: 40, title: 'low' }),
        topic({ id: 2, score: 90, title: 'high' }),
      ],
      channels: ['space'],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out.indexOf('high')).toBeLessThan(out.indexOf('low'))
  })

  it('links the source url', () => {
    const out = renderTopicsPage({
      topics: [topic()],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('href="https://reddit.com/r/space/1"')
    expect(out).toContain('reddit:r/space')
  })

  it('links a claimed topic to the job that took it', () => {
    const out = renderTopicsPage({
      topics: [topic({ status: 'claimed', jobId: 'j9' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('href="/jobs/j9"')
  })

  it('shows the scout reason', () => {
    const out = renderTopicsPage({
      topics: [topic({ reason: 'strong hook' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('strong hook')
  })

  it('escapes a hostile scraped title', () => {
    // These come straight off Reddit and RSS.
    const out = renderTopicsPage({
      topics: [topic({ title: '<script>alert(1)</script>' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('<script>alert(1)</script>')
  })

  it('escapes a hostile url so it cannot break the attribute', () => {
    const out = renderTopicsPage({
      topics: [topic({ url: 'https://x/"onmouseover="alert(1)' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('onmouseover="alert(1)"')
    expect(out).toContain('&quot;onmouseover=')
  })

  it('blocks a javascript: url instead of linking it', () => {
    const out = renderTopicsPage({
      topics: [topic({ url: 'javascript:alert(1)', source: 'reddit:r/space' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('href="javascript:alert(1)"')
    expect(out).not.toContain('<a href="javascript:')
    expect(out).toContain('reddit:r/space')
  })

  it('reports an empty queue plainly', () => {
    const out = renderTopicsPage({
      topics: [],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('no topics match')
  })

  it('shows a truncation notice when the 200-row cap cut the list', () => {
    const out = renderTopicsPage({
      topics: [topic()],
      total: 1432,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('showing 1 of 1,432')
  })

  it('shows no truncation notice when the total equals what is shown', () => {
    const out = renderTopicsPage({
      topics: [topic()],
      total: 1,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('showing')
  })

  it('offers reject on a candidate and requeue on a claimed topic', () => {
    const out = renderTopicsPage({
      topics: [topic({ id: 1, status: 'candidate' }), topic({ id: 2, status: 'claimed', title: 'b' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('name="kind" value="topics.reject"')
    expect(out).toContain('name="kind" value="topics.requeue"')
  })

  it('offers nothing on a terminal topic', () => {
    // The page itself now carries a scout-now control, so this checks the
    // row-level actions specifically rather than every "name=kind" on the
    // page.
    const out = renderTopicsPage({
      topics: [topic({ id: 1, status: 'rejected' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('value="topics.reject"')
    expect(out).not.toContain('value="topics.requeue"')
  })

  it('disables the controls and warns when the daemon is down', () => {
    const out = renderTopicsPage({
      topics: [topic({ id: 1, status: 'candidate' })],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: true,
    }).value
    expect(out).toContain('daemon not running')
    expect(out).toContain('disabled')
  })

  it('offers a scout-now control that posts to the queue', () => {
    const out = renderTopicsPage({
      topics: [],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('value="scout.run"')
    expect(out).toContain('scout now')
  })

  it('disables the scout-now control while the daemon is stale', () => {
    const out = renderTopicsPage({
      topics: [],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: true,
    }).value
    expect(out).toMatch(/<button[^>]*disabled/)
  })

  it('offers prune-media alongside scout-now', () => {
    const out = renderTopicsPage({
      topics: [],
      channels: ['alpha'],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('/actions/confirm?kind=topics.pruneMedia')
  })
})
