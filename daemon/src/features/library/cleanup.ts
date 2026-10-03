import type { Database } from 'better-sqlite3'
import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { configErrorNoop, tryLoadChannelsDir } from '../../config/channel.js'
import type { LeaseContext } from '../../infra/coordination/lease.js'
import type { UnitResult, WorkerUnit } from '../../shared/contracts/worker.js'
import { errorMessage } from '../../shared/errors.js'
import { resolveTime, type TimeSource } from '../../shared/time.js'
import { fullyPostedClause } from '../posting/posts.js'

const RETENTION_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

interface Video {
  jobId: string
  videoPath: string
}

/** Delete only a direct child of runs/. Recursive rm unlinks nested symlinks
 * without following them; a symlink replacing the run itself is rejected. */
function removeRun(runsRoot: string, jobId: string): void {
  const root = resolve(runsRoot)
  const jobRoot = resolve(root, jobId)
  if (basename(jobRoot) !== jobId || dirname(jobRoot) !== root) {
    throw new Error('run path is not a direct job directory within runs')
  }
  if (!lstatSync(jobRoot).isDirectory()) throw new Error('run path is not a regular directory')
  if (realpathSync(jobRoot) !== resolve(realpathSync(root), jobId)) {
    throw new Error('run path escapes runs through a symlink')
  }
  rmSync(jobRoot, { recursive: true })
}

/** Background retention for fully posted runs. Persisted posting times make
 * restarts catch up without another table; only sweep throttling is local.
 * Deletion is guarded by an immediate transaction so no posting mutation can
 * slip between the eligibility recheck and removal. */
export function cleanupUnit(
  db: Database,
  opts: {
    channelsDir: string
    runsRoot: string
    time?: TimeSource
    daemonLease?: LeaseContext
  },
): WorkerUnit {
  const time = resolveTime(opts.time, opts.daemonLease)
  let lastSweepAt: number | undefined
  const tick = (): UnitResult => {
    const now = time.now().getTime()
    if (lastSweepAt !== undefined && now - lastSweepAt < CLEANUP_INTERVAL_MS)
      return { worked: false }
    lastSweepAt = now
    const loaded = tryLoadChannelsDir(opts.channelsDir)
    if (loaded.error !== undefined) return { worked: false, line: configErrorNoop(loaded.error) }
    const cutoff = new Date(now - RETENTION_MS).toISOString()
    const deleted: Video[] = []
    const errors: (Video & { error: string })[] = []
    for (const channel of loaded.channels) {
      if (channel.platforms.length === 0) continue
      const fullyPosted = fullyPostedClause(channel.platforms, { alias: 'l', match: 'fully' })
      const sql = `SELECT l.job_id AS jobId, l.video_path AS videoPath
        FROM library l JOIN jobs j ON j.id = l.job_id
        WHERE j.channel = ? AND j.status = 'done' AND j.deleted_at IS NULL
          AND ${fullyPosted.sql}
          AND (SELECT MAX(p.posted_at) FROM posts p WHERE p.job_id = l.job_id
            AND p.platform IN (${channel.platforms.map(() => '?').join(', ')})) <= ?`
      const params = [channel.name, ...fullyPosted.params, ...channel.platforms, cutoff]
      const candidates = db.prepare(sql).all(...params) as Video[]
      const eligible = db.prepare(sql + ' AND l.job_id = ? AND l.video_path = ?')
      for (const video of candidates) {
        db.transaction(() => {
          // Ownership failures propagate to the worker loop, never become a
          // per-file error that allows the old owner to keep deleting.
          opts.daemonLease?.assertOwned()
          if (eligible.get(...params, video.jobId, video.videoPath) === undefined) return
          try {
            removeRun(opts.runsRoot, video.jobId)
            deleted.push(video)
          } catch (err) {
            // Missing bytes already satisfy retention, including prior sweeps.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
              errors.push({ ...video, error: errorMessage(err) })
          }
        }).immediate()
      }
    }
    if (deleted.length === 0 && errors.length === 0) return { worked: false }
    return { worked: deleted.length > 0, line: { action: 'cleanup', deleted, errors } }
  }
  return () => Promise.resolve().then(tick)
}
