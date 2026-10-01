import { describe, expect, it, vi } from 'vitest'
import { arcticShiftJson, fetchStub } from '../../../../testing/arctic-shift.js'
import { bindSourceTopic, sourcePost } from '../../../../testing/context.js'
import { makeCtx } from '../../../../testing/job.js'
import { collectContext } from './collect.js'

const articleHtml = `<html><head><title>Quarterly results</title></head><body><article>${'<p>The firm earned $47 million and increased overseas revenue by twelve percent. Analysts noted this was stronger than expected.</p>'.repeat(15)}</article></body></html>`
const request = () =>
  Promise.resolve({ status: 200, headers: { 'content-type': 'text/html' }, body: articleHtml })

describe('collectContext', () => {
  it('collects source facts and reuses the persisted snapshot on a later attempt', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx)
    const first = await collectContext(ctx, { request })
    expect(first.promptContext).toContain('Revenue increased twelve percent.')
    expect(first.promptContext).toContain('$47 million')
    expect(first.promptContext).toContain('Original revenue report')
    expect(first.article?.url).toBe('https://news.example/results')
    const second = await collectContext(
      { ...ctx, attemptId: 'next' },
      {
        request: () => {
          throw new Error('must not refetch')
        },
      },
    )
    expect(second).toEqual(first)
  })

  it('continues with post text when the article is blocked, preserving the failure', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx)
    const result = await collectContext(ctx, {
      request: async () => ({ status: 403, headers: {}, body: '' }),
    })
    expect(result.promptContext).toContain('Revenue increased twelve percent.')
    expect(result.promptContext).toContain('403')
    expect(result.warnings).toHaveLength(1)
    expect(await collectContext(ctx, { request })).toEqual(result)
  })

  it('recovers a legacy Reddit post by ID without requesting Reddit directly', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx, { sourceContext: undefined })
    const fetchImpl = vi.fn(
      fetchStub({
        '/api/posts/ids?ids=abc': arcticShiftJson([
          {
            id: 'abc',
            title: 'Archived headline',
            body: 'Recovered original post.',
            target: 'https://news.example/results',
          },
        ]),
      }),
    )
    const result = await collectContext(ctx, { request, fetchImpl })
    expect(result.promptContext).toContain('Recovered original post.')
    expect(result.source?.externalId).toBe('t3_abc')
    const input = fetchImpl.mock.calls[0][0]
    expect(input instanceof Request ? input.url : input.toString()).toContain(
      'https://arctic-shift.photon-reddit.com/api/posts/ids?',
    )
  })

  it('uses a historical RSS article URL without attempting a Reddit lookup', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx, {
      source: 'rss:news.example',
      sourceContext: undefined,
      url: 'https://news.example/results',
      targetUrl: undefined,
    })
    const result = await collectContext(ctx, {
      request,
      fetchImpl: () => {
        throw new Error('unexpected archive lookup')
      },
    })
    expect(result.promptContext).toContain('$47 million')
  })

  it('keeps manual topics offline and does not invent source context', async () => {
    const ctx = makeCtx()
    const result = await collectContext(ctx, {
      request: () => {
        throw new Error('unexpected article')
      },
    })
    expect(result.source).toBeNull()
    expect(result.promptContext).toBe('')
  })

  it('continues with a headline and explicit gaps if both lookups fail', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx, { sourceContext: undefined })
    const result = await collectContext(ctx, {
      fetchImpl: async () => {
        throw new Error('archive unavailable')
      },
      request: async () => {
        throw new Error('article unavailable')
      },
    })
    expect(result.promptContext).toContain('Original revenue report')
    expect(result.promptContext).toContain('archive unavailable')
    expect(result.promptContext).toContain('article unavailable')
    expect(result.promptContext).toContain('No post body available')
  })

  it('does not visit Reddit permalinks as articles', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx, {
      sourceContext: sourcePost({ targetUrl: 'https://www.reddit.com/r/stocks/comments/abc/' }),
    })
    const result = await collectContext(ctx, {
      request: () => {
        throw new Error('must not fetch Reddit')
      },
    })
    expect(result.article).toBeNull()
    expect(result.warnings).toEqual([])
  })

  it('stops on ownership loss and leaves no snapshot', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx)
    let owned = true
    ctx.assertOwned = () => {
      if (!owned) throw new Error('lease lost')
    }
    await expect(
      collectContext(ctx, {
        request: async () => {
          owned = false
          return request()
        },
      }),
    ).rejects.toThrow('lease lost')
    expect(
      ctx.db.prepare('SELECT source_context_json FROM jobs WHERE id = ?').get(ctx.jobId),
    ).toEqual({ source_context_json: null })
  })

  it('propagates cancellation instead of committing a best-effort fallback', async () => {
    const ctx = makeCtx()
    bindSourceTopic(ctx)
    const controller = new AbortController()
    const reason = new Error('production cancelled')
    ctx.signal = controller.signal
    await expect(
      collectContext(ctx, {
        request: async () => {
          controller.abort(reason)
          throw reason
        },
      }),
    ).rejects.toBe(reason)
    expect(
      ctx.db.prepare('SELECT source_context_json FROM jobs WHERE id = ?').get(ctx.jobId),
    ).toEqual({ source_context_json: null })
  })
})
