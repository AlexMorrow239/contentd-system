import { describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../queries/library.js'
import { renderLibraryPage } from './library.js'

const entry: LibraryEntry = {
  jobId: 'j1',
  channel: 'space',
  topic: 'Why Venus is hot',
  state: 'needs-review',
  videoPath: 'runs/j1/assemble/final.mp4',
  createdAt: '2026-07-25T10:00:00.000Z',
  qc: { kind: 'ok' },
}

describe('renderLibraryPage', () => {
  it('embeds a player pointing at the streaming route', () => {
    const out = renderLibraryPage({
      entries: [entry],
      channels: ['space'],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('<video controls preload="metadata" src="/library/j1/video">')
  })

  it('keeps the dev selection on the video URL', () => {
    const out = renderLibraryPage({
      entries: [entry],
      channels: [],
      filter: {},
      dbChoice: 'dev',
    }).value
    expect(out).toContain('src="/library/j1/video?db=dev"')
  })

  it('lists qc issues', () => {
    const out = renderLibraryPage({
      entries: [{ ...entry, qc: { kind: 'issues', issues: ['duration 71s > 60s'] } }],
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('duration 71s &gt; 60s')
  })

  it('says unparseable rather than pretending qc passed', () => {
    const out = renderLibraryPage({
      entries: [{ ...entry, qc: { kind: 'unparseable' } }],
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('unparseable metadata')
  })

  it('links back to the job drill-in', () => {
    const out = renderLibraryPage({
      entries: [entry],
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('href="/jobs/j1"')
  })

  it('reports an empty library plainly', () => {
    const out = renderLibraryPage({
      entries: [],
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).toContain('no library entries match')
  })

  it('escapes a hostile topic', () => {
    const out = renderLibraryPage({
      entries: [{ ...entry, topic: '<img src=x onerror=alert(1)>' }],
      channels: [],
      filter: {},
      dbChoice: 'prod',
    }).value
    expect(out).not.toContain('<img src=x')
  })
})
