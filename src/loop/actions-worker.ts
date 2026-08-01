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
 */
export const ACTION_SCAN_WINDOW = MAX_FAST_DRAIN

/**
 * A fast-lane action completes in milliseconds — the acquire-to-release
 * window around a single SQLite UPDATE — so 60s is already three orders of
 * magnitude of headroom. Using the lease's own (much longer) TTL here would
 * mean a SIGKILL inside that ~1ms window orphans the lease for that full TTL
 * (30 min for `publish`); `failRunningActions` heals the row on restart but
 * not the lease, so e.g. publishing would stall silently until expiry. Only
 * the slow lane, where an action can legitimately run for minutes, uses the
 * per-lease TTL below.
 */
export const FAST_ACTION_LEASE_TTL_MS = 60_000

const LEASE_TTL_MS: Record<ActionLease, number> = {
  produce: PRODUCE_LEASE_TTL_MS,
  publish: PUBLISH_LEASE_TTL_MS,
  scout: SCOUT_LEASE_TTL_MS,
}

function leaseTtlMs(lane: ActionLane, lease: ActionLease): number {
  return lane === 'fast' ? FAST_ACTION_LEASE_TTL_MS : LEASE_TTL_MS[lease]
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
  // The per-row clock. A single frozen `Date` per poll would record
  // finished_at === started_at for a slow action taking seconds or minutes;
  // reading it fresh at each row transition is what lets those columns carry
  // real elapsed time.
  const clock = opts.now ?? ((): Date => new Date())
  // Startup repair, run once. Within one daemon process a 'running' row on the
  // first poll can only be from a dead process, so no age threshold has to be
  // guessed — and guessing one would sweep a legitimately long action out from
  // under itself.
  let swept = false
  let lastHeartbeat = 0
  const budget = lane === 'fast' ? MAX_FAST_DRAIN : 1

  return async (): Promise<UnitResult> => {
    // Poll-level `now`: only the heartbeat throttle and the startup sweep are
    // genuinely per-poll decisions. Per-row work reads `clock()` again below.
    const now = clock()
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
    for (const row of pendingActions(db, lane, ACTION_SCAN_WINDOW)) {
      if (done.length >= budget) break
      const outcome = await executeOne(db, row, {
        channelsDir: opts.channelsDir,
        runsRoot: opts.runsRoot,
        lane,
        clock,
        run,
      })
      if (outcome.blockedBy !== undefined) {
        blockedLease ??= outcome.blockedBy
        continue
      }
      // A lost claim means another caller already took this row: this poll
      // did no work on it, so it must not inflate `ran`.
      if (outcome.lostClaim) continue
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
    lane: ActionLane
    clock: () => Date
    run: typeof runAction
  },
): Promise<{ blockedBy?: ActionLease; lostClaim?: boolean }> {
  if (!isActionKind(row.kind)) {
    startAction(db, row.id, deps.clock())
    failAction(
      db,
      row.id,
      new BrainrotError(`unknown action kind ${JSON.stringify(row.kind)}`, {
        domain: 'config',
        kind: 'invalid',
      }),
      deps.clock(),
    )
    return {}
  }

  const lease = ACTIONS[row.kind].lease
  let holder: string | undefined
  if (lease !== undefined) {
    holder = `pid:${process.pid}:action:${row.id}`
    if (!acquireLease(db, lease, holder, leaseTtlMs(deps.lane, lease))) {
      setActionNotice(db, row.id, `waiting for the ${lease} lease`)
      return { blockedBy: lease }
    }
  }

  try {
    // The status guard in startAction is the claim; losing it means another
    // caller already took this row, so this poll performed no terminal
    // transition on it and must not count it as work done.
    const startedAt = deps.clock()
    if (!startAction(db, row.id, startedAt)) return { lostClaim: true }
    let args: unknown
    try {
      args = JSON.parse(row.args)
    } catch {
      failAction(
        db,
        row.id,
        new BrainrotError('args column is not valid JSON', { domain: 'config', kind: 'invalid' }),
        deps.clock(),
      )
      return {}
    }
    const ctx: ActionContext = {
      db,
      now: startedAt,
      channelsDir: deps.channelsDir,
      runsRoot: deps.runsRoot,
      setNotice: (text) => setActionNotice(db, row.id, text),
    }
    try {
      completeAction(db, row.id, await deps.run(ctx, row.kind, args), deps.clock())
    } catch (err) {
      failAction(db, row.id, err, deps.clock())
    }
    return {}
  } finally {
    if (lease !== undefined && holder !== undefined) releaseLease(db, lease, holder)
  }
}
