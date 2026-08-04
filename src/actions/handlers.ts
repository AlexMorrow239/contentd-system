import type { Database } from 'better-sqlite3'
import { loadChannelsDir, tryLoadChannelsDir } from '../config/channel.js'
import { errorMessage, BrainrotError } from '../errors.js'
import {
  approveLibrary,
  deleteRejectedObjects,
  libraryObjectKeys,
  rejectLibrary,
} from '../jobs/library.js'
import { pipelineStages } from '../jobs/pipeline.js'
import { resumeJob } from '../jobs/resume.js'
import { createJob, runJob } from '../jobs/runner.js'
import { buildDigest } from '../loop/digest.js'
import { produceNextTick } from '../loop/produce-next.js'
import { markPosted, unmarkPosted } from '../posts/posts.js'
import { scoutAll } from '../scout/scout.js'
import { rejectTopics, requeueTopic } from '../scout/topics.js'
import { s3ConfigError } from '../storage/config.js'
import type { ObjectStore } from '../storage/types.js'
import { parseActionArgs, type ActionArgs, type ActionKind } from './catalog.js'

/**
 * Handler implementations. DAEMON ONLY — src/arch.test.ts fails the build if
 * anything under src/dashboard/ imports this module, directly OR
 * transitively (including via a re-export), because it transitively pulls
 * Remotion and the provider clients into whatever process imports it — the
 * slow lane's handlers reach both. The dashboard reads ./catalog.js instead,
 * which is pure metadata.
 *
 * Each handler mirrors its CLI command's semantics, including which outcomes
 * are failures. One deliberate exception: `library.approve` on a reclaimed
 * job exits 1 on the CLI but records `done` here with `reclaimed: [...]`, so
 * the page can still report the approvals that did succeed in the same
 * batch.
 */

/**
 * `runsRoot` is live: the two render-triggering handlers, `produce.next` and
 * `jobs.resume`, both thread it straight through to the pipeline. `setNotice`
 * is called by handlers and the worker to publish operator-facing status:
 * `jobs.produce` publishes its job id (for resumption if interrupted),
 * `library.reject` publishes deletion progress, and the worker publishes when
 * actions wait on a held lease. A planned consumer is `topics.pruneMedia` for
 * per-row validation progress.
 */
export interface ActionContext {
  db: Database
  now: Date
  channelsDir: string
  runsRoot: string
  /**
   * Publishes an interactive status for the operator to see. Called by handlers
   * (`jobs.produce`, `library.reject`) and by the worker's lease-blocked path
   * when actions wait on a held lease. Planned consumer: `topics.pruneMedia`.
   */
  setNotice: (text: string) => void
}

/**
 * The optional third parameter is a test seam, mirroring the `opts.tick ??`
 * shape `produceUnit` already uses in src/loop/daemon.ts. It is never
 * supplied in production — `runAction` calls handlers with two arguments —
 * so a handler that needs no seam simply ignores it.
 */
