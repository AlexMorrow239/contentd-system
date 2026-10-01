import type { Database } from 'better-sqlite3'
import type { LeaseContext } from '../../infra/coordination/lease.js'
import type { TimeSource } from '../../shared/time.js'
import type { resumeJob } from '../production/jobs/resume.js'
import type { runJob } from '../production/jobs/runner.js'
import type { produceNextTick } from '../production/produce-next.js'
import type { scoutAll } from '../scouting/run.js'
import type { ActionArgs, ActionKind } from './catalog.js'

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
 * shape `produceUnit` uses in the production worker. It is never
 * supplied in production — `runAction` calls handlers with two arguments —
 * so a handler that needs no seam simply ignores it.
 */
export type HandlerDeps = {
  produceNextTick?: typeof produceNextTick
  scoutAll?: typeof scoutAll
  resumeJob?: typeof resumeJob
  runJob?: typeof runJob
}

export type Handler<K extends ActionKind> = (
  ctx: ActionContext,
  args: ActionArgs<K>,
  deps?: HandlerDeps,
) => Promise<unknown>
