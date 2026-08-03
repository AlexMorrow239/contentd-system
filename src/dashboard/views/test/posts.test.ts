import { describe, expect, it } from 'vitest'
import type { PostLogEntry } from '../../queries/posts.js'
import { renderPostLogPage } from '../posts.js'

function entry(overrides: Partial<PostLogEntry> = {}): PostLogEntry {
  return {
    jobId: 'j1',
    channel: 'space',
    platform: 'youtube',
    topic: 'Venus',
    url: 'https://youtube.com/shorts/j1',
    postedAt: '2026-07-25T09:00:00.000Z',
    ...overrides,
  }
}

describe('renderPostLogPage', () => {
  it('links a posted entry to its url', () => {
    const out = renderPostLogPage({ entries: [entry()] }).value
    expect(out).toContain('https://youtube.com/shorts/j1')
    expect(out).toContain('<a href="https://youtube.com/shorts/j1"')
  })

  it('renders the row without a link when url is null', () => {
    const out = renderPostLogPage({ entries: [entry({ url: null })] }).value
    expect(out).not.toContain('<a href=""')
    expect(out).not.toContain('href="null"')
  })

  it('lists entries reverse-chronologically as given, without re-sorting', () => {
    const rows = [
      entry({ jobId: 'j2', topic: 'Mars', postedAt: '2026-07-26T09:00:00.000Z' }),
      entry({ jobId: 'j1', topic: 'Venus', postedAt: '2026-07-25T09:00:00.000Z' }),
    ]
    const out = renderPostLogPage({ entries: rows }).value
    expect(out.indexOf('Mars')).toBeLessThan(out.indexOf('Venus'))
  })

  it('escapes a topic title containing markup', () => {
    const out = renderPostLogPage({
      entries: [entry({ topic: '<script>alert(1)</script>' })],
    }).value
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('blocks a javascript: url instead of linking it', () => {
    const out = renderPostLogPage({ entries: [entry({ url: 'javascript:alert(1)' })] }).value
    expect(out).not.toContain('href="javascript:alert(1)"')
  })

  it('says so when there are no posts yet', () => {
    const out = renderPostLogPage({ entries: [] }).value
    expect(out).toContain('no posts yet')
  })
})
