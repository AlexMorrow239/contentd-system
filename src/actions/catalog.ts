import { z } from 'zod'
import { BrainrotError } from '../errors.js'
import { PLATFORMS } from '../posts/types.js'

/**
 * The action catalog: pure metadata, no behaviour. This module is imported by
 * BOTH the dashboard (to render forms and validate submitted args) and the
 * daemon (to route to a handler), which is exactly why it must stay free of
 * heavy imports. The implementations live in ./handlers.ts, which the
 * dashboard may never import — an arch lint in src/arch.test.ts enforces
 * this. Same discipline as DASHBOARD_STAGE_ORDER: a read-only viewer has no
 * business loading Remotion, Anthropic or credential code.
 */

/**
 * `fast` = completes in milliseconds: local SQLite reads/writes and, as
 * `digest.run` shows, a config-directory read — but never a network call, a
 * provider call, or a render. `slow` = anything that can take seconds or
 * longer (a render, an upload, a provider call).
 */
export type ActionLane = 'fast' | 'slow'

/** The lease an action must hold, named exactly as the daemon's workers name it. */
export type ActionLease = 'produce' | 'scout'

/**
 * Every entry spells out EVERY key, `undefined` included. `as const satisfies`
 * drops an absent optional key from the resulting literal type, so omitting
 * `lease`/`danger` makes `ACTIONS[kind].lease` a compile error the moment
 * `kind` is widened to the union — which is exactly how the worker and the
 * confirm interstitial read them.
 */
export interface ActionDescriptor {
  lane: ActionLane
  /** Button text and the name shown on the /actions page. */
  label: string
  /** Route through the confirmation interstitial before enqueueing. */
  confirm: boolean
  /** Shown on the interstitial. Required in practice whenever confirm is true. */
  danger?: string
  lease?: ActionLease
  args: z.ZodTypeAny
}

/**
 * A form field arrives as a string, and a single-valued field is not an array
 * — so every list argument wraps its element schema in this. `undefined`
 * becomes `[]` so the `.min(1)` below is what reports an empty submission,
 * rather than a confusing "expected array, received undefined".
 */
function list<T extends z.ZodTypeAny>(inner: T): z.ZodType<z.infer<T>[]> {
  return z.preprocess(
    (v) => (Array.isArray(v) ? (v as unknown[]) : v === undefined ? [] : [v]),
    z.array(inner).min(1),
  )
}

/**
 * A checkbox. Unchecked submits NOTHING (undefined), checked submits its
 * value. Deliberately not `z.coerce.boolean()`, which returns true for the
 * string "false" — a trap that would turn every dry-run toggle into a live run.
 */
function flag(): z.ZodType<boolean> {
  return z.preprocess((v) => v === '1' || v === 'on' || v === true, z.boolean())
}

/**
 * An optional free-text field. A blank input submits `''`, which `.optional()`
 * alone would happily accept as a present-but-empty value — for a channel
 * filter that is the difference between "all channels" and "the channel named
 * empty string". Same shape as `optionalUrl` above, without the url check.
 */
const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().min(1).optional(),
)

const topicId = z.coerce.number().int().positive()
const jobId = z.string().trim().min(1)
const platform = z.enum(PLATFORMS)
// A form submits an untouched text field as ''. That means "not provided",
// not "the url is the empty string", so it must become undefined before the
// DAO stores it — otherwise the library page would render an empty <a href>.
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().url().optional(),
)

