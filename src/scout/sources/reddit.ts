import { z } from 'zod'
import { BrainrotError } from '../../errors.js'
import { storyBody } from '../../stories/body.js'
import { classifyTarget } from './post-kind.js'
import type { FetchLike, TrendCandidate, TrendSource, TrendSourceFetchOpts } from './types.js'

// Reddit renders the submission target as an anchor whose text is literally
// "[link]" in a permalink's Atom comment feed. prune-media is the only reader
// left: it re-fetches that feed from reddit.com to recover the target of a
// topic scouted before targets were recorded.
//
// fast-xml-parser has already entity-decoded the <content> body, so this
// matches plain HTML, not the encoded form on the wire.
const LINK_ANCHOR = /href="([^"]+)"[^>]*>\s*\[link\]/

export function redditLinkTarget(contentHtml: string | undefined): string | undefined {
  if (contentHtml === undefined) return undefined
  return LINK_ANCHOR.exec(contentHtml)?.[1]
}

// What reddit substitutes for the name of an account that no longer exists.
const DELETED_AUTHOR = '[deleted]'

function authorName(author: string | null | undefined): string | undefined {
  const name = author?.trim()
  return name === undefined || name === '' || name === DELETED_AUTHOR ? undefined : name
}

// Reddit's own bot account, plus every subreddit's moderator account. Both
// post recurring scheduled or announcement threads — "All Space Questions
// thread for week of ...", r/AmItheAsshole's "Quarterly Open Forum" — which
// are never viable topics and, because each instance is a distinct t3_ id, are
// never caught by dedupe. Matched case-insensitively: names are fixed but
// their casing in the feed is not guaranteed.
export const AUTOMATED_AUTHORS = new Set(['automoderator'])

// Moderator accounts are named by convention, not enumerable: AITAMod,
// ModTeam, AskHistorians-Mods. Note "ModTeam" ends in "team", not "mod", so
// a single `mods?$` alternative would miss it. Matching the suffix costs at
// most one dropped post from a human whose name happens to end in "mod" —
// cheap against an announcement thread that otherwise consumes a scoring
// slot every week forever.
const MODERATOR_SUFFIX = /mods?$|modteam$/i

export function isAutomatedAuthor(author: string | undefined): boolean {
  if (author === undefined) return false
  return AUTOMATED_AUTHORS.has(author.toLowerCase()) || MODERATOR_SUFFIX.test(author)
}

// Reddit blocks default library user agents; a descriptive UA is the
// documented convention for public feed access. Sent to Arctic Shift too — a
// free service whose operator asks callers to be considerate.
export const REDDIT_USER_AGENT =
  'brainrot-machine/0.1 (personal short-form pipeline; single operator)'

// Reddit's rate limit on the public feed is effectively one request per
// window: a single GET drives `x-ratelimit-remaining` to 0.0, and three
// back-to-back GETs return 429 for all but the first (observed 2026-07-27,
// which also confirmed reddit sends no Retry-After — only x-ratelimit-*).
// ~20s spacing is what actually got through.
//
// So a 429 here is the ordinary case whenever anything else has touched
// reddit recently — another source in the same tick, a `topics prune-media`
// run, a second process — not an outage. Backing off and retrying once is
// what makes a multi-source tick work at all.
//
// This is a retry rather than an unconditional delay between sources on
// purpose: it costs nothing when the budget is free, and adapts when some
// other caller has spent it. A fixed inter-source sleep would pay the full
// delay every tick and still not cover the other-caller case.
export const REDDIT_RETRY_DELAY_MS = 20_000

// prune-media.ts paces its reddit.com refetches with this too.
export function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RedditFetchOpts {
  fetchImpl: FetchLike
  timeoutMs: number
  retryDelayMs?: number
}

/**
 * GET a reddit.com feed with the conventional UA, a timeout, and one 429
 * backoff. prune-media's only: redditSource reads through Arctic Shift.
 *
 * Returns the Response as-is — including a still-429 one after the retry — so
 * the caller decides what a failure means: prune-media records a skip and
 * moves to the next row.
 */
export async function fetchRedditFeed(url: string, opts: RedditFetchOpts): Promise<Response> {
  const get = (): Promise<Response> =>
    opts.fetchImpl(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  const res = await get()
  if (res.status !== 429) return res
  await sleep(opts.retryDelayMs ?? REDDIT_RETRY_DELAY_MS)
  return get()
}

// Reddit itself is unreachable keyless: it 403s hot.json unauthenticated
// (observed live 2026-07-21), rate-limits the public Atom feed to about one
// request per window, and gates Data API app creation behind manual approval.
// So subreddits are read through Arctic Shift, a public archive that ingests
// posts within minutes and serves them keyless as JSON. It makes no uptime
// promises; https://status.arctic-shift.photon-reddit.com is the first place
// to look when this source starts erroring.
export const ARCTIC_SHIFT_BASE_URL = 'https://arctic-shift.photon-reddit.com'

// Asking for `selftext` is what makes md2html=true add `selftext_html`, the
// rendered body storyBody reads. `permalink` is not a selectable field; the
// candidate's url is rebuilt from `id` instead.
const ARCTIC_SHIFT_FIELDS = 'id,title,author,selftext,url'

const REDDIT_ORIGIN = 'https://www.reddit.com'

// Reddit's own rule for subreddit names. Checked up front because Arctic
// Shift answers a malformed or unknown name with 200 and an empty list: a
// `r/space` typo would otherwise read as a quiet subreddit forever. (A
// well-formed name for a subreddit that does not exist still passes.)
const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,21}$/

