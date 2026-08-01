import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { BrainrotError } from '../errors.js'
import { approveLibrary } from '../jobs/library.js'
import { buildDigest } from '../loop/digest.js'
import { produceNextTick } from '../loop/produce-next.js'
import { publishNextTick } from '../loop/publish-next.js'
import { ADAPTERS } from '../publish/platforms/index.js'
import { interruptedPlatform, markInterruptedDone, retryInterrupted } from '../publish/publishes.js'
import { scoutAll } from '../scout/scout.js'
import { rejectTopics, requeueTopic } from '../scout/topics.js'
import { parseActionArgs, type ActionArgs, type ActionKind } from './catalog.js'

/**
 * Handler implementations. DAEMON ONLY — src/arch.test.ts fails the build if
 * anything under src/dashboard/ imports this module, directly OR
 * transitively (including via a re-export), because it transitively pulls
 * publish adapters (and, from phase 2, Remotion and the provider clients)
 * into whatever process imports it. The dashboard reads ./catalog.js
 * instead, which is pure metadata.
 *
 * Each handler mirrors its CLI command's semantics, including which outcomes
 * are failures: `publish retry` on a job with no interrupted row exits 1, so
 * the action throws rather than recording a misleading success. One
 * deliberate exception: `library.approve` on a reclaimed job exits 1 on the
 * CLI but records `done` here with `reclaimed: [...]`, so the page can still
 * report the approvals that did succeed in the same batch.
 */

/**
 * `runsRoot` and `setNotice` are deliberate phase-2 scaffolding: no handler
 * below uses either yet. `runsRoot` is here for a future render-triggering
 * action; `setNotice` is here for `auth` (phase 3), expected to publish an
 * OAuth consent URL through it — never a credential. Neither is dead code —
 * don't delete them for being currently unused.
 */
export interface ActionContext {
  db: Database
  now: Date
  channelsDir: string
  runsRoot: string
  /**
   * Publishes an interactive status for the operator to see. No current
   * handler calls this — today the only writer of `notice` is the worker's
   * own lease-blocked path.
   */
  setNotice: (text: string) => void
}

/**
 * The optional third parameter is a test seam, mirroring the `opts.tick ??`
 * shape `produceUnit`/`publishUnit` already use in src/loop/daemon.ts. It is
 * never supplied in production — `runAction` calls handlers with two
 * arguments — so a handler that needs no seam simply ignores it.
 */
type HandlerDeps = {
  produceNextTick?: typeof produceNextTick
  publishNextTick?: typeof publishNextTick
  scoutAll?: typeof scoutAll
}

type Handler<K extends ActionKind> = (
  ctx: ActionContext,
  args: ActionArgs<K>,
  deps?: HandlerDeps,
) => Promise<unknown>