export const ACTIONS = {
  'topics.reject': {
    lane: 'fast',
    label: 'reject',
    confirm: false,
    danger: undefined,
    lease: undefined,
    args: z.object({ ids: list(topicId) }),
  },
  'topics.requeue': {
    lane: 'fast',
    label: 'requeue',
    confirm: false,
    danger: undefined,
    lease: undefined,
    args: z.object({ id: topicId }),
  },
  'library.approve': {
    lane: 'fast',
    label: 'approve',
    confirm: false,
    danger: undefined,
    lease: undefined,
    args: z.object({ jobIds: list(jobId) }),
  },
  'digest.run': {
    lane: 'fast',
    label: 'run digest',
    confirm: false,
    danger: undefined,
    lease: undefined,
    args: z.object({}),
  },
  'produce.next': {
    lane: 'slow',
    label: 'produce next',
    confirm: true,
    danger:
      'Runs one produce tick: claims the highest-scoring topic and renders a video. ' +
      'This spends real money on the script, the voice and the captions.',
    // NOT a mistake: produceNextTick acquires the `produce` lease itself.
    // Declaring it here would make the worker hold the lease the tick then
    // fails to take, turning every click into a lease-held noop.
    lease: undefined,
    args: z.object({}),
  },
  'jobs.produce': {
    lane: 'slow',
    label: 'produce',
    confirm: true,
    danger:
      'Renders a brand-new video for this channel on the topic you typed. This ' +
      'spends real money on the script, the voice and the captions, and takes ' +
      'minutes. Nothing is posted anywhere — the video lands in the library.',
    // runJob does not lease — the CLI's `produce` runs outside every lease on
    // purpose. Taking `produce` here is what makes the dashboard path
    // race-free against the daemon's own produce worker. Contrast
    // `produce.next` directly above, which must declare NO lease because
    // produceNextTick acquires one itself.
    lease: 'produce',
    args: z.object({
      // A channel NAME, not a path: the handler resolves it inside
      // channelsDir. An operator-supplied path would be a file-read primitive
      // on a process that holds credentials. This is the one place the action
      // deliberately differs from the CLI, whose --channel takes a path.
      channel: z.string().trim().min(1),
      topic: z.string().trim().min(1),
    }),
  },
  'scout.run': {
    lane: 'slow',
    label: 'scout now',
    confirm: false,
    danger: undefined,
    // Unlike the tick actions, `scoutAll` does NOT lease — the CLI command and
    // the daemon's scoutUnit each lease around it, so this action must too.
    lease: 'scout',
    args: z.object({}),
  },
  'jobs.resume': {
    lane: 'slow',
    label: 'resume',
    confirm: true,
    danger:
      'Re-runs this job from its first unfinished stage. Completed stages are ' +
      'skipped, but every stage that does run again spends real money.',
    // resumeJob does not lease; the CLI's `resume` runs outside every lease on
    // purpose. Here the worker takes `produce`, which is what makes the
    // dashboard path race-free where the CLI path is not.
    lease: 'produce',
    args: z.object({ jobId }),
  },
  'post.mark': {
    lane: 'fast',
    label: 'mark posted',
    confirm: false,
    danger: undefined,
    // No lease: `posts` is a table no worker touches, so there is nothing to
    // race. This is why FAST_ACTION_LEASE_TTL_MS could go with the old
    // publish actions — no fast action leases any more.
    lease: undefined,
    args: z.object({ jobId, platform, url: optionalUrl }),
  },
  'post.unmark': {
    lane: 'fast',
    label: 'unmark',
    confirm: true,
    danger:
      'Removes the record that this video was posted to this platform, including ' +
      'the saved link. It does not delete anything on the platform itself.',
    lease: undefined,
    args: z.object({ jobId, platform }),
  },
  'library.reject': {
    // Slow, not fast: the handler makes real network calls (a dynamic S3
    // import plus one store.delete() per object, sequentially), and the fast
    // lane also carries the daemon heartbeat — a slow or unreachable bucket
    // during a multi-job discard must not stall the heartbeat and trip the
    // dashboard's 409 liveness gate. No lease: it races no worker, and the
    // object deletes are idempotent.
    lane: 'slow',
    label: 'discard',
    confirm: true,
    danger:
      'Discards this video: it leaves the posting queue and stops counting toward ' +
      'the channel backlog, so production can resume. Its stored bytes are freed.',
    lease: undefined,
    args: z.object({ jobIds: list(jobId) }),
  },
  'library.backfillStore': {
    lane: 'slow',
    label: 'backfill store',
    confirm: true,
    danger:
      'Uploads every finished video that has no stored object yet. This can be ' +
      'a lot of bytes and costs whatever your object storage charges for them.',
    // No lease: it races no worker. The reclaim sweep deletes only objects
    // whose library_objects row survives, and this uploads only rows with no
    // such row at all — the two cannot collide on the same job.
    lease: undefined,
    args: z.object({}),
  },
  'topics.pruneMedia': {
    lane: 'slow',
    label: 'prune media',
    confirm: true,
    danger:
      'Re-fetches every scouted reddit candidate and rejects the ones that ' +
      'point at an image. Reddit rate-limits this to roughly one row every ' +
      '20 seconds, so it runs for minutes. Tick "dry run" to preview instead.',
    // pruneMedia mutates `topics`, which is the scout tick's table — the same
    // reason scout.run declares this lease.
    lease: 'scout',
    args: z.object({ channel: optionalText, dryRun: flag() }),
  },
} as const satisfies Record<string, ActionDescriptor>

export type ActionKind = keyof typeof ACTIONS
export type ActionArgs<K extends ActionKind> = z.infer<(typeof ACTIONS)[K]['args']>

export const ACTION_KINDS = Object.keys(ACTIONS) as ActionKind[]

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value)
}

/**
 * The argument names an action accepts, in declaration order. The confirm
 * interstitial uses this to decide which fields it already has and which it
 * must ask the operator for.
 *
 * Derived from the schema rather than declared alongside it, so the two can
 * never drift. `instanceof z.ZodObject` and `.shape` are both public zod API —
 * this deliberately does not reach into zod internals.
 */
export function actionArgNames(kind: ActionKind): string[] {
  const schema: z.ZodTypeAny = ACTIONS[kind].args
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
}

/**
 * Validates raw (form- or JSON-derived) args against the catalog schema.
 * A zod failure becomes a BrainrotError so both callers — the dashboard's POST
 * route and the worker's dispatcher — get one classifiable error shape instead
 * of a ZodError leaking into a 500.
 */
export function parseActionArgs(kind: ActionKind, raw: unknown): unknown {
  const parsed = ACTIONS[kind].args.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => {
        const path = i.path.join('.')
        return `${path === '' ? '(root)' : path}: ${i.message}`
      })
      .join('; ')
    throw new BrainrotError(`invalid arguments for ${kind} — ${detail}`, {
      domain: 'config',
      kind: 'invalid',
    })
  }
  return parsed.data
}

/**
 * Collapses form entries into an args object: a key appearing more than once
 * becomes an array, a key appearing once stays scalar. `list()` above is what
 * reconciles the two shapes, so a one-checkbox and a three-checkbox submission
 * both parse.
 */
export function formToArgs(entries: [string, string][]): Record<string, string | string[]> {
  // Object.create(null) rather than `{}`: a field literally named
  // `__proto__` appearing twice would otherwise reach the array branch below
  // and assign onto Object.prototype. Inert today — none of the keys this
  // route reads off the result exist on Array.prototype — but this function
  // is the first thing in the codebase to see unauthenticated form input, so
  // the hazard is closed structurally rather than left to depend on that
  // staying true.
  const out = Object.create(null) as Record<string, string | string[]>
  for (const [key, value] of entries) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}
