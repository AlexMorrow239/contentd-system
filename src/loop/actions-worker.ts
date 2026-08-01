import type { Database } from 'better-sqlite3'
import { ACTIONS, isActionKind, type ActionLane, type ActionLease } from '../actions/catalog.js'
import { runAction, type ActionContext } from '../actions/handlers.js'
import {
  completeAction,
  failAction,
  failRunningActions,
  pendingActions,
  setActionNotice,
  startAction,
  type ActionRow,
} from '../actions/queue.js'
import { BrainrotError } from '../errors.js'
import { SCOUT_LEASE_TTL_MS } from '../scout/scout.js'
import type { UnitResult } from './daemon.js'
import { DAEMON_HEARTBEAT_MS, stampDaemonSeen } from './daemon-state.js'
import {
  acquireLease,
  releaseLease,
  PRODUCE_LEASE_TTL_MS,
  PUBLISH_LEASE_TTL_MS,
} from './lease.js'

/** The fast lane's poll. A row mutation must feel immediate, not 30s away. */
export const FAST_IDLE_SLEEP_MS = 1_000

/**
 * Upper bound on one fast drain. High enough that a burst of checkbox
 * submissions clears in one poll, low enough that a pathological queue cannot
 * starve the heartbeat stamp at the top of the next unit.
 */
export const MAX_FAST_DRAIN = 50

const LEASE_TTL_MS: Record<ActionLease, number> = {
  produce: PRODUCE_LEASE_TTL_MS,
  publish: PUBLISH_LEASE_TTL_MS,
  scout: SCOUT_LEASE_TTL_MS,
}

/**
 * One lane's drain. `fast` clears up to MAX_FAST_DRAIN actions per call;
 * `slow` executes at most one, so a long render never blocks the poll that
 * would report it.
 *
 * An action whose lease is held is SKIPPED, not awaited: taking the head of
 * the queue and waiting would let one long upload stall every trivial mutation
 * behind it, which is the head-of-line blocking the two lanes exist to
 * prevent. The skipped row keeps its place and explains itself through
 * `notice`.
 */
export function actionsUnit(
  db: Database,
  lane: ActionLane,
  opts: {
    channelsDir: string
    runsRoot: string
    now?: () => Date
    run?: typeof runAction
  },
): () => Promise<UnitResult> {
  const run = opts.run ?? runAction
  // Startup repair, run once. Within one daemon process a 'running' row on the
  // first poll can only be from a dead process, so no age threshold has to be
  // guessed — and guessing one would sweep a legitimately long action out from
  // under itself.
  let swept = false
  let lastHeartbeat = 0
  const budget = lane === 'fast' ? MAX_FAST_DRAIN : 1

  return async (): Promise<UnitResult> => {
    const now = opts.now?.() ?? new Date()
    if (!swept) {
      swept = true
      failRunningActions(db, lane, now)
    }
    // The heartbeat rides the fast lane only: the slow lane can legitimately
    // sit inside one action for minutes, which would read as a dead daemon.
    if (lane === 'fast' && now.getTime() - lastHeartbeat >= DAEMON_HEARTBEAT_MS) {
      lastHeartbeat = now.getTime()
      stampDaemonSeen(db, process.pid, now)
    }

    const done: number[] = []
    let blockedLease: ActionLease | undefined
    for (const row of pendingActions(db, lane, budget + 1)) {
      if (done.length >= budget) break
      const outcome = await executeOne(db, row, { channelsDir: opts.channelsDir, runsRoot: opts.runsRoot, now, run })
      if (outcome.blockedBy !== undefined) {
        blockedLease ??= outcome.blockedBy
        continue
      }
      done.push(row.id)
    }

    if (done.length > 0) return { worked: true, line: { action: 'actions', lane, ran: done.length } }
    if (blockedLease !== undefined) {
      return { worked: false, line: { action: 'noop', reason: 'lease-held', lease: blockedLease } }
    }
    // No line at all: an empty queue on a 1s poll must stay silent, and
    // runWorker's dedupe only suppresses IDENTICAL consecutive lines.
    return { worked: false }
  }
}

async function executeOne(
  db: Database,
  row: ActionRow,
  deps: {
    channelsDir: string
    runsRoot: string
    now: Date
    run: typeof runAction
  },
): Promise<{ blockedBy?: ActionLease }> {
  if (!isActionKind(row.kind)) {
    startAction(db, row.id, deps.now)
    failAction(
      db,
      row.id,
      new BrainrotError(`unknown action kind ${JSON.stringify(row.kind)}`, {
        domain: 'config',
        kind: 'invalid',
      }),
      deps.now,
    )
    return {}
  }

  const lease = ACTIONS[row.kind].lease
  let holder: string | undefined
  if (lease !== undefined) {
    holder = `pid:${process.pid}:action:${row.id}`
    if (!acquireLease(db, lease, holder, LEASE_TTL_MS[lease])) {
      setActionNotice(db, row.id, `waiting for the ${lease} lease`)
      return { blockedBy: lease }
    }
  }

  try {
    // The status guard in startAction is the claim; losing it means another
    // caller already took this row.
    if (!startAction(db, row.id, deps.now)) return {}
    let args: unknown
    try {
      args = JSON.parse(row.args)
    } catch {
      failAction(
        db,
        row.id,
        new BrainrotError('args column is not valid JSON', { domain: 'config', kind: 'invalid' }),
        deps.now,
      )
      return {}
    }
    const ctx: ActionContext = {
      db,
      now: deps.now,
      channelsDir: deps.channelsDir,
      runsRoot: deps.runsRoot,
      setNotice: (text) => setActionNotice(db, row.id, text),
    }
    try {
      completeAction(db, row.id, await deps.run(ctx, row.kind, args), deps.now)
    } catch (err) {
      failAction(db, row.id, err, deps.now)
    }
    return {}
  } finally {
    if (lease !== undefined && holder !== undefined) releaseLease(db, lease, holder)
  }
}
