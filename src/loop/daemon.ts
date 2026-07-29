import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { errorMessage } from '../errors.js'
import { localDay } from '../publish/schedule.js'
import { SCOUT_LEASE_TTL_MS, ScoutRunFailedError, scoutAll } from '../scout/scout.js'
import type { ScoutChannelResult } from '../scout/scout.js'
import { buildDigest } from './digest.js'
import { acquireLease, releaseLease } from './lease.js'
import { produceNextTick } from './produce-next.js'
import { publishNextTick } from './publish-next.js'

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
): Promise<void> {
  let lastIdleKey: string | undefined
  while (!signal.aborted) {
    let result: UnitResult
    try {
      result = await unit()
    } catch (err) {
      lastIdleKey = undefined
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
    await deps.sleep(IDLE_SLEEP_MS)
  }
}

export const SCOUT_RECHECK_MS = 1_200_000 // 20 min between scout attempts per channel
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

export function publishUnit(
  db: Database,
  opts: { channelsDir: string; tick?: typeof publishNextTick },
): () => Promise<UnitResult> {
  const tick = opts.tick ?? publishNextTick
  return async () => {
    const result = await tick(db, { channelsDir: opts.channelsDir })
    return { worked: result.action !== 'noop', line: { ...result } }
  }
}

/**
 * One unit = one scoutAll pass over the channels past their per-channel
 * recheck window. The queue-depth demand check lives INSIDE scoutChannel
 * (skipped: 'queue-full'), so the recheck clock is the only thing this unit
 * owns: it stops a quiet subreddit being fetched every 30 seconds. The clock
 * is in-memory — a daemon restart re-scouts immediately, and one redundant
 * fetch is harmless. queue-full still bumps the clock: the next real chance
 * to need topics is minutes away (a produce consumes one), not seconds.
 * lease-held does NOT bump it — nothing was attempted.
 */
export function scoutUnit(
  db: Database,
  opts: { channelsDir: string; now?: () => Date; scout?: typeof scoutAll },
): () => Promise<UnitResult> {
  const scout = opts.scout ?? scoutAll
  const lastAttempt = new Map<string, number>()
  return async () => {
    const nowMs = (opts.now?.() ?? new Date()).getTime()
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    if (loaded.error !== undefined) {
      return {
        worked: false,
        line: { action: 'noop', reason: 'config-error', error: loaded.error },
      }
    }
    const due = loaded.channels.filter(
      (c) => (lastAttempt.get(c.name) ?? 0) + SCOUT_RECHECK_MS <= nowMs,
    )
    if (due.length === 0) return { worked: false }
    const holder = `pid:${process.pid}`
    if (!acquireLease(db, 'scout', holder, SCOUT_LEASE_TTL_MS)) {
      return { worked: false, line: { action: 'noop', reason: 'lease-held' } }
    }
    try {
      let results: ScoutChannelResult[]
      try {
        results = await scout(db, due)
      } catch (err) {
        if (err instanceof ScoutRunFailedError) {
          for (const c of due) lastAttempt.set(c.name, nowMs)
          return {
            worked: true,
            line: { action: 'scouted', channels: err.results, error: errorMessage(err) },
          }
        }
        throw err
      }
      for (const c of due) lastAttempt.set(c.name, nowMs)
      if (results.every((r) => r.skipped === 'queue-full')) {
        return { worked: false, line: { action: 'noop', reason: 'queue-full' } }
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
    const text = buildDigest(db, loaded.channels, {}, { channelsError: loaded.error })
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
  const controller = new AbortController()
  const signal = opts.signal ?? controller.signal
  if (opts.signal === undefined) {
    process.once('SIGTERM', () => controller.abort())
    process.once('SIGINT', () => controller.abort())
  }
  const emit =
    opts.emit ??
    ((line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + '\n'))
  const deps: WorkerDeps = {
    emit,
    sleep: opts.sleep ?? ((ms) => abortableSleep(ms, signal)),
  }
  emit({ action: 'daemon-started', pid: process.pid })
  await Promise.all([
    runWorker('produce', produceUnit(db, opts), signal, deps),
    runWorker('publish', publishUnit(db, { channelsDir: opts.channelsDir }), signal, deps),
    runWorker(
      'scout',
      scoutUnit(db, { channelsDir: opts.channelsDir, now: opts.now }),
      signal,
      deps,
    ),
    runWorker(
      'digest',
      digestUnit(db, { channelsDir: opts.channelsDir, now: opts.now }),
      signal,
      deps,
    ),
  ])
}
