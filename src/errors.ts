/**
 * The single error vocabulary for the whole codebase.
 *
 * This module imports nothing from `src/`, and that is load-bearing rather
 * than incidental: providers, stages, loops and the dashboard all import it,
 * so any dependency added here becomes a dependency of everything. The old
 * `providers/errors.ts` documented the same property about itself; this
 * generalizes it.
 *
 * Two axes:
 *   - `domain` — whose contract broke
 *   - `kind`   — what kind of break it was
 *
 * A surface matches at whichever width it needs: `kind === 'transient'` for
 * anything worth another tick, or `domain === 'publish' && kind === 'auth'`
 * for one specific condition.
 *
 * There is deliberately NO `retryable` boolean. It would be a lie: 'transient'
 * retries next tick, 'quota' tomorrow, 'budget' after a cap change, and
 * 'unknown-outcome' must never retry at all. Retry meaning is per-surface, and
 * publish-next.ts already maps kind -> row status correctly.
 */

export type ErrorDomain =
  | 'publish'
  | 'storage'
  | 'provider'
  | 'config'
  | 'job'
  | 'scout'
  | 'internal'

export type ErrorKind =
  | 'auth' // credential missing, expired, or refused
  | 'quota' // an external cap was hit
  | 'budget' // OUR OWN spend cap refused the call before it fired
  | 'invalid' // malformed input we can see
  | 'not-found' // the addressed thing does not exist
  | 'rejected' // remote understood the request and refused it on the merits
  | 'conflict' // someone else holds it, or state moved under us
  | 'refused' // a precondition says don't — an operator answer, not a fault
  | 'transient' // likely fine next tick
  | 'unknown-outcome' // the side effect may have landed; do NOT blindly retry
  | 'internal' // a bug, or an unclassified foreign throw

export interface ErrorInfo {
  domain: ErrorDomain
  kind: ErrorKind
  /** `${domain}/${kind}` — for log lines. Never parsed for control flow. */
  code: string
  message: string
  context: Readonly<Record<string, unknown>>
}

export interface ErrorTag {
  domain: ErrorDomain
  kind: ErrorKind
  context?: Record<string, unknown>
}

/**
 * The classification hung on errors this codebase does not construct. A symbol
 * so it can never collide with a provider SDK's own fields, and so it stays
 * out of `Object.keys` and `JSON.stringify`.
 */
const TAG = Symbol.for('brainrot.errorTag')

export class BrainrotError extends Error {
  readonly domain: ErrorDomain
  readonly kind: ErrorKind
  readonly context: Readonly<Record<string, unknown>>

  constructor(
    message: string,
    opts: {
      domain: ErrorDomain
      kind: ErrorKind
      context?: Record<string, unknown>
      cause?: unknown
    },
  ) {
    // Passing `{ cause: undefined }` would define an own `cause` property set
    // to undefined, which reads differently from "no cause" in a log dump.
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'BrainrotError'
    this.domain = opts.domain
    this.kind = opts.kind
    this.context = Object.freeze({ ...opts.context })
  }

  get code(): string {
    return `${this.domain}/${this.kind}`
  }
}

/**
 * The message of any thrown value. Replaces the
 * `err instanceof Error ? err.message : String(err)` ternary that had been
 * copied into 13 files, and is byte-identical to it for every input that
 * ternary could handle — plus it survives a value whose `String()` throws
 * (`Object.create(null)`), which the ternary propagated out of the catch.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return String(err)
  } catch {
    return '[unstringifiable thrown value]'
  }
}

/**
 * Attach a classification to an error whose IDENTITY MUST SURVIVE — the case
 * this exists for is `providers/anthropic.ts`, which keeps throwing a real
 * `ZodError` so its callers and tests still match `instanceof z.ZodError`.
 * Returns the same object, unchanged apart from a non-enumerable symbol.
 *
 * Prefer throwing a `BrainrotError` when you own the error. Reach for this
 * only when you don't.
 *
 * Unlike `classify`, this is NOT total: `Object.defineProperty` throws on a
 * frozen or sealed object, which would otherwise replace the original error
 * inside the caller's own catch block. Tagging is best-effort — on failure
 * this silently returns `err` untagged rather than throwing, since no SDK
 * currently in this tree freezes its error objects and a dropped tag is far
 * cheaper than losing the error being classified.
 */
export function tagError<E>(err: E, tag: ErrorTag): E {
  if (err !== null && typeof err === 'object') {
    try {
      Object.defineProperty(err, TAG, {
        value: tag,
        configurable: true,
        enumerable: false,
        writable: true,
      })
    } catch {
      // Best-effort: see docstring above.
    }
  }
  return err
}

function readErrorTag(err: unknown): ErrorTag | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const tag = (err as Record<PropertyKey, unknown>)[TAG]
  if (tag === null || typeof tag !== 'object') return undefined
  return tag as ErrorTag
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({})

/**
 * Classify any thrown value. Total: never throws, accepts anything, and is
 * safe at the top-level catch sites where the thrown value genuinely is
 * unknown. A `BrainrotError` reports its own fields; a tagged foreign error
 * reports the tag's; everything else is `internal/internal`.
 *
 * `domain`/`kind` always come from the BrainrotError's own fields — a tag can
 * never override an error's classification. A tag's `context` DOES merge in,
 * though: tagging an already-thrown `BrainrotError` (e.g. scout tagging a
 * `BudgetExceededError` with its partial progress before re-throwing) is how
 * that extra context reaches `errorContext()`. On a key collision the error's
 * own `context` wins, since it is the more authoritative, original source.
 */
export function classify(err: unknown): ErrorInfo {
  const message = errorMessage(err)
  if (err instanceof BrainrotError) {
    const tag = readErrorTag(err)
    return {
      domain: err.domain,
      kind: err.kind,
      code: err.code,
      message,
      context:
        tag?.context === undefined
          ? err.context
          : Object.freeze({ ...tag.context, ...err.context }),
    }
  }
  const tag = readErrorTag(err)
  if (tag !== undefined) {
    return {
      domain: tag.domain,
      kind: tag.kind,
      code: `${tag.domain}/${tag.kind}`,
      message,
      context: Object.freeze({ ...tag.context }),
    }
  }
  return {
    domain: 'internal',
    kind: 'internal',
    code: 'internal/internal',
    message,
    context: EMPTY_CONTEXT,
  }
}

/**
 * The structured payload riding on a thrown value, whether it is one of ours
 * or a tagged foreign error. This is the single mechanism replacing the two
 * that grew independently: `errorCostUsdMicros`'s duck-typed `costUsdMicros`
 * read, and `scout.ts`'s private PARTIAL_RESULT symbol.
 */
export function errorContext(err: unknown): Readonly<Record<string, unknown>> {
  return classify(err).context
}

/**
 * True for the errors `AbortSignal.timeout()` produces on expiry or abort.
 * Replaces the `err.name === 'TimeoutError' || err.name === 'AbortError'`
 * check that appeared verbatim in three files.
 */
export function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}
