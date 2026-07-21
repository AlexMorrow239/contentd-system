import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { assertPremiumPreflight as cliPreflight, stagesForTier as cliStages } from '../cli.js'
import { STAGE_ORDER } from './types.js'
import type { Tier } from './types.js'
import { assertPremiumPreflight, stagesForTier } from './pipeline.js'
import { ResumeError, resumeJob } from './resume.js'

// Real minimal channel TOML (plan-1 shape; [scout] is optional): resumeJob
// loads the channel from disk, so the fixture must round-trip loadChannelConfig.
const CHANNEL_TOML = [
  'name = "resume-test"',
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

describe('jobs/pipeline', () => {
  it('cli.ts re-exports the moved helpers with identical identity', () => {
    // Re-export, not copy: the loop code and the CLI must share ONE wiring.
    expect(cliStages).toBe(stagesForTier)
    expect(cliPreflight).toBe(assertPremiumPreflight)
    // The move is verbatim: the six-stage produce order is unchanged.
    expect(stagesForTier('volume').map((s) => s.name)).toEqual([
      'script',
      'voice',
      'captions',
      'visuals',
      'assemble',
      'qc',
    ])
  })
})

describe('resumeJob', () => {
  let db: Database
  let channelsDir: string
  let runsRoot: string

  beforeEach(() => {
    db = openDb(':memory:')
    channelsDir = mkdtempSync(join(tmpdir(), 'brainrot-channels-'))
    runsRoot = mkdtempSync(join(tmpdir(), 'brainrot-runs-'))
    writeFileSync(join(channelsDir, 'resume-test.toml'), CHANNEL_TOML)
  })

  afterEach(() => {
    db.close()
    rmSync(channelsDir, { recursive: true, force: true })
    rmSync(runsRoot, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  // Mirrors createJob's row shape: one jobs row plus six pending stage rows.
  function seedJob(
    status: string,
    opts: { tier?: Tier; channel?: string; id?: string } = {},
  ): string {
    const id = opts.id ?? `job-${status}`
    db.prepare('INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)').run(
      id,
      opts.channel ?? 'resume-test',
      opts.tier ?? 'volume',
      'why the moon drifts',
      status,
    )
    for (const stage of STAGE_ORDER) {
      db.prepare('INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)').run(
        id,
        stage,
        'pending',
      )
    }
    return id
  }

  it('refuses a missing job', async () => {
    await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'no-such-job', { runsRoot, channelsDir })).rejects.toThrow(
      /no-such-job/,
    )
  })

  it('refuses done and queued jobs', async () => {
    seedJob('done')
    seedJob('queued')
    await expect(resumeJob(db, 'job-done', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-queued', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
  })

  it('refuses a running job without force, naming --force in the message', async () => {
    seedJob('running')
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-running', { runsRoot, channelsDir })).rejects.toThrow(
      /--force/,
    )
  })

  it('refuses when the channel TOML is missing from channelsDir', async () => {
    seedJob('failed', { channel: 'ghost-channel' })
    await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
      ResumeError,
    )
    await expect(resumeJob(db, 'job-failed', { runsRoot, channelsDir })).rejects.toThrow(
      /ghost-channel\.toml/,
    )
  })
})
