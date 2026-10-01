import type { Database } from 'better-sqlite3'
import { DAEMON_HEARTBEAT_MS, stampDaemonSeen } from '../../infra/coordination/daemon-state.js'
import {
  LEASE_HEARTBEAT_MS,
  LEASE_TTL_MS,
  acquireManagedLease,
  type LeaseContext,
} from '../../infra/coordination/lease.js'
import type { UnitResult } from '../../shared/contracts/worker.js'
import { BrainrotError } from '../../shared/errors.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { ACTIONS, isActionKind, type ActionLane, type ActionLease } from './catalog.js'
import { type ActionContext } from './handler-contract.js'
import { runAction } from './handlers.js'
import {
  completeAction,
  failAction,
  pendingActions,
  setActionNotice,
  startAction,
} from './queue.js'
import { reconcileInterruptedAction } from './recovery.js'
import { type ActionRow } from './types.js'

/**
 * Upper bound on one fast drain. High enough that a burst of checkbox
 * submissions clears in one poll, low enough that a pathological queue cannot
 * starve the heartbeat stamp at the top of the next unit.
 */
export const MAX_FAST_DRAIN = 50

/**
 * How many pending rows a single poll is willing to scan past, on EITHER
 * lane, while looking for runnable work. This is deliberately independent of
 * `budget` (the completion cap): a lease-blocked row consumes a scan slot
 * without consuming a completion slot, so scanning only `budget + 1` rows
 * gave the slow lane (budget 1) just ONE row of skip tolerance — two
 * consecutive lease-blocked rows would idle the lane even with runnable work
 * behind them. Sharing MAX_FAST_DRAIN's value is coincidence, not coupling:
 * the fast lane's own budget already equals this window, so reusing it there
 * costs nothing, and it caps how much work one poll does either way.
 *
 * The skip set below removes the redundant ACQUIRES, not this bound: 50 rows
 * all blocked on `produce` still means row 51 was never in the query's result
 * set and does not run this poll. That is left in place deliberately — it
 * self-heals on the next poll, and a queue 50 deep on one lease is not a shape
 * one operator clicking buttons produces.
 */
export const ACTION_SCAN_WINDOW = MAX_FAST_DRAIN

