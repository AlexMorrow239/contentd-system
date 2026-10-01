import { BrainrotError } from '../../shared/errors.js'
import { approveLibrary } from '../library/library.js'
import { markPosted, unmarkPosted } from '../posting/posts.js'
import { deleteJob } from '../production/jobs/delete.js'
import { digestForChannelsDir } from '../reporting/digest.js'
import { rejectTopics, requeueTopic } from '../topics/mutations.js'
import type { LaneKind } from './catalog.js'
import { ActionContext, Handler } from './handler-contract.js'

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

export const FAST_HANDLERS: { [K in LaneKind<'fast'>]: Handler<K> } = {
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

  'digest.run': (ctx) =>
    Promise.resolve({ text: digestForChannelsDir(ctx.db, ctx.channelsDir, { time: ctx.time }) }),

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
}
