import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { errorMessage } from '../errors.js'
import { localDay } from '../time.js'
import { SCOUT_LEASE_TTL_MS, ScoutRunFailedError, scoutAll } from '../scout/scout.js'
import type { ScoutChannelResult } from '../scout/scout.js'
import { FAST_IDLE_SLEEP_MS, actionsUnit } from './actions-worker.js'
import { buildDigest } from './digest.js'
import { acquireLease, releaseLease } from './lease.js'
import { produceNextTick } from './produce-next.js'

export const IDLE_SLEEP_MS = 30_000
export const ERROR_SLEEP_MS = 60_000

/** One worker iteration's outcome. `worked` = re-check demand immediately;
 * idle = sleep first. `line` is the JSON log line; an idle result may omit it
 * to stay silent without resetting the dedupe (see runWorker). */
export interface UnitResult {
  worked: boolean
  line?: Record<string, unknown>
}

export interface WorkerDeps {
  sleep: (ms: number) => Promise<void>
  emit: (line: Record<string, unknown>) => void
}

/** setTimeout that resolves early (never rejects) when the signal aborts, so
 * SIGTERM ends an idle sleep in milliseconds, not thirty seconds. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/**
 * The daemon's one loop shape: check demand -> one unit -> re-check
 * immediately; idle sleeps IDLE_SLEEP_MS; a throwing unit logs and sleeps
 * ERROR_SLEEP_MS — the daemon never dies over one bad tick. Consecutive
 * identical idle lines are deduped so a quiet night is silent, not 2,880
 * noop lines; any worked unit (or error) resets the dedupe so the next idle
 * reason is reported once.
 */
export async function runWorker(
  name: string,
  unit: () => Promise<UnitResult>,
  signal: AbortSignal,
  deps: WorkerDeps,
  // The actions-fast worker polls at ~1s so a row mutation feels immediate;
  // every other worker keeps the 30s default.
  opts: { idleSleepMs?: number } = {},
): Promise<void> {
  const idleSleepMs = opts.idleSleepMs ?? IDLE_SLEEP_MS
  let lastIdleKey: string | undefined
  while (!signal.aborted) {
    let result: UnitResult
    try {
      result = await unit()
    } catch (err) {
      lastIdleKey = undefined
      // Deliberately NOT deduped, unlike idle lines: a unit failing the same
      // way for the tenth minute running is the signal, not noise.
      deps.emit({ worker: name, action: 'worker-error', error: errorMessage(err) })
      await deps.sleep(ERROR_SLEEP_MS)
      continue
    }
    if (result.worked) {
      lastIdleKey = undefined
      if (result.line !== undefined) deps.emit({ worker: name, ...result.line })
      continue
    }
    if (result.line !== undefined) {
      const key = JSON.stringify(result.line)
      if (key !== lastIdleKey) {
        lastIdleKey = key
        deps.emit({ worker: name, ...result.line })
      }
    }
    await deps.sleep(idleSleepMs)
  }
}

export const DIGEST_HOUR = 8

export function produceUnit(
  db: Database,
  opts: { channelsDir: string; runsRoot: string; tick?: typeof produceNextTick },
): () => Promise<UnitResult> {
  const tick = opts.tick ?? produceNextTick
  return async () => {
    const result = await tick(db, { channelsDir: opts.channelsDir, runsRoot: opts.runsRoot })
    return { worked: result.action !== 'noop', line: { ...result } }
  }
}

/**
 * One unit = one scoutAll pass over every configured channel. The recheck
 * cadence AND the queue-depth demand check both live INSIDE scoutChannel now
 * (skipped: 'recheck-not-due' / 'queue-full'), backed by the persisted
 * `scout_state` table — so this unit is a thin wrapper, like produceUnit,
 * with no scheduling state of its own. lease-held never reaches scoutChannel
 * at all, so it never records an attempt, for free.
 */
export function scoutUnit(
  db: Database,
  opts: { channelsDir: string; now?: () => Date; scout?: typeof scoutAll },
): () => Promise<UnitResult> {
  const scout = opts.scout ?? scoutAll
  return async () => {
    const now = opts.now?.() ?? new Date()
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    if (loaded.error !== undefined) {
      return {
        worked: false,
        line: { action: 'noop', reason: 'config-error', error: loaded.error },
      }
    }
    if (loaded.channels.length === 0) return { worked: false }
    const holder = `pid:${process.pid}`
    if (!acquireLease(db, 'scout', holder, SCOUT_LEASE_TTL_MS)) {
      return { worked: false, line: { action: 'noop', reason: 'lease-held' } }
    }
    try {
      let results: ScoutChannelResult[]
      try {
        results = await scout(db, loaded.channels, { now })
      } catch (err) {
        if (err instanceof ScoutRunFailedError) {
          return {
            worked: true,
            line: { action: 'scouted', channels: err.results, error: errorMessage(err) },
          }
        }
        throw err
      }
      // scoutAll drops channels with no [scout] sources before running any of
      // them, so `results` can be empty while `loaded.channels` is not.
      // `[].every(...)` is vacuously true, which reported "nothing is
      // scoutable" as `queue-full` — a queue depth nothing measured. Name the
      // two apart.
      if (results.length === 0) {
        return { worked: false, line: { action: 'noop', reason: 'no-scout-sources' } }
      }
      if (results.every((r) => r.skipped !== undefined)) {
        // Every channel was gated, either by queue depth or by not being due
        // for a recheck yet. The latter is the common every-30s case (most
        // channels sit inside SCOUT_RECHECK_MS most of the time) and stays
        // silent; queue-full is the rarer, more informative state worth
        // surfacing once via runWorker's idle dedupe.
        const anyQueueFull = results.some((r) => r.skipped === 'queue-full')
        return anyQueueFull
          ? { worked: false, line: { action: 'noop', reason: 'queue-full' } }
          : { worked: false }
      }
      return { worked: true, line: { action: 'scouted', channels: results } }
    } finally {
      releaseLease(db, 'scout', holder)
    }
  }
}

