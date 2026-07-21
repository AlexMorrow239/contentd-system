import { XMLParser } from 'fast-xml-parser'
import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Attributes stay on: an Atom <link> carries its URL as @_href, and an RSS
// <guid isPermaLink="..."> parses to { '#text': ..., '@_isPermaLink': ... }.
// Tag values stay un-coerced: identity fields (guid/id) must keep their exact
// text — a numeric-looking guid like "007" must not become the number 7,
// which would collapse it with a distinct "07" guid and corrupt the dedupe hash.
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false })

// Element shapes of interest in fast-xml-parser output. Leaves stay loose:
// real-world feeds omit and duplicate elements freely, so every field is
// probed, never trusted.
interface ParsedFeed {
  rss?: { channel?: { item?: Record<string, unknown> | Record<string, unknown>[] } }
  feed?: { entry?: Record<string, unknown> | Record<string, unknown>[] }
}

// Text of a parsed node: plain scalar, or the '#text' of an attributed node.
// Tag values arrive as strings (parseTagValue: false, above); the number
// branch stays only as a defensive fallback for attribute values, which
// fast-xml-parser also leaves un-coerced by default but is not guaranteed to.
function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'object' && value !== null && '#text' in value) {
    return text((value as Record<string, unknown>)['#text'])
  }
  return undefined
}

function rssItems(items: Record<string, unknown>[], sourceId: string): TrendCandidate[] {
  const out: TrendCandidate[] = []
  for (const item of items) {
    const title = text(item.title)
    const link = text(item.link)
    const externalId = text(item.guid) ?? link
    // No title or no stable identity → the item can be neither scored nor deduped.
    if (title === undefined || externalId === undefined) continue
    out.push({ title, url: link ?? '', sourceId, externalId })
  }
  return out
}

// fast-xml-parser yields an object (not a one-element array) for elements
// that appear exactly once.
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

// Atom <link> is href-in-attribute and may repeat per rel; the alternate (or
// rel-less) link is the canonical page URL (RFC 4287 §4.2.7.2).
function atomLinkHref(value: unknown): string | undefined {
  const links = asArray(value as Record<string, unknown> | Record<string, unknown>[] | undefined)
  const preferred =
    links.find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate') ?? links[0]
  if (preferred === undefined) return undefined
  return text(preferred['@_href'])
}

function atomEntries(entries: Record<string, unknown>[], sourceId: string): TrendCandidate[] {
  const out: TrendCandidate[] = []
  for (const entry of entries) {
    const title = text(entry.title)
    const link = atomLinkHref(entry.link)
    const externalId = text(entry.id) ?? link
    if (title === undefined || externalId === undefined) continue
    out.push({ title, url: link ?? '', sourceId, externalId })
  }
  return out
}

export function rssSource(feedUrl: string, fetchImpl: FetchLike = fetch): TrendSource {
  const id = `rss:${new URL(feedUrl).hostname}`
  return {
    id,
    async fetch(opts: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(opts.timeoutMs) })
      if (!res.ok) {
        throw new Error(`rssSource: ${feedUrl} responded ${res.status}`)
      }
      const doc = parser.parse(await res.text()) as ParsedFeed
      let candidates: TrendCandidate[]
      if (doc.rss?.channel !== undefined) {
        candidates = rssItems(asArray(doc.rss.channel.item), id)
      } else if (doc.feed !== undefined) {
        candidates = atomEntries(asArray(doc.feed.entry), id)
      } else {
        throw new Error(`rssSource: ${feedUrl} is not a recognized RSS 2.0 or Atom feed`)
      }
      // Feeds have no server-side limit parameter — cap client-side to honor
      // the channel's per_source_limit.
      return candidates.slice(0, opts.limit)
    },
  }
}
