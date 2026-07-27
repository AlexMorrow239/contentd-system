import { XMLParser } from 'fast-xml-parser'
import { BrainrotError } from '../../errors.js'
import type { TrendCandidate } from './types.js'

// Shared RSS 2.0 / Atom parsing. Both the generic rssSource and the keyless
// reddit path consume it: reddit's public .rss feed is an ordinary Atom
// document, and its <entry><id> is the t3_ fullname the JSON API reports as
// `data.name` — so a candidate's externalId is identical whichever path
// fetched it, keeping dedupe hashes stable across a switch.

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
    // <content> and <author><name> are standard Atom elements, so reading them
    // belongs here; what they *mean* is source-specific and stays out of this
    // module.
    const author = text((entry.author as Record<string, unknown> | undefined)?.name)
    out.push({
      title,
      url: link ?? '',
      sourceId,
      externalId,
      contentHtml: text(entry.content),
      author,
    })
  }
  return out
}

/**
 * Parse one feed document into candidates. `label` names the fetched resource
 * in the not-a-feed error so the caller's own id (a feed URL, a subreddit)
 * reaches the operator.
 */
export function parseFeedCandidates(
  xml: string,
  sourceId: string,
  label: string,
): TrendCandidate[] {
  const doc = parser.parse(xml) as ParsedFeed
  if (doc.rss?.channel !== undefined) {
    return rssItems(asArray(doc.rss.channel.item), sourceId)
  }
  if (doc.feed !== undefined) {
    return atomEntries(asArray(doc.feed.entry), sourceId)
  }
  throw new BrainrotError(`${label} is not a recognized RSS 2.0 or Atom feed`, {
    domain: 'scout',
    kind: 'transient',
  })
}
