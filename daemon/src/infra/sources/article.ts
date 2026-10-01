import { Readability } from '@mozilla/readability'
import ipaddr from 'ipaddr.js'
import { JSDOM, VirtualConsole } from 'jsdom'
import { lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Article } from '../../shared/contracts/source-context.js'
import { createDeadline, type TimeSource } from '../../shared/time.js'

export const ARTICLE_MAX_BYTES = 2 * 1024 * 1024

export interface PageResponse {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

export type PageRequest = (url: URL, signal: AbortSignal) => Promise<PageResponse>

export function isPublicAddress(address: string): boolean {
  try {
    // Mapped IPv4 and transition addresses are intentionally not accepted.
    return ipaddr.parse(address).range() === 'unicast'
  } catch {
    return false
  }
}

export function publicUrl(raw: string): URL {
  const url = new URL(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (isIP(host) !== 0 && !isPublicAddress(host))
  ) {
    throw new Error('Article URL must point to a public HTTP(S) destination without credentials')
  }
  if (isRedditUrl(url)) throw new Error('Reddit pages are not article sources')
  return url
}

export function isRedditUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'reddit.com' ||
    host.endsWith('.reddit.com') ||
    host === 'redd.it' ||
    host.endsWith('.redd.it')
  )
}

/** Validate the addresses actually used to connect, avoiding a DNS check/connect race. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4)
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('Article hostname must resolve only to public addresses'), '', 4)
    }
    const first = addresses[0]
    if (options.all) callback(null, addresses)
    else callback(null, first.address, first.family)
  })
}

export async function readPageBody(response: IncomingMessage): Promise<string> {
  const encoding = response.headers['content-encoding']?.toLowerCase()
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null
  if (encoding && encoding !== 'identity' && !decoder) {
    response.destroy()
    throw new Error('Unsupported article encoding')
  }
  const onError = (err: Error): void => {
    decoder?.destroy(err)
  }
  response.on('error', onError)
  const stream = decoder === null ? response : response.pipe(decoder)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += bytes.length
      if (size > ARTICLE_MAX_BYTES)
        throw new Error('Article exceeds the 2 MiB decoded response limit')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    response.off('error', onError)
    stream.destroy()
    response.destroy()
  }
}

export const requestPublicPage: PageRequest = (url, signal) => {
  publicUrl(url.href)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      url,
      {
        method: 'GET',
        signal,
        agent: false,
        lookup: publicLookup,
        headers: {
          'User-Agent': 'brainrot-machine/0.1 (article context)',
          Accept: 'text/html, application/xhtml+xml',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        const headers = response.headers
        if (
          status !== 200 ||
          !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(headers['content-type'] ?? '')
        ) {
          response.destroy()
          resolve({ status, headers, body: '' })
          return
        }
        void readPageBody(response).then((body) => resolve({ status, headers, body }), reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

export function extractArticle(html: string, url: string): Article {
  // No runScripts or resources option: scripts, frames and subresources stay disabled.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() })
  try {
    const document = dom.window.document
    const title = document.title || null
    const excerpt =
      document
        .querySelector('meta[name="description"], meta[property="og:description"]')
        ?.getAttribute('content') ?? null
    const result = new Readability(document, { maxElemsToParse: 50_000 }).parse()
    return {
      url,
      title: (result?.title || title)?.slice(0, 1000) ?? null,
      body: result?.textContent?.trim() || null,
      author: result?.byline?.slice(0, 500) || null,
      publishedAt: result?.publishedTime?.slice(0, 100) || null,
      excerpt: (result?.excerpt || excerpt)?.slice(0, 2000) ?? null,
    }
  } finally {
    dom.window.close()
  }
}

export async function fetchArticle(
  rawUrl: string,
  opts: {
    time: TimeSource
    signal?: AbortSignal
    request?: PageRequest
  },
): Promise<Article> {
  const deadline = createDeadline(opts.time, 15_000, opts.signal)
  const request = opts.request ?? requestPublicPage
  try {
    let url = publicUrl(rawUrl)
    for (let redirects = 0; ; redirects++) {
      deadline.signal.throwIfAborted()
      const response = await request(url, deadline.signal)
      deadline.signal.throwIfAborted()
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3 || !response.headers.location)
          throw new Error('Article redirect limit or missing location')
        url = publicUrl(new URL(response.headers.location, url).href)
        continue
      }
      if (response.status !== 200) throw new Error(`Article responded HTTP ${response.status}`)
      if (
        !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
          response.headers['content-type'] ?? '',
        )
      )
        throw new Error('Unsupported article content type')
      if (Buffer.byteLength(response.body, 'utf8') > ARTICLE_MAX_BYTES)
        throw new Error('Article exceeds the 2 MiB decoded response limit')
      const article = extractArticle(response.body, url.href)
      deadline.signal.throwIfAborted()
      return article
    }
  } catch (err) {
    opts.signal?.throwIfAborted()
    throw err
  } finally {
    deadline.dispose()
  }
}