/** Fires once per local day at or after DIGEST_HOUR. In-memory guard: a
 * restart later the same day re-fires once — acceptable for a read-only
 * report whose only delivery is the log stream. */
export function digestUnit(
  db: Database,
  opts: { channelsDir: string; now?: () => Date },
): () => Promise<UnitResult> {
  let lastDay: string | undefined
  // Synchronous inner: buildDigest is a pure SQLite read with nothing to await,
  // so the promise exists only because every unit shares one signature.
  const tick = (): UnitResult => {
    const now = opts.now?.() ?? new Date()
    if (now.getHours() < DIGEST_HOUR || lastDay === localDay(now)) return { worked: false }
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    const text = buildDigest(db, loaded.channels, { channelsError: loaded.error })
    lastDay = localDay(now)
    return { worked: true, line: { action: 'digest', text } }
  }
  return () => Promise.resolve(tick())
}

export async function runDaemon(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    now?: () => Date
    emit?: WorkerDeps['emit']
    sleep?: WorkerDeps['sleep']
    signal?: AbortSignal
  },
): Promise<void> {
  // Always an INTERNAL controller, even when the caller supplies a signal: a
  // worker can reject from outside its unit's try/catch (an emit that EPIPEs
  // on a closed stdout, an injected sleep that rejects), and the daemon must
  // be able to stop the other three itself. Sharing the caller's signal gave
  // it no such handle — Promise.all rejected on the first failure while three
  // workers kept looping, and cli.ts's `finally` then closed the shared
  // better-sqlite3 handle under them.
  const controller = new AbortController()
  const signal = controller.signal
  if (opts.signal === undefined) {
    process.once('SIGTERM', () => controller.abort())
    process.once('SIGINT', () => controller.abort())
  } else if (opts.signal.aborted) {
    controller.abort()
  } else {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const emit =
    opts.emit ??
    ((line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + '\n'))
  const deps: WorkerDeps = {
    emit,
    sleep: opts.sleep ?? ((ms) => abortableSleep(ms, signal)),
  }
  emit({ action: 'daemon-started', pid: process.pid })
  // A rejecting worker aborts the rest; allSettled then waits for every one
  // of them to actually leave its loop, so runDaemon never returns (or
  // rejects) while a worker is still touching the db — which is exactly what
  // cli.ts's `finally { db.close() }` would otherwise race.
  const supervise = (
    name: string,
    unit: () => Promise<UnitResult>,
    workerOpts: { idleSleepMs?: number } = {},
  ): Promise<void> =>
    runWorker(name, unit, signal, deps, workerOpts).catch((err: unknown) => {
      controller.abort()
      throw err
    })
  const settled = await Promise.allSettled([
    supervise('produce', produceUnit(db, opts)),
    supervise('scout', scoutUnit(db, { channelsDir: opts.channelsDir, now: opts.now })),
    supervise('digest', digestUnit(db, { channelsDir: opts.channelsDir, now: opts.now })),
    // The operator-action lanes. actions-fast also carries the daemon
    // heartbeat the dashboard reads to tell "queued" from "queued into the
    // void", which is why it polls at FAST_IDLE_SLEEP_MS rather than the 30s
    // default.
    supervise(
      'actions-fast',
      actionsUnit(db, 'fast', {
        channelsDir: opts.channelsDir,
        runsRoot: opts.runsRoot,
        now: opts.now,
      }),
      { idleSleepMs: FAST_IDLE_SLEEP_MS },
    ),
    supervise(
      'actions-slow',
      actionsUnit(db, 'slow', {
        channelsDir: opts.channelsDir,
        runsRoot: opts.runsRoot,
        now: opts.now,
      }),
    ),
  ])
  // Surface the failure only after every worker has left its loop. A second
  // worker rejecting during the cascade is almost always a consequence of the
  // first, so the earliest one in worker order is the one worth reporting.
  const failed = settled.find((outcome) => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
