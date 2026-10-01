import { configErrorNoop, loadChannelsDir, tryLoadChannelsDir } from '../../config/channel.js'
import { BrainrotError } from '../../shared/errors.js'
import { linkActionJob } from '../production/jobs/execution.js'
import { resumeJob } from '../production/jobs/resume.js'
import { createJob, runJob } from '../production/jobs/runner.js'
import { pipelineStages } from '../production/pipeline.js'
import { produceNextTick } from '../production/produce-next.js'
import { scoutAll } from '../scouting/run.js'
import type { LaneKind } from './catalog.js'
import { Handler } from './handler-contract.js'
export const SLOW_HANDLERS: { [K in LaneKind<'slow'>]: Handler<K> } = {
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
      // shared config helper, so the row this records stays byte-identical
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
}
