import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { fileDb } from '../../../../testing/db.js'
import { createTestTime } from '../../../../testing/time.js'
import { runDaemon } from '../../../app/daemon.js'
import { systemTime } from '../../../shared/time.js'
import { requireDaemonLease } from '../daemon-lease.js'
import { LEASE_TTL_MS, acquireLease, releaseLease } from '../lease.js'

describe('requireDaemonLease', () => {
  it('refuses a live owner without changing its lease', async () => {
    const time = createTestTime(0)
    const { db } = fileDb('brainrot.db', time)
    const owner = await requireDaemonLease(db, time)
    try {
      await expect(requireDaemonLease(db, time)).rejects.toThrow('held by another operation')
      expect(() => owner.assertOwned()).not.toThrow()
    } finally {
      owner.release()
    }
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('reclaims an unexpired lease whose owner has gone and fences its old token', async () => {
    const time = createTestTime(0)
    const { db } = fileDb('brainrot.db', time)
    const old = await requireDaemonLease(db, time)
    old.release()
    acquireLease(db, 'daemon', old.token, LEASE_TTL_MS, time)
    const replacement = await requireDaemonLease(db, time)
    try {
      expect(replacement.token).not.toBe(old.token)
      releaseLease(db, 'daemon', old.token)
      expect(() => replacement.assertOwned()).not.toThrow()
    } finally {
      replacement.release()
    }
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('allows exactly one concurrent startup to reclaim a dead owner', async () => {
    const time = createTestTime(0)
    const { db } = fileDb('brainrot.db', time)
    const old = await requireDaemonLease(db, time)
    old.release()
    acquireLease(db, 'daemon', old.token, LEASE_TTL_MS, time)
    const results = await Promise.allSettled([
      requireDaemonLease(db, time),
      requireDaemonLease(db, time),
    ])
    const winners = results.filter((result) => result.status === 'fulfilled')
    try {
      expect(winners).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      winners[0]?.value.assertOwned()
    } finally {
      for (const winner of winners) winner.value.release()
    }
    expect(time.pendingTimerCount()).toBe(0)
  })

  it('recovers immediately after its owner is killed without waiting for lease expiry', async () => {
    const { db, dbPath } = fileDb()
    const module = new URL('../../../../dist/infra/coordination/daemon-lease.js', import.meta.url)
      .href
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import Database from 'better-sqlite3';
      const { requireDaemonLease } = await import(process.argv[2]);
      const { systemTime } = await import(process.argv[3]);
      const db = new Database(process.argv[1]);
      await requireDaemonLease(db, systemTime);
      process.stdout.write('ready');
      process.stdin.resume();
    `,
        dbPath,
        module,
        new URL('../../../../dist/shared/time.js', import.meta.url).href,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const exited = once(child, 'exit')
    try {
      const ready = await Promise.race([
        once(child.stdout, 'data').then(([data]) => String(data)),
        exited.then(() => {
          throw new Error('lease owner exited before becoming ready')
        }),
      ])
      expect(ready).toBe('ready')
      const before = db
        .prepare("SELECT holder, expires_at FROM leases WHERE name = 'daemon'")
        .get() as {
        holder: string
        expires_at: string
      }
      child.kill('SIGKILL')
      await exited
      expect(before.expires_at > new Date().toISOString()).toBe(true)
      let replacement: { holder: string } | undefined
      await runDaemon(db, {
        channelsDir: '/unused',
        runsRoot: '/unused',
        time: systemTime,
        workers: [],
        emit: () => {
          replacement = db.prepare("SELECT holder FROM leases WHERE name = 'daemon'").get() as {
            holder: string
          }
        },
      })
      expect(replacement?.holder).toBeDefined()
      expect(replacement?.holder).not.toBe(before.holder)
      expect(db.prepare("SELECT * FROM leases WHERE name = 'daemon'").all()).toEqual([])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

  it('honors unexpired legacy leases but permits takeover after expiry', async () => {
    const time = createTestTime(0)
    const { db } = fileDb('brainrot.db', time)
    acquireLease(db, 'daemon', `pid:${process.pid}:daemon:legacy`, LEASE_TTL_MS, time)
    await expect(requireDaemonLease(db, time)).rejects.toThrow('held by another operation')
    time.setNow(LEASE_TTL_MS)
    const owner = await requireDaemonLease(db, time)
    owner.release()
    expect(time.pendingTimerCount()).toBe(0)
  })
})
