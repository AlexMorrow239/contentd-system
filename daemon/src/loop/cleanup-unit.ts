import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import type { Database } from 'better-sqlite3'
import { tryLoadChannelsDir } from '../config/channel.js'
import { errorMessage } from '../errors.js'
import { fullyPostedClause } from '../posts/posts.js'
import { resolveTime, type TimeSource } from '../time.js'
import type { LeaseContext } from './lease.js'
import type { UnitResult, WorkerUnit } from './worker-contract.js'

const RETENTION_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

interface Video {
  jobId: string
  videoPath: string
}

/** Validate both lexical and real paths: a job or stage symlink must never
 * redirect deletion into shared assets, another job, or outside runs/. */
function removeVideo(runsRoot: string, video: Video): void {
  const root = resolve(runsRoot)
  const jobRoot = resolve(root, video.jobId)
  const candidate = resolve(video.videoPath)
  if (
    dirname(jobRoot) !== root ||
    !candidate.startsWith(jobRoot + sep) ||
    extname(candidate).toLowerCase() !== '.mp4'
  ) {
    throw new Error('video path is not an MP4 within its job directory')
  }
  if (!lstatSync(candidate).isFile()) throw new Error('video path is not a regular file')
  const realJobRoot = realpathSync(jobRoot)
  const realCandidate = realpathSync(candidate)
  if (
    realJobRoot !== resolve(realpathSync(root), video.jobId) ||
    !realCandidate.startsWith(realJobRoot + sep)
  ) {
    throw new Error('video path escapes its job directory through a symlink')
  }
  unlinkSync(realCandidate)
}

/** Background retention for finished library MP4s. Persisted posting times
 * make restarts catch up without another table; only sweep throttling is local.
 * Each small synchronous deletion is guarded by an immediate transaction so
 * no posting mutation can slip between the eligibility recheck and unlink. */
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
    if (loaded.error !== undefined) {
      return {
        worked: false,
        line: { action: 'noop', reason: 'config-error', error: loaded.error },
      }
    }
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
            removeVideo(opts.runsRoot, video)
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
