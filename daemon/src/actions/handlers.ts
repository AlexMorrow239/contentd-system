import type { LeaseContext } from '../loop/lease.js'
import { linkActionJob } from '../jobs/execution.js'
import type { Database } from 'better-sqlite3'
import { loadChannelsDir, tryLoadChannelsDir } from '../config/channel.js'
import { BrainrotError } from '../errors.js'
import { approveLibrary, rejectLibrary } from '../jobs/library.js'
import { pipelineStages } from '../jobs/pipeline.js'
import { deleteJob } from '../jobs/delete.js'
import { resumeJob } from '../jobs/resume.js'
import { createJob, runJob } from '../jobs/runner.js'
import { buildDigest } from '../loop/digest.js'
import { configErrorNoop, produceNextTick } from '../loop/produce-next.js'
import { markPosted, unmarkPosted } from '../posts/posts.js'
import { scoutAll } from '../scout/scout.js'
import { rejectTopics, requeueTopic } from '../scout/topics.js'
import { parseActionArgs, type ActionArgs, type ActionKind } from './catalog.js'
import { resolveTime, type TimeSource } from '../time.js'

/**
 * Handler implementations. DAEMON ONLY — daemon/src/arch.test.ts fails the build if
 * anything under dashboard/ imports this module, directly OR
 * transitively (including via a re-export), because it transitively pulls
 * Remotion and the provider clients into whatever process imports it — the
 * slow lane's handlers reach both. The dashboard reads ./catalog.js instead,
 * which is pure metadata.
 *
 * Each handler mirrors its CLI command's semantics, including which outcomes
 * are failures.
 */

/**
 * `runsRoot` is live: all three render-triggering handlers — `produce.next`,
 * `jobs.resume` and `jobs.produce` — thread it straight through to the
 * pipeline. `setNotice` is called by handlers and the worker to publish
 * operator-facing status: `jobs.produce` publishes its job id for recovery,
 * and the worker publishes when actions wait on a held lease.
 */
export interface ActionContext {
  actionId?: number
  lease?: LeaseContext
  daemonLease?: LeaseContext
  db: Database
  time: TimeSource
  channelsDir: string
  runsRoot: string
  /**
   * Publishes an interactive status for the operator to see. Called by
   * `jobs.produce` and by the worker's lease-blocked path.
   */
  setNotice: (text: string) => void
}

/**
 * The optional third parameter is a test seam, mirroring the `opts.tick ??`
 * shape `produceUnit` already uses in daemon/src/loop/daemon.ts. It is never
 * supplied in production — `runAction` calls handlers with two arguments —
 * so a handler that needs no seam simply ignores it.
 */
type HandlerDeps = {
  produceNextTick?: typeof produceNextTick
  scoutAll?: typeof scoutAll
  resumeJob?: typeof resumeJob
  runJob?: typeof runJob
}

type Handler<K extends ActionKind> = (
  ctx: ActionContext,
  args: ActionArgs<K>,
  deps?: HandlerDeps,
) => Promise<unknown>

/** Keep the ownership check and synchronous domain write under one write lock.
 * The async boundary only converts synchronous errors into rejected promises. */
// eslint-disable-next-line @typescript-eslint/require-await
async function mutateOwned<T extends Record<string, unknown>>(
  ctx: ActionContext,
  mutate: () => T,
): Promise<T> {
  return ctx.db
    .transaction(() => {
      ctx.daemonLease?.assertOwned()
      ctx.lease?.assertOwned()
      return mutate()
    })
    .immediate()
}

