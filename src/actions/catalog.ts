import { z } from 'zod'
import { BrainrotError } from '../errors.js'

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
export type ActionLease = 'produce' | 'publish' | 'scout'

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

const topicId = z.coerce.number().int().positive()
const jobId = z.string().trim().min(1)

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
  'publish.retry': {
    lane: 'fast',
    label: 'retry',
    confirm: false,
    danger: undefined,
    lease: 'publish',
    args: z.object({ jobId }),
  },
  'publish.markDone': {
    lane: 'fast',
    label: 'mark done',
    confirm: true,
    danger:
      'Records this upload as published without contacting the platform. ' +
      'Only do this after confirming the post exists. It cannot be undone.',
    lease: 'publish',
    args: z.object({ jobId, postId: z.string().trim().min(1) }),
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
  'publish.next': {
    lane: 'slow',
    label: 'publish next',
    confirm: true,
    danger:
      'Uploads the next due video to every platform its channel declares. ' +
      'This posts publicly and cannot be undone.',
    // publishNextTick acquires the `publish` lease itself — see produce.next.
    lease: undefined,
    args: z.object({}),
  },
  'publish.nextDryRun': {
    lane: 'slow',
    label: 'publish next (dry run)',
    confirm: false,
    danger: undefined,
    // A dry run takes no lease at all, in the tick or here.
    lease: undefined,
    args: z.object({}),
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
