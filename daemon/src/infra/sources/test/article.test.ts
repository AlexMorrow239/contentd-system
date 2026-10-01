import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createTestTime } from '../../../../testing/time.js'
import {
  extractArticle,
  fetchArticle,
  isPublicAddress,
  publicLookup,
  readPageBody,
} from '../article.js'

vi.mock('node:dns', () => ({ lookup: vi.fn() }))

// Select the production call's all-addresses overload for the typed network stub.
const lookupAll = lookup as (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

function responseBody(body: Buffer, encoding?: string): IncomingMessage {
  const stream = Readable.from([body]) as IncomingMessage
  stream.headers = encoding ? { 'content-encoding': encoding } : {}
  return stream
}

const html = `<html><head><title>Company results</title><meta name="author" content="Jane Reporter"></head><body><nav>Ignore this menu</nav><article><h1>Company results</h1>${'<p>The company reported revenue growth of twelve percent, driven by overseas sales. Management expects operating margins to improve next year.</p>'.repeat(12)}</article><script>throw new Error('must not execute')</script></body></html>`

describe('article context', () => {
  it('extracts article substance and metadata without executing page scripts', () => {
    const article = extractArticle(html, 'https://news.example/results')
    expect(article.body).toContain('revenue growth of twelve percent')
    expect(article.body).not.toContain('Ignore this menu')
    expect(article.body).not.toContain('must not execute')
    expect(article.title).toBe('Company results')
    expect(article.author).toBe('Jane Reporter')
  })

  it('bounds article metadata even when a page supplies an enormous description', () => {
    const article = extractArticle(
      `<html><head><title>Title</title><meta name="description" content="${'x'.repeat(100_000)}"></head><body>No article</body></html>`,
      'https://news.example/story',
    )
    expect(article.excerpt!.length).toBeLessThanOrEqual(2000)
  })

  it('validates every DNS address and passes only the checked addresses to the connection', async () => {
    vi.mocked(lookupAll).mockImplementation((_host, _options, callback) =>
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    )
    const denied = await new Promise((resolve) =>
      publicLookup('news.example', { all: true }, (err) => resolve(err)),
    )
    expect(denied).toBeInstanceOf(Error)
    vi.mocked(lookupAll).mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: '8.8.8.8', family: 4 }]),
    )
    const addresses = await new Promise((resolve, reject) =>
      publicLookup('news.example', { all: true }, (err, address) =>
        err ? reject(err) : resolve(address),
      ),
    )
    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }])
  })

  it('limits decompressed bytes, including highly compressed oversized pages', async () => {
    const small = responseBody(gzipSync(Buffer.from('<html>Readable</html>')), 'gzip')
    expect(await readPageBody(small)).toBe('<html>Readable</html>')
    const oversized = responseBody(gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 'x')), 'gzip')
    await expect(readPageBody(oversized)).rejects.toThrow(/decoded response limit/)
    expect(oversized.destroyed).toBe(true)
  })

  it('propagates a broken response through the decompressor', async () => {
    const response = new Readable({
      read() {
        this.destroy(new Error('connection closed'))
      },
    }) as IncomingMessage
    response.headers = { 'content-encoding': 'gzip' }
    await expect(readPageBody(response)).rejects.toThrow('connection closed')
  })

  it('closes the response when the server uses an unsupported encoding', async () => {
    const response = responseBody(Buffer.from('unreadable'), 'unknown')
    await expect(readPageBody(response)).rejects.toThrow('Unsupported article encoding')
    expect(response.destroyed).toBe(true)
  })

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })

  it('follows an article redirect and records the final URL', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 302, headers: { location: '/story' }, body: '' })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html' }, body: html })
    const article = await fetchArticle('https://news.example/redirect', {
      request,
      time: createTestTime(0),
    })
    expect(article.url).toBe('https://news.example/story')
    expect(article.body).toContain('twelve percent')
  })

  it('rejects redirects to private addresses before sending a second request', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1/secret' },
      body: '',
    })
    await expect(
      fetchArticle('https://news.example/start', { request, time: createTestTime(0) }),
    ).rejects.toThrow(/public/i)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops after three redirects', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 302, headers: { location: '/again' }, body: '' })
    await expect(
      fetchArticle('https://news.example/start', { request, time: createTestTime(0) }),
    ).rejects.toThrow(/redirect/i)
    expect(request).toHaveBeenCalledTimes(4)
  })

  it.each([
    'https://www.reddit.com/r/stocks/comments/abc/',
    'https://reddit.com./r/stocks/comments/abc/',
    'https://redd.it/abc',
  ])('rejects article redirects to Reddit: %s', async (location) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 302, headers: { location }, body: '' })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html' }, body: html })
    await expect(
      fetchArticle('https://news.example/start', { request, time: createTestTime(0) }),
    ).rejects.toThrow(/Reddit/)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 403, headers: { 'content-type': 'text/html' }, body: 'blocked' },
    { status: 200, headers: { 'content-type': 'application/pdf' }, body: 'pdf' },
  ])('rejects blocked or unsupported responses', async (response) => {
    await expect(
      fetchArticle('https://news.example/story', {
        request: async () => response,
        time: createTestTime(0),
      }),
    ).rejects.toThrow()
  })

  it('cancels slow retrieval after fifteen seconds and cleans up its deadline', async () => {
    const time = createTestTime(0)
    const request = (_url: URL, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('request aborted')), {
          once: true,
        }),
      )
    const result = fetchArticle('https://news.example/story', { request, time }).catch(
      (err: unknown) => err,
    )
    await time.advanceBy(15_000)
    expect(await result).toBeInstanceOf(Error)
    expect(time.pendingTimerCount()).toBe(0)
  })
})