export const ACTION_HANDLERS: { [K in ActionKind]: Handler<K> } = {
  'jobs.delete': (ctx, args) =>
    mutateOwned(ctx, () => ({
      jobId: args.jobId,
      deleted: deleteJob(ctx.db, args.jobId, ctx.time),
    })),

  'topics.reject': (ctx, args) =>
    mutateOwned(ctx, () => ({
      rejected: rejectTopics(ctx.db, args.ids),
      requested: args.ids.length,
    })),

  'topics.requeue': (ctx, args) =>
    mutateOwned(ctx, () => {
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
    }),

  'library.approve': (ctx, args) =>
    mutateOwned(ctx, () => ({
      approved: approveLibrary(ctx.db, args.jobIds),
      requested: args.jobIds.length,
    })),

  'digest.run': (ctx) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    return Promise.resolve({
      text: buildDigest(ctx.db, loaded.channels, { channelsError: loaded.error, time: ctx.time }),
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
      lease: ctx.lease,
      daemonLease: ctx.daemonLease,
      actionId: ctx.actionId,
      time: ctx.time,
    }),

  'jobs.produce': async (ctx, args, deps) => {
    // Resolve the NAME through the loader, never by string-joining a path:
    // loadChannelsDir already enforces that a file's basename equals its
    // declared `name`, which is the invariant resume depends on.
    const channel = loadChannelsDir(ctx.channelsDir).find((c) => c.name === args.channel)
    if (channel === undefined) {
      throw new BrainrotError(`unknown channel "${args.channel}" (checked ${ctx.channelsDir})`, {
        domain: 'config',
        kind: 'not-found',
      })
    }
    const jobId = ctx.db
      .transaction(() => {
        ctx.lease?.assertOwned()
        const id = createJob(ctx.db, channel, { topic: args.topic, time: ctx.time })
        linkActionJob(ctx.db, ctx.actionId, id, ctx.daemonLease)
        return id
      })
      .immediate()
    // Publish the job id the instant it exists. If this process is killed
    // mid-render the action row goes `failed` while the JOB stays resumable —
    // and because failAction no longer clears `notice` (Task 1), this line is
    // what tells the operator which job to resume.
    ctx.setNotice(`job ${jobId}`)
    return (deps?.runJob ?? runJob)(ctx.db, channel, jobId, pipelineStages(), {
      runsRoot: ctx.runsRoot,
      lease: ctx.lease,
      time: ctx.time,
    })
  },

  'scout.run': async (ctx, _args, deps) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    if (loaded.error !== undefined) {
      // A benign noop recorded `done`, NOT a throw. A sibling hits this exact
      // condition and reports it the same way — digest.run folds loaded.error
      // into its result, produce.next passes through the tick's own
      // {action:'noop',reason:'config-error'} — and the CLI's `scout` exits 0
      // on it, reserving exit 1 for a ScoutRunFailedError thrown by scoutAll
      // itself. The operator sees the cause either way; what a lone `failed`
      // would add is inconsistency, not information. The shape comes from the
      // tick module that owns it, so the row this records stays byte-identical
      // to the one produce.next passes through.
      return configErrorNoop(loaded.error)
    }
    // force:true unconditionally — an operator clicking "scout now" means now,
    // and SCOUT_RECHECK_MS (20 min) would otherwise swallow the click.
    //
    // A ScoutRunFailedError propagates and records the action `failed`, which
    // matches the CLI's exit 1. The per-channel detail it carries is lost:
    // `failAction` stores a message and a kind, not a result. Accepted — the
    // failure message names the systemic cause, which is the actionable part.
    return {
      channels: await (deps?.scoutAll ?? scoutAll)(ctx.db, loaded.channels, {
        force: true,
        lease: ctx.lease,
        time: ctx.time,
      }),
    }
  },

  // No `force`: see the catalog entry. No `heartbeat` either — the slow lane's
  // worker refreshes the lease on its own interval (SLOW_ACTION_HEARTBEAT_MS),
  // which covers every slow action rather than just the two that happen to
  // accept a heartbeat callback.
  'jobs.resume': (ctx, args, deps) =>
    (deps?.resumeJob ?? resumeJob)(ctx.db, args.jobId, {
      runsRoot: ctx.runsRoot,
      lease: ctx.lease,
      daemonLease: ctx.daemonLease,
      actionId: ctx.actionId,
      channelsDir: ctx.channelsDir,
      time: ctx.time,
    }),

  'post.mark': (ctx, args) =>
    mutateOwned(ctx, () => {
      // No channel is passed: the form only has a job id, and markPosted
      // resolves the channel from the job itself (throwing not-found for an
      // unknown id), which is what makes a misfiled row structurally impossible
      // rather than something each caller has to remember.
      markPosted(ctx.db, {
        jobId: args.jobId,
        platform: args.platform,
        url: args.url,
        time: ctx.time,
      })
      return { jobId: args.jobId, platform: args.platform, posted: true }
    }),

  'post.unmark': (ctx, args) =>
    mutateOwned(ctx, () => ({
      jobId: args.jobId,
      platform: args.platform,
      // Reported, not thrown: unmarking something already gone is the operator
      // getting the state they asked for, not a failure.
      removed: unmarkPosted(ctx.db, args.jobId, args.platform),
    })),

  'library.reject': (ctx, args) =>
    mutateOwned(ctx, () => ({
      rejected: rejectLibrary(ctx.db, args.jobIds),
      requested: args.jobIds.length,
    })),
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
  resolveTime(ctx.time, ctx.lease, ctx.daemonLease)
  ctx.daemonLease?.assertOwned()
  ctx.lease?.assertOwned()
  const args = parseActionArgs(kind, rawArgs)
  const handler = ACTION_HANDLERS[kind] as (ctx: ActionContext, args: unknown) => Promise<unknown>
  return handler(ctx, args)
}
