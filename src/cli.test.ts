import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from './db/index.js'
import { assertPremiumPreflight, parseTier, parseTopicIds, stagesForTier } from './cli.js'
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
      // FAL_KEY set so the premium pre-flight passes and the run reaches the
      // channel load; this test isolates tier validation, not the key check
      // (which is covered in-process below).
      { reject: false, env: { FAL_KEY: 'test-fal-key' } },
    )
    expect(result.exitCode).toBe(1)
    // Tier accepted: the failure is the nonexistent channel file, NOT the tier.
    expect(result.stderr).toMatch(/ENOENT|no such file/)
    expect(result.stderr).not.toContain('unsupported --tier')
    // The channel load throws before openDb/createJob, so no job row exists.
    expect(countJobs(dbPath)).toBe(0)
  }, 60000)

  it('`produce --tier premium` aborts before any spend when FAL_KEY is unset', async () => {
    const dbPath = tmpDbPath()
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'produce',
        '--channel', '/no/such/channel.toml', '--topic', 'venus', '--tier', 'premium', '--db', dbPath],
      // Explicitly clear FAL_KEY (and keep dotenv from supplying one) so the
      // pre-flight fires before loadChannelConfig ever runs.
      { reject: false, env: { FAL_KEY: '' } },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('premium tier requires FAL_KEY')
    // The pre-flight throws before openDb/createJob, so no job row exists.
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

  // Plan-1-shape channel TOML with no [scout] table: loadChannelsDir parses it,
  // scoutAll skips it (DEFAULT_SCOUT has no sources) — the cheapest full E2E.
  const SCOUTLESS_TOML = [
    'name = "cli-scout-test"',
    'niche = ["space facts"]',
    'bg_dir = "assets/bg"',
    'bgm_dir = "assets/bgm"',
    '',
    '[tier_mix]',
    'volume = 2',
    'premium = 1',
    '',
    '[voice]',
    'volume = "af_heart"',
    '',
    '[caption_style]',
    'font = "Inter"',
    'font_size_px = 72',
    'active_color = "#FFD700"',
    'inactive_color = "#FFFFFF"',
    'stroke_px = 8',
    '',
    '[budget]',
    'per_video_usd = 8.0',
    'per_day_usd = 20.0',
  ].join('\n')

  it('`scout --help` prints usage with --db/--channels-dir', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'scout', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--db')
    expect(result.stdout).toContain('--channels-dir')
  }, 60000)

  it('`scout` over a sourceless channels dir prints one JSON line and exits 0', async () => {
    const dbPath = tmpDbPath()
    const channelsDir = mkdtempSync(path.join(tmpdir(), 'brainrot-channels-'))
    cleanup.push(channelsDir)
    writeFileSync(path.join(channelsDir, 'test.toml'), SCOUTLESS_TOML)
    const result = await execa(
      'pnpm',
      ['exec', 'tsx', 'src/cli.ts', 'scout', '--db', dbPath, '--channels-dir', channelsDir],
      { reject: false },
    )
    expect(result.exitCode).toBe(0)
    // exactly one cron-greppable JSON line on stdout
    expect(JSON.parse(result.stdout)).toEqual({ channels: [] })
  }, 60000)

  it('`topics --help` lists the list/approve/reject subcommands', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'topics', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('list')
    expect(result.stdout).toContain('approve')
    expect(result.stdout).toContain('reject')
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

describe('assertPremiumPreflight (in-process)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws for premium when FAL_KEY is unset, before any config/db/job work', () => {
    vi.stubEnv('FAL_KEY', undefined)
    expect(() => assertPremiumPreflight('premium')).toThrow(
      'premium tier requires FAL_KEY in the environment (see .env.example); aborting before any spend',
    )
  })

  it('passes for premium when FAL_KEY is set, and never blocks volume', () => {
    vi.stubEnv('FAL_KEY', 'fal-test-key')
    expect(() => assertPremiumPreflight('premium')).not.toThrow()
    // Volume never needs a fal key, even when it is absent.
    vi.stubEnv('FAL_KEY', undefined)
    expect(() => assertPremiumPreflight('volume')).not.toThrow()
  })
})

describe('parseTopicIds (in-process)', () => {
  it('parses positive integer tokens in order', () => {
    expect(parseTopicIds(['12', '3', '400'])).toEqual([12, 3, 400])
    // commander's <ids...> guarantees at least one token, but the helper
    // itself is total: an empty list is an empty result, not an error.
    expect(parseTopicIds([])).toEqual([])
  })

  it('throws naming the first bad token; "12abc", "0", "-3" all reject', () => {
    expect(() => parseTopicIds(['12abc'])).toThrow(
      'invalid topic id "12abc": ids must be positive integers',
    )
    expect(() => parseTopicIds(['0'])).toThrow('invalid topic id "0"')
    expect(() => parseTopicIds(['-3'])).toThrow('invalid topic id "-3"')
    // the FIRST offender is the one named, even when later tokens are also bad
    expect(() => parseTopicIds(['5', '0', '-3'])).toThrow('invalid topic id "0"')
  })
})
