import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from './db/index.js'
import { parseTier, stagesForTier } from './cli.js'
import { visualsPremiumStage } from './stages/visuals-premium.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'

const cleanup: string[] = []
function tmpDbPath(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'brainrot-cli-'))
  cleanup.push(d)
  return path.join(d, 'brainrot.db')
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('brainrot CLI', () => {
  it('`jobs` opens the db and prints a table header, exiting 0', async () => {
    const dbPath = tmpDbPath()
    // Seed one job so console.table renders column headers (empty tables print nothing).
    const db = openDb(dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('j1', 'example', 'volume', 'venus', 'queued')",
    ).run()
    db.close()

    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'jobs', '--db', dbPath], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    // console.table header row names the selected columns.
    expect(result.stdout).toContain('status')
  }, 60000)

  it('`produce --help` prints usage with --channel/--topic/--tier', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'produce', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--channel')
    expect(result.stdout).toContain('--topic')
    expect(result.stdout).toContain('--tier')
  }, 60000)

  function countJobs(dbPath: string): number {
    const db = openDb(dbPath)
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }
    db.close()
    return n
  }

  it('`produce --tier premium` passes tier validation (fails later on the missing channel file)', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce',
        '--channel', '/no/such/channel.toml', '--topic', 'venus', '--tier', 'premium', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    // Tier accepted: the failure is the nonexistent channel file, NOT the tier.
    expect(result.stderr).toMatch(/ENOENT|no such file/)
    expect(result.stderr).not.toContain('unsupported --tier')
    // The channel load throws before openDb/createJob, so no job row exists.
    expect(countJobs(dbPath)).toBe(0)
  }, 60000)

  it('`produce --tier garbage` exits 1 listing both valid tiers and creates no job', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce',
        '--channel', '/no/such/channel.toml', '--topic', 'venus', '--tier', 'garbage', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unsupported --tier "garbage"')
    expect(result.stderr).toContain('valid tiers are "volume", "premium"')
    expect(countJobs(dbPath)).toBe(0)
  }, 60000)

  it('`produce` with a nonexistent --channel exits 1 with a clean one-line error (no stack)', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce',
        '--channel', '/no/such/channel.toml', '--topic', 'venus', '--tier', 'volume', '--db', dbPath],
      { reject: false },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/ENOENT|no such file/)
    // Just the message — no raw unhandled-rejection stack frames ("    at ...").
    expect(result.stderr).not.toMatch(/\n\s+at /)
    expect(countJobs(dbPath)).toBe(0)
  }, 60000)
})

describe('tier helpers (in-process)', () => {
  it('parseTier accepts both tiers and rejects others naming the valid set', () => {
    expect(parseTier('volume')).toBe('volume')
    expect(parseTier('premium')).toBe('premium')
    expect(() => parseTier('4k')).toThrow(
      'unsupported --tier "4k": valid tiers are "volume", "premium"',
    )
  })

  it('stagesForTier swaps only the visuals slot by tier', () => {
    const volume = stagesForTier('volume')
    const premium = stagesForTier('premium')
    const order = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc']
    expect(volume.map((s) => s.name)).toEqual(order)
    expect(premium.map((s) => s.name)).toEqual(order)
    // The visuals slot is the tier branch — asserted by identity.
    expect(volume[3]).toBe(visualsVolumeStage)
    expect(premium[3]).toBe(visualsPremiumStage)
    // script/voice/captions/assemble are the same stage objects in both lists
    // (they branch internally on ctx.tier). qcStage() mints a fresh StageDef
    // per call, so it is covered by the name assertion above, not identity.
    for (const i of [0, 1, 2, 4]) expect(premium[i]).toBe(volume[i])
  })
})
