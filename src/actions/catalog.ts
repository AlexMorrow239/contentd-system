import { z } from 'zod'
import { BrainrotError } from '../errors.js'

/**
 * The action catalog: pure metadata, no behaviour. This module is imported by
 * BOTH the dashboard (to render forms and validate submitted args) and the
 * daemon (to route to a handler), which is exactly why it must stay free of
 * heavy imports. The implementations live in ./handlers.ts, which the
 * dashboard may never import — src/arch.test.ts enforces it. Same discipline
 * as DASHBOARD_STAGE_ORDER: a read-only viewer has no business loading
 * Remotion, Anthropic or credential code.
 */

/** `fast` = a few SQL statements, no network, no filesystem. `slow` = anything else. */
export type ActionLane = 'fast' | 'slow'

/** The lease an action must hold, named exactly as the daemon's workers name it. */
export type ActionLease = 'produce' | 'publish' | 'scout'

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
function list<T extends z.ZodTypeAny>(inner: T): z.ZodTypeAny {
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
    lease: undefined,
    args: z.object({ ids: list(topicId) }),
  },
  'topics.requeue': {
    lane: 'fast',
    label: 'requeue',
    confirm: false,
    lease: undefined,
    args: z.object({ id: topicId }),
  },
  'library.approve': {
    lane: 'fast',
    label: 'approve',
    confirm: false,
    lease: undefined,
    args: z.object({ jobIds: list(jobId) }),
  },
  'publish.retry': {
    lane: 'fast',
    label: 'retry',
    confirm: false,
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
      .map((i) => `${i.path.join('.') === '' ? '(root)' : i.path.join('.')}: ${i.message}`)
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
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of entries) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}