const envelopeSchema = z.object({ data: z.array(z.unknown()) })

// Strict on what a candidate cannot exist without, lenient on the rest: a
// deleted post's `url` is "", and `selftext_html` is absent when there is no
// selftext at all.
const postSchema = z.object({
  id: z.string().regex(/^(?:t3_)?[0-9a-z]+$/),
  title: z.string().trim().min(1),
  author: z.string().nullish(),
  selftext: z.string().nullish(),
  selftext_html: z.string().nullish(),
  url: z.string().nullish(),
})
type ArcticShiftPost = z.infer<typeof postSchema>

// Reddit's own listing never shows a removed post; the archive keeps it, with
// its body replaced by one of these placeholders (or, for a site-level
// removal, its title too). Dropped here rather than annotated for the scout
// to count, because the reddit.com feed this source replaced never returned
// them either — they are not candidates the pipeline ever saw.
const REMOVED_SELFTEXT = new Set(['[removed]', '[deleted]'])
const REMOVED_BY_REDDIT = '[ Removed by Reddit'

function isRemoved(post: ArcticShiftPost): boolean {
  const selftext = post.selftext ?? ''
  return (
    REMOVED_SELFTEXT.has(selftext) ||
    selftext.startsWith(REMOVED_BY_REDDIT) ||
    post.title.startsWith(REMOVED_BY_REDDIT)
  )
}

// `url` is the submission target: a self post's own permalink, a link post's
// destination. A crosspost's is its parent's permalink, served relative.
function submissionTarget(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined || url === '') return undefined
  return url.startsWith('/') ? new URL(url, REDDIT_ORIGIN).href : url
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// The API reports failure as `{"data":null,"error":"…"}` — with a 400 for a bad
// parameter, and sometimes a 200 (a query timeout).
function apiError(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
  return typeof body.error === 'string' ? body.error : undefined
}

export function redditSource(subreddit: string, fetchImpl: FetchLike = fetch): TrendSource {
  if (!SUBREDDIT_NAME.test(subreddit)) {
    throw new BrainrotError(`redditSource: "${subreddit}" is not a subreddit name`, {
      domain: 'config',
      kind: 'invalid',
    })
  }
  const id = `reddit:r/${subreddit}`
  const fail = (detail: string): BrainrotError =>
    new BrainrotError(`redditSource: r/${subreddit} ${detail}`, {
      domain: 'scout',
      kind: 'transient',
    })
  return {
    id,
    async fetch({ limit, timeoutMs }: TrendSourceFetchOpts): Promise<TrendCandidate[]> {
      // sort=desc is newest first. The archive has no "hot" ranking, and its
      // scores stay near zero for the first ~36h, so recency is the order.
      const params = new URLSearchParams({
        subreddit,
        sort: 'desc',
        limit: String(limit),
        md2html: 'true',
        fields: ARCTIC_SHIFT_FIELDS,
      })
      // No retry, 429 included: the next scout attempt is SCOUT_RECHECK_MS
      // away, and Arctic Shift's limit is generous enough ("a couple requests
      // per second") that one GET per subreddit per attempt never nears it.
      const res = await fetchImpl(`${ARCTIC_SHIFT_BASE_URL}/api/posts/search?${params}`, {
        headers: { 'User-Agent': REDDIT_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = parseJson(await res.text())
      const error = apiError(body)
      if (!res.ok) throw fail(`responded ${res.status}${error === undefined ? '' : `: ${error}`}`)
      if (error !== undefined) throw fail(`returned an error: ${error}`)
      if (body === undefined) throw fail('returned a non-JSON response')

      const envelope = envelopeSchema.safeParse(body)
      if (!envelope.success) {
        throw fail(`returned an unrecognized response: ${envelope.error.issues[0].message}`)
      }
      // A single odd post is skipped, as the Atom parser skipped an entry
      // missing its id or title — but every post failing is API drift.
      const posts = envelope.data.data.flatMap((raw) => {
        const post = postSchema.safeParse(raw)
        return post.success ? [post.data] : []
      })
      if (posts.length === 0 && envelope.data.data.length > 0) {
        throw fail('returned an unrecognized response: no post matched the expected shape')
      }

      return (
        posts
          .filter((post) => !isRemoved(post))
          // The API already honors `limit`; this keeps the contract local.
          .slice(0, limit)
          .map((post) => {
            const postId = post.id.replace(/^t3_/, '')
            const targetUrl = submissionTarget(post.url)
            const author = authorName(post.author)
            // Annotate only — dropping media, automated and bodyless
            // candidates is scoutChannel's call, so it can count them.
            return {
              title: post.title,
              // Always the comments permalink, whatever the post links to:
              // the story outro, the dashboard link and prune-media read it.
              url: `${REDDIT_ORIGIN}/r/${subreddit}/comments/${postId}/`,
              sourceId: id,
              // The t3_ fullname is what the reddit.com feed keyed on, so
              // dedupe hashes carry across the transport change.
              externalId: `t3_${postId}`,
              targetUrl,
              postKind: classifyTarget(targetUrl),
              author,
              automated: isAutomatedAuthor(author),
              body: storyBody(post.selftext_html ?? undefined),
            }
          })
      )
    },
  }
}
