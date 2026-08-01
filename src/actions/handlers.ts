import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { BrainrotError } from '../errors.js'
import { approveLibrary } from '../jobs/library.js'
import { buildDigest } from '../loop/digest.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import {
  interruptedPlatform,
  markInterruptedDone,
  retryInterrupted,
} from '../publish/publishes.js'
import { rejectTopics, requeueTopic } from '../scout/topics.js'
import { ACTIONS, parseActionArgs, type ActionArgs, type ActionKind } from './catalog.js'

/**
 * Handler implementations. DAEMON ONLY — src/arch.test.ts fails the build if
 * anything under src/dashboard/ reaches this module, because it transitively
 * pulls publish adapters (and, from phase 2, Remotion and the provider
 * clients) into whatever process imports it. The dashboard reads ./catalog.js
 * instead, which is pure metadata.
 *
 * Each handler mirrors its CLI command's semantics exactly, including which
 * outcomes are failures: `publish retry` on a job with no interrupted row
 * exits 1, so the action throws rather than recording a misleading success.
 */
export interface ActionContext {
  db: Database
  now: Date
  channelsDir: string
  runsRoot: string
  /** Publishes an interactive payload while the action is still running. */
  setNotice: (text: string) => void
}

type Handler<K extends ActionKind> = (ctx: ActionContext, args: ActionArgs<K>) => Promise<unknown>

export const ACTION_HANDLERS: { [K in ActionKind]: Handler<K> } = {
  'topics.reject': (ctx, args) =>
    Promise.resolve({ rejected: rejectTopics(ctx.db, args.ids), requested: args.ids.length }),

  'topics.requeue': (ctx, args) => {
    const outcome = requeueTopic(ctx.db, args.id)
    if (!outcome.ok) {
      throw new BrainrotError(`topic ${args.id} not requeued: ${outcome.reason}`, {
        domain: 'job',
        kind: outcome.reason === 'unknown' ? 'not-found' : 'refused',
      })
    }
    return Promise.resolve({ ok: true })
  },

  'library.approve': (ctx, args) => {
    const { approved, reclaimed } = approveLibrary(ctx.db, args.jobIds)
    // Not an error: the CLI exits 1 on a reclaimed refusal but still reports
    // the approvals it made. Both numbers travel in the result so the page can
    // say "approved 2 of 3" the same way.
    return Promise.resolve({ approved, requested: args.jobIds.length, reclaimed })
  },

  'publish.retry': (ctx, args) => {
    if (!retryInterrupted(ctx.db, args.jobId)) {
      throw new BrainrotError(`no interrupted publish for job ${args.jobId}`, {
        domain: 'publish',
        kind: 'not-found',
      })
    }
    return Promise.resolve({ cleared: true })
  },

  'publish.markDone': (ctx, args) => {
    // The interrupted row names its own platform, so the url comes from that
    // platform's adapter — there is no platform argument to get wrong. A
    // platform whose url is not derivable from the id alone records none.
    const platform = interruptedPlatform(ctx.db, args.jobId)
    const url = platform === null ? null : ADAPTERS[platform]().postUrl(args.postId)
    const ok = platform !== null && markInterruptedDone(ctx.db, args.jobId, args.postId, url, ctx.now)
    if (!ok) {
      throw new BrainrotError(`no interrupted publish for job ${args.jobId}`, {
        domain: 'publish',
        kind: 'not-found',
      })
    }
    return Promise.resolve({ platform, postId: args.postId, url })
  },

  'digest.run': (ctx) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    return Promise.resolve({
      text: buildDigest(ctx.db, loaded.channels, {}, { channelsError: loaded.error }),
    })
  },
}

/**
 * Parse-then-dispatch. Args are validated here as well as at the HTTP edge, so
 * a row hand-inserted into the queue cannot reach a handler unvalidated.
 *
 * The cast is the one unavoidable seam: `ACTION_HANDLERS` is a mapped type
 * whose value type depends on the key, and TypeScript cannot prove the
 * correlation once the key is widened to the union. Both sides are pinned by
 * the drift test in handlers.test.ts.
 */
export async function runAction(
  ctx: ActionContext,
  kind: ActionKind,
  rawArgs: unknown,
): Promise<unknown> {
  const args = parseActionArgs(kind, rawArgs)
  const handler = ACTION_HANDLERS[kind] as (ctx: ActionContext, args: unknown) => Promise<unknown>
  return handler(ctx, args)
}

/** Re-exported so the worker can read lane/lease without a second import. */
export { ACTIONS }
