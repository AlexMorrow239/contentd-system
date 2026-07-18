import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from './db/index.js'

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
})
