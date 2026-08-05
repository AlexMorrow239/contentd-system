import type { Database } from 'better-sqlite3'
import pino from 'pino'
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
import type { UnitResult } from './daemon.js'
import { DAEMON_HEARTBEAT_MS, stampDaemonSeen } from './daemon-state.js'
import { acquireLease, extendLease, leaseHolder, releaseLease } from './lease.js'

// Same construction as src/jobs/runner.ts:62 — inert by default (LOG_LEVEL
// unset means 'silent'), so this stays a no-op for every deployment that
// hasn't opted in.
const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' })

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
 *
 * The skip set below removes the redundant ACQUIRES, not this bound: 50 rows
 * all blocked on `produce` still means row 51 was never in the query's result
 * set and does not run this poll. That is left in place deliberately — it
 * self-heals on the next poll, and a queue 50 deep on one lease is not a shape
 * one operator clicking buttons produces.
 */
export const ACTION_SCAN_WINDOW = MAX_FAST_DRAIN

/**
 * The slow lane's own lease TTL, deliberately far below the leases' own
 * defaults (`produce` is 90 minutes). A slow action can legitimately run for
 * minutes, so unlike the fast lane it cannot simply use a short fixed window —
 * it holds a SHORT window and refreshes it below. What that buys is the orphan
 * case: a SIGKILL mid-render heals the action row via `failRunningActions` but
 * NOT the lease, so with the 90-minute default the daemon's own produce worker
 * would stall for 90 minutes. Five is the cost of the same crash now.
 */
export const SLOW_ACTION_LEASE_TTL_MS = 300_000

/**
 * How often a running slow action pushes its lease expiry out. Five beats fit
 * inside one TTL, which is the tolerance for a synchronous stretch that starves
 * the event loop (a render is mostly async — headless browser and spawned
 * ffmpeg — but nothing here guarantees that).
 */
export const SLOW_ACTION_HEARTBEAT_MS = 60_000

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
        clock,
        run,
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
  let beat: ReturnType<typeof setInterval> | undefined
  if (lease !== undefined) {
    holder = leaseHolder(`action:${row.id}`)
    // Every kind that declares a lease (`jobs.produce`, `scout.run`,
    // `jobs.resume`, `topics.pruneMedia`) is slow-lane, so this always
    // resolves to the slow TTL in practice — there is no separate fast-lane
    // TTL any more, since no fast action leases.
    if (!acquireLease(db, lease, holder, SLOW_ACTION_LEASE_TTL_MS)) {
      // Guarded on the text actually changing: the fast lane polls every 1s,
      // so an unconditional write here is one WAL write per second per
      // blocked row for as long as the lease is held — exactly the churn
      // DAEMON_HEARTBEAT_MS throttles the heartbeat stamp against, above.
      const text = `waiting for the ${lease} lease`
      if (row.notice !== text) setActionNotice(db, row.id, text)
      return { blockedBy: lease }
    }
    // The heartbeat still gates on lane === 'slow' explicitly, rather than
    // being implied by "any action that leases is slow": the mechanism stays
    // generic so a future fast action that legitimately needs a lease is not
    // silently starved of a heartbeat.
    if (deps.lane === 'slow') {
      // `let holder` doesn't narrow inside a closure even though it was just
      // assigned above; capture it as a const so the interval callback below
      // sees `string`, not `string | undefined`.
      const activeHolder = holder
      beat = setInterval(() => {
        // `false` is not acted on by re-acquiring: there is no abort channel
        // on ActionContext to stop the handler mid-flight, and re-acquiring
        // here would hand this lease to two live processes. It requires BOTH
        // five consecutive missed beats (so the row has actually passed its
        // expiry) AND another process calling acquireLease in that gap —
        // extendLease matches on holder only and never re-checks expires_at,
        // so a merely-late beat on an otherwise-unclaimed lease still
        // succeeds. `produce-next`'s own heartbeat ignores it for the same
        // no-abort-channel reason. It is still worth a log line: this is the
        // daemon's own mutual exclusion silently failing, and until now
        // nothing recorded that it happened.
        if (!extendLease(db, lease, activeHolder, SLOW_ACTION_LEASE_TTL_MS)) {
          log.warn({ lease, actionId: row.id }, 'lease heartbeat failed')
        }
      }, SLOW_ACTION_HEARTBEAT_MS)
      // Never hold the process open: on SIGTERM the daemon must be able to
      // exit once the in-flight action settles.
      beat.unref()
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
    if (beat !== undefined) clearInterval(beat)
    if (lease !== undefined && holder !== undefined) releaseLease(db, lease, holder)
  }
}