export const ACTION_HANDLERS: { [K in ActionKind]: Handler<K> } = {
  'topics.reject': (ctx, args) =>
    Promise.resolve({ rejected: rejectTopics(ctx.db, args.ids), requested: args.ids.length }),

  // Each handler below is genuinely synchronous, but stays `async` so a
  // thrown error becomes a rejected Promise rather than a synchronous throw —
  // the sole caller is `async runAction`, but a future direct
  // `ACTION_HANDLERS[k](ctx, args).catch(...)` must not blow past the
  // `.catch`. Same convention as storage/fake.ts. require-await doesn't know
  // that distinction, hence the per-handler disable.
  // eslint-disable-next-line @typescript-eslint/require-await
  'topics.requeue': async (ctx, args) => {
    const outcome = requeueTopic(ctx.db, args.id)
    if (!outcome.ok) {
      // 'job-active' is someone else holding the topic (its job is still
      // live) — errors.ts defines that as 'conflict', not 'refused'. The
      // CLI's `topics requeue` reports the same structured detail
      // (status / jobId / jobStatus) on stdout; it travels here as context
      // so the dashboard can render it too.
      const kind =
        outcome.reason === 'unknown'
          ? 'not-found'
          : outcome.reason === 'job-active'
            ? 'conflict'
            : 'refused'
      const context =
        outcome.reason === 'job-active'
          ? { jobId: outcome.jobId, jobStatus: outcome.jobStatus }
          : outcome.reason === 'not-claimed'
            ? { status: outcome.status }
            : undefined
      throw new BrainrotError(`topic ${args.id} not requeued: ${outcome.reason}`, {
        domain: 'job',
        kind,
        context,
      })
    }
    return { ok: true }
  },

  'library.approve': (ctx, args) => {
    const { approved, reclaimed } = approveLibrary(ctx.db, args.jobIds)
    // Not an error: the CLI exits 1 on a reclaimed refusal but still reports
    // the approvals it made. Both numbers travel in the result so the page can
    // say "approved 2 of 3" the same way.
    return Promise.resolve({ approved, requested: args.jobIds.length, reclaimed })
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  'publish.retry': async (ctx, args) => {
    if (!retryInterrupted(ctx.db, args.jobId)) {
      throw new BrainrotError(`no interrupted publish for job ${args.jobId}`, {
        domain: 'publish',
        kind: 'not-found',
      })
    }
    return { cleared: true }
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  'publish.markDone': async (ctx, args) => {
    // The interrupted row names its own platform, so the url comes from that
    // platform's adapter — there is no platform argument to get wrong. A
    // platform whose url is not derivable from the id alone records none.
    const platform = interruptedPlatform(ctx.db, args.jobId)
    const url = platform === null ? null : ADAPTERS[platform]().postUrl(args.postId)
    const ok =
      platform !== null && markInterruptedDone(ctx.db, args.jobId, args.postId, url, ctx.now)
    if (!ok) {
      throw new BrainrotError(`no interrupted publish for job ${args.jobId}`, {
        domain: 'publish',
        kind: 'not-found',
      })
    }
    return { platform, postId: args.postId, url }
  },

  'digest.run': (ctx) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    return Promise.resolve({
      text: buildDigest(ctx.db, loaded.channels, {}, { channelsError: loaded.error }),
    })
  },

  // The tick result is recorded verbatim as the action's `result`, including
  // a `{action:'noop',reason:'lease-held'}` — the tick ran and declined
  // because the daemon's own worker holds the lease, which is a truthful
  // outcome and exactly what the CLI reports (exit 0).
  //
  // A tick that lands `status: 'failed'` also records the action `done`, not
  // `failed`. That is a deliberate departure from "mirror the CLI's exit
  // code": `failAction` stores no `result`, so failing the action would throw
  // away the very JobResult the operator needs to read. The page renders
  // `status: failed` plainly.
  'produce.next': (ctx, _args, deps) =>
    (deps?.produceNextTick ?? produceNextTick)(ctx.db, {
      channelsDir: ctx.channelsDir,
      runsRoot: ctx.runsRoot,
    }),

  'publish.next': (ctx, _args, deps) =>
    (deps?.publishNextTick ?? publishNextTick)(ctx.db, { channelsDir: ctx.channelsDir }),

  'publish.nextDryRun': (ctx, _args, deps) =>
    (deps?.publishNextTick ?? publishNextTick)(ctx.db, {
      channelsDir: ctx.channelsDir,
      dryRun: true,
    }),

  'scout.run': async (ctx, _args, deps) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    if (loaded.error !== undefined) {
      throw new BrainrotError(`scout: ${loaded.error}`, { domain: 'config', kind: 'invalid' })
    }
    // force:true unconditionally — an operator clicking "scout now" means now,
    // and SCOUT_RECHECK_MS (20 min) would otherwise swallow the click.
    //
    // A ScoutRunFailedError propagates and records the action `failed`, which
    // matches the CLI's exit 1. The per-channel detail it carries is lost:
    // `failAction` stores a message and a kind, not a result. Accepted — the
    // failure message names the systemic cause, which is the actionable part.
    return {
      channels: await (deps?.scoutAll ?? scoutAll)(ctx.db, loaded.channels, { force: true }),
    }
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
