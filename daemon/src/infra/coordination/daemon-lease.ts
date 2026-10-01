import type { Database } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createDeadline, type TimeSource } from '../../shared/time.js'
import { releaseLease, requireLease, type LeaseContext } from './lease.js'

// The socket lives beside SQLite so every container using that volume can
// probe the actual owner. PIDs are not identities across container restarts.
function ownerPath(db: Database, token: string): string | undefined {
  const match = /^daemon-socket:([A-Za-z0-9_-]{16})$/.exec(token)
  return match ? join(dirname(db.name), `.d-${match[1]}`) : undefined
}

async function ownerIsDead(path: string, time: TimeSource): Promise<boolean> {
  const deadline = createDeadline(time, 1000)
  try {
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection({ path, signal: deadline.signal })
      socket.once('connect', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy()
        // Permission errors, timeouts, and unknown failures are not proof of death.
        resolve(error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
      })
    })
  } finally {
    deadline.dispose()
  }
}

/** Reclaim only a positively identified dead daemon, before startup recovery. */
export async function requireDaemonLease(db: Database, time: TimeSource): Promise<LeaseContext> {
  const previous = db
    .prepare("SELECT holder, expires_at FROM leases WHERE name = 'daemon'")
    .get() as { holder: string; expires_at: string } | undefined
  const previousPath = previous && ownerPath(db, previous.holder)
  const dead =
    previous !== undefined &&
    previous.expires_at > time.now().toISOString() &&
    previousPath !== undefined &&
    (await ownerIsDead(previousPath, time))

  const token = `daemon-socket:${randomBytes(12).toString('base64url')}`
  const path = ownerPath(db, token)!
  const server = createServer((socket) => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    server.unref()
    // The probe is asynchronous; another starter may already have replaced
    // the row. Compare its token under the same lock as the new acquisition.
    const lease = db
      .transaction(() => {
        if (dead) releaseLease(db, 'daemon', previous.holder)
        return requireLease(db, 'daemon', undefined, { time, token })
      })
      .immediate()
    if (dead && previousPath) {
      // A killed process can leave the socket inode behind. Its random name
      // belongs only to that old owner, never to the replacement.
      try {
        rmSync(previousPath, { force: true })
      } catch {
        /* recovery already succeeded */
      }
    }
    let released = false
    return {
      ...lease,
      release() {
        if (released) return
        released = true
        try {
          lease.release()
        } finally {
          server.close()
        }
      },
    }
  } catch (error) {
    server.close()
    throw error
  }
}
