import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionDetail, SafeLink, Video } from './ui'
import { memDb, seedAction } from '../../src/testing/db'
import { getAction } from '../../src/actions/queue'

describe('dashboard components', () => {
  it('escapes untrusted text and refuses executable external links', () => {
    const html = renderToStaticMarkup(
      <SafeLink url="javascript:alert(1)">{'<script>alert(1)</script>'}</SafeLink>,
    )
    expect(html).not.toContain('href=')
    expect(html).toContain('&lt;script&gt;')
    expect(renderToStaticMarkup(<SafeLink url="https://example.com">post</SafeLink>)).toContain(
      'rel="noopener noreferrer"',
    )
  })
  it('only provides a video source for local bytes', () => {
    expect(renderToStaticMarkup(<Video bytes="local" jobId="job-a" />)).toContain(
      '/library/job-a/video',
    )
    for (const bytes of ['archived', 'reclaimed', 'unstored'] as const) {
      const html = renderToStaticMarkup(<Video bytes={bytes} jobId="job-a" />)
      expect(html).not.toContain('<video')
      expect(html).not.toContain('src=')
    }
  })
  it('keeps recovery notices visible alongside failures', () => {
    const db = memDb()
    const id = seedAction(db, {
      status: 'failed',
      error: 'interrupted',
      errorKind: 'internal',
      notice: 'jobId=job-recover',
    })
    const action = getAction(db, id)!
    const html = renderToStaticMarkup(<ActionDetail action={action} />)
    expect(html).toContain('interrupted')
    expect(html).toContain('jobId=job-recover')
  })
})
