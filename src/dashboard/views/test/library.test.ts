import { describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../../queries/library.js'
import { renderLibraryPage, type LibraryPageData } from '../library.js'

const baseEntry: LibraryEntry = {
  jobId: 'j1',
  channel: 'space',
  topic: 'Why Venus is hot',
  state: 'needs-review',
  videoPath: 'runs/j1/assemble/final.mp4',
  createdAt: '2026-07-25T10:00:00.000Z',
  qc: { kind: 'ok' },
  bytes: 'local',
  links: [],
}

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    jobId: 'job-1',
    channel: 'chan-a',
    topic: 'a topic',
    state: 'published',
    videoPath: '/runs/job-1/assemble/final.mp4',
    createdAt: '2026-07-26T00:00:00.000Z',
    qc: { kind: 'ok' },
    bytes: 'local',
    links: [],
    ...overrides,
  }
}

function pageData(entries: LibraryEntry[]): LibraryPageData {
  return { entries, channels: ['chan-a'], filter: {}, csrfToken: 'tok', daemonStale: false }
}

describe('renderLibraryPage', () => {
  it('embeds a player pointing at the streaming route', () => {
    const out = renderLibraryPage({
      entries: [baseEntry],
      channels: ['space'],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('<video controls preload="metadata" src="/library/j1/video">')
  })

  it('lists qc issues', () => {
    const out = renderLibraryPage({
      entries: [{ ...baseEntry, qc: { kind: 'issues', issues: ['duration 71s > 60s'] } }],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('duration 71s &gt; 60s')
  })

  it('says unparseable rather than pretending qc passed', () => {
    const out = renderLibraryPage({
      entries: [{ ...baseEntry, qc: { kind: 'unparseable' } }],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('unparseable metadata')
  })

  it('links back to the job drill-in', () => {
    const out = renderLibraryPage({
      entries: [baseEntry],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('href="/jobs/j1"')
  })

  it('reports an empty library plainly', () => {
    const out = renderLibraryPage({
      entries: [],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('no library entries match')
  })

  it('escapes a hostile topic', () => {
    const out = renderLibraryPage({
      entries: [{ ...baseEntry, topic: '<img src=x onerror=alert(1)>' }],
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('<img src=x')
  })

  it('shows a truncation notice when the 200-row cap cut the list', () => {
    const out = renderLibraryPage({
      entries: [baseEntry],
      total: 1432,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('showing 1 of 1,432')
  })

  it('shows no truncation notice when the total equals what is shown', () => {
    const out = renderLibraryPage({
      entries: [baseEntry],
      total: 1,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('showing')
  })

  it('renders a player for a local video', () => {
    const html = renderLibraryPage(pageData([entry({ bytes: 'local' })])).value
    expect(html).toContain('<video controls')
  })

  it('renders the archived note instead of a player', () => {
    const html = renderLibraryPage(pageData([entry({ bytes: 'archived' })])).value
    expect(html).not.toContain('<video controls')
    expect(html).toContain('archived to object storage')
  })

  it('renders the reclaimed note instead of a player', () => {
    const html = renderLibraryPage(pageData([entry({ bytes: 'reclaimed' })])).value
    expect(html).not.toContain('<video controls')
    expect(html).toContain('reclaimed')
  })

  it('renders the unstored note instead of a player, naming the fix', () => {
    const html = renderLibraryPage(pageData([entry({ bytes: 'unstored' })])).value
    expect(html).not.toContain('<video controls')
    expect(html).toContain('library backfill-store')
  })

  it('does not render a javascript: url as a clickable link', () => {
    const html = renderLibraryPage(
      pageData([entry({ links: [{ platform: 'youtube', url: 'javascript:alert(1)' }] })]),
    ).value
    expect(html).not.toContain('href="javascript:alert(1)"')
    expect(html).not.toMatch(/href=["']javascript:/i)
  })

  it('renders one link per platform', () => {
    const html = renderLibraryPage(
      pageData([entry({ links: [{ platform: 'youtube', url: 'https://youtu.be/abc' }] })]),
    ).value
    expect(html).toContain('href="https://youtu.be/abc"')
    expect(html).toContain('youtube')
  })

  it('escapes a hostile url', () => {
    const html = renderLibraryPage(
      pageData([entry({ links: [{ platform: 'youtube', url: 'https://x/"><script>alert(1)</script>' }] })]),
    ).value
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('offers approve on a needs-review row only', () => {
    const out = renderLibraryPage({
      entries: [entry({ jobId: 'j1', state: 'needs-review' }), entry({ jobId: 'j2', state: 'ready' })],
      total: 2,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).toContain('name="kind" value="library.approve"')
    expect(out).toContain('name="jobIds" value="j1"')
    expect(out).not.toContain('name="jobIds" value="j2"')
  })

  it('offers no reject control yet', () => {
    // library.reject also deletes stored objects, so it is a slow-lane action
    // and lands in phase 2. A control here would enqueue a kind with no handler.
    const out = renderLibraryPage({
      entries: [entry({ jobId: 'j1', state: 'needs-review' })],
      total: 1,
      channels: [],
      filter: {},
      csrfToken: 'tok',
      daemonStale: false,
    }).value
    expect(out).not.toContain('library.reject')
  })
})