type HandlerDeps = {
  produceNextTick?: typeof produceNextTick
  scoutAll?: typeof scoutAll
  resumeJob?: typeof resumeJob
  runJob?: typeof runJob
  /**
   * Test seam standing in for `(await import('../storage/s3.js')).storeFromEnv()`
   * in `library.reject` — keeps the AWS SDK's ~35ms/~10MB startup cost off
   * every other path that imports this module, mirroring the CLI's `reject`
   * command. A thrown error here is treated exactly like a real
   * `storeFromEnv()` throw: nothing to delete.
   */
  storeFromEnv?: () => ObjectStore
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

  'digest.run': (ctx) => {
    const loaded = tryLoadChannelsDir(ctx.channelsDir)
    return Promise.resolve({
      text: buildDigest(ctx.db, loaded.channels, { channelsError: loaded.error }),
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

  'jobs.produce': async (ctx, args, deps) => {
    // Object storage is optional (src/stages/store.ts no-ops without it), so
    // this is a warning carried in the result, NOT a refusal — the same
    // decision `produce` makes when it writes one line to stderr. Read before
    // the render so the answer describes the run that is about to happen.
    const storageWarning = s3ConfigError()
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
    const jobId = createJob(ctx.db, channel, { topic: args.topic })
    // Publish the job id the instant it exists. If this process is killed
    // mid-render the action row goes `failed` while the JOB stays resumable —
    // and because failAction no longer clears `notice` (Task 1), this line is
    // what tells the operator which job to resume.
    ctx.setNotice(`job ${jobId}`)
    const result = await (deps?.runJob ?? runJob)(ctx.db, channel, jobId, pipelineStages(), {
      runsRoot: ctx.runsRoot,
    })
    return storageWarning === undefined ? result : { ...result, storageWarning }
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
      // would add is inconsistency, not information.
      return { action: 'noop', reason: 'config-error', error: loaded.error }
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

  // No `force`: see the catalog entry. No `heartbeat` either — the slow lane's
  // worker refreshes the lease on its own interval (SLOW_ACTION_HEARTBEAT_MS),
  // which covers every slow action rather than just the two that happen to
  // accept a heartbeat callback.
  'jobs.resume': (ctx, args, deps) =>
    (deps?.resumeJob ?? resumeJob)(ctx.db, args.jobId, {
      runsRoot: ctx.runsRoot,
      channelsDir: ctx.channelsDir,
    }),

  // eslint-disable-next-line @typescript-eslint/require-await
  'post.mark': async (ctx, args) => {
    // The channel is resolved here rather than taken from the form: the
    // dashboard only has a job id, and a mismatched channel would misfile the
    // row in every channel-scoped read (pendingInventory, reclaim, the digest).
    const row = ctx.db.prepare('SELECT channel FROM jobs WHERE id = ?').get(args.jobId) as
      { channel: string } | undefined
    if (row === undefined) {
      throw new BrainrotError(`no such job: ${args.jobId}`, { domain: 'job', kind: 'not-found' })
    }
    markPosted(ctx.db, {
      jobId: args.jobId,
      channel: row.channel,
      platform: args.platform,
      url: args.url,
    })
    return { jobId: args.jobId, platform: args.platform, posted: true }
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  'post.unmark': async (ctx, args) => ({
    jobId: args.jobId,
    platform: args.platform,
    // Reported, not thrown: unmarking something already gone is the operator
    // getting the state they asked for, not a failure.
    removed: unmarkPosted(ctx.db, args.jobId, args.platform),
  }),

  // Mirrors the CLI's `library reject` command (src/cli.ts): keys are read
  // BEFORE the state change, and the object delete is best-effort AFTER it —
  // the reject itself must not depend on network reachability, and a storage
  // failure must not roll back (or fail) the state change. See that
  // command's comment for why: a failure here leaves an orphaned object, and
  // the warning is how an operator finds it.
  'library.reject': async (ctx, args, deps) => {
    const objects = libraryObjectKeys(ctx.db, args.jobIds)
    const rejected = rejectLibrary(ctx.db, args.jobIds)

    let deleted: string[] = []
    let failed: string[] = []
    let storageUnavailable: string | undefined
    if (objects.length > 0) {
      let store: ObjectStore | null = null
      const configError = s3ConfigError()
      if (configError !== undefined) {
        storageUnavailable = configError
      } else {
        try {
          store = deps?.storeFromEnv
            ? deps.storeFromEnv()
            : (await import('../storage/s3.js')).storeFromEnv()
        } catch (err) {
          storageUnavailable = errorMessage(err)
        }
      }
      if (store !== null) {
        const outcome = await deleteRejectedObjects({
          db: ctx.db,
          objects,
          store,
          warn: (message) => ctx.setNotice(message),
        })
        deleted = outcome.deleted
        failed = outcome.failed
      }
    }

    return {
      rejected,
      requested: args.jobIds.length,
      objectsDeleted: deleted.length,
      objectsFailed: failed.length,
      ...(storageUnavailable !== undefined ? { storageUnavailable } : {}),
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