export const SLOW_ACTION_LEASE_TTL_MS = LEASE_TTL_MS
export const SLOW_ACTION_HEARTBEAT_MS = LEASE_HEARTBEAT_MS

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
    time?: TimeSource
    run?: typeof runAction
    daemonLease?: LeaseContext
    pid?: number
  },
): () => Promise<UnitResult> {
  const run = opts.run ?? runAction
  // The per-row clock. A single frozen `Date` per poll would record
  // finished_at === started_at for a slow action taking seconds or minutes;
  // reading it fresh at each row transition is what lets those columns carry
  // real elapsed time.
  const time = resolveTime(opts.time, opts.daemonLease)
  let lastHeartbeat: number | undefined
  const budget = lane === 'fast' ? MAX_FAST_DRAIN : 1

  return async (): Promise<UnitResult> => {
    // The heartbeat throttle uses poll time; row transitions read the clock again.
    const now = time.now()
    opts.daemonLease?.assertOwned()
    // The heartbeat rides the fast lane only: the slow lane can legitimately
    // sit inside one action for minutes, which would read as a dead daemon.
    if (
      lane === 'fast' &&
      (lastHeartbeat === undefined || now.getTime() - lastHeartbeat >= DAEMON_HEARTBEAT_MS)
    ) {
      lastHeartbeat = now.getTime()
      db.transaction(() => {
        opts.daemonLease?.assertOwned()
        stampDaemonSeen(db, opts.pid ?? process.pid, now)
      }).immediate()
    }

    const done: number[] = []
    let blockedLease: ActionLease | undefined
    // Leases already found held THIS poll. `acquireLease` takes a BEGIN
    // IMMEDIATE write transaction, so re-attempting a lease that is not going
    // to be free within one poll is pure WAL churn — 50 write transactions a
    // second on the fast lane's 1s poll. Skipping also leaves the later rows
    // completely untouched, which is what the notice assertion pins.
    const heldThisPoll = new Set<ActionLease>()
    for (const row of pendingActions(db, lane, ACTION_SCAN_WINDOW)) {
      if (done.length >= budget) break
      const declared = isActionKind(row.kind) ? ACTIONS[row.kind].lease : undefined
      if (declared !== undefined && heldThisPoll.has(declared)) continue
      const outcome = await executeOne(db, row, {
        channelsDir: opts.channelsDir,
        runsRoot: opts.runsRoot,
        lane,
        time,
        run,
        daemonLease: opts.daemonLease,
      })
      if (outcome.blockedBy !== undefined) {
        blockedLease ??= outcome.blockedBy
        heldThisPoll.add(outcome.blockedBy)
        continue
      }
      // A lost claim means another caller already took this row: this poll
      // did no work on it, so it must not inflate `ran`.
      if (outcome.lostClaim) continue
      done.push(row.id)
    }

    if (done.length > 0)
      return { worked: true, line: { action: 'actions', lane, ran: done.length } }
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
    lane: ActionLane
    time: TimeSource
    run: typeof runAction
    daemonLease?: LeaseContext
  },
): Promise<{ blockedBy?: ActionLease; lostClaim?: boolean }> {
  const mutate = <T>(fn: () => T): T =>
    db
      .transaction(() => {
        deps.daemonLease?.assertOwned()
        return fn()
      })
      .immediate()
  if (!isActionKind(row.kind)) {
    mutate(() => {
      if (startAction(db, row.id, deps.time.now(), deps.daemonLease))
        failAction(
          db,
          row.id,
          new BrainrotError(`unknown action kind ${JSON.stringify(row.kind)}`, {
            domain: 'config',
            kind: 'invalid',
          }),
          deps.time.now(),
          deps.daemonLease,
        )
    })
    return {}
  }
  const name = ACTIONS[row.kind].lease
  const lease = name
    ? acquireManagedLease(db, name, deps.daemonLease, { time: deps.time })
    : undefined
  if (lease === null) {
    const notice = `waiting for the ${name!} lease`
    if (row.notice !== notice) mutate(() => setActionNotice(db, row.id, notice))
    return { blockedBy: name }
  }
  try {
    const startedAt = deps.time.now()
    if (!mutate(() => startAction(db, row.id, startedAt, deps.daemonLease)))
      return { lostClaim: true }
    const ctx: ActionContext = {
      db,
      time: deps.time,
      channelsDir: deps.channelsDir,
      runsRoot: deps.runsRoot,
      actionId: row.id,
      lease,
      daemonLease: deps.daemonLease,
      setNotice: (text) =>
        mutate(() => {
          lease?.assertOwned()
          db.prepare(
            "UPDATE operator_actions SET notice=? WHERE id=? AND status='running' AND owner_token IS ?",
          ).run(text, row.id, deps.daemonLease?.token ?? null)
        }),
    }
    try {
      let args: unknown
      try {
        args = JSON.parse(row.args)
      } catch {
        throw new BrainrotError('args column is not valid JSON', {
          domain: 'config',
          kind: 'invalid',
        })
      }
      const result = await deps.run(ctx, row.kind, args)
      mutate(() => {
        lease?.assertOwned()
        completeAction(db, row.id, result, deps.time.now(), deps.daemonLease)
      })
    } catch (err) {
      // A stale owner leaves the running row for reconciliation, never overwrites it.
      deps.daemonLease?.assertOwned()
      if (
        lease &&
        deps.daemonLease &&
        reconcileInterruptedAction(db, row.id, deps.daemonLease, lease)
      )
        return {}
      lease?.assertOwned()
      mutate(() => failAction(db, row.id, err, deps.time.now(), deps.daemonLease))
    }
    return {}
  } finally {
    lease?.release()
  }
}
