import { execa } from 'execa'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmpDir } from '../../../../../testing/tmp.js'
import { loadChannelConfig } from '../../../../config/channel.js'
import { openDb } from '../../../../infra/db/index.js'
import { probe } from '../../../../infra/media/ffmpeg.js'
import { assembleStage } from '../../stages/assemble.js'
import { captionsStage } from '../../stages/captions.js'
import { qcStage } from '../../stages/qc.js'
import { scriptStage } from '../../stages/script.js'
import { visualsVolumeStage } from '../../stages/visuals-volume.js'
import { voiceStage } from '../../stages/voice.js'
import { createJob, runJob } from '../runner.js'

const REPO_ROOT = process.cwd()

describe('golden-path e2e', () => {
  it('resumes past seeded stages and produces a ready video', async () => {
    const workspace = tmpDir('brainrot-e2e-')
    const bgDir = path.join(workspace, 'bg')
    const runsRoot = path.join(workspace, 'runs')
    mkdirSync(bgDir, { recursive: true })
    mkdirSync(runsRoot, { recursive: true })

    // One 1080x1920 background clip in the library.
    await execa('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=2:size=1080x1920:rate=30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path.join(bgDir, 'bg1.mp4'),
      '-y',
    ])

    // Channel TOML with absolute asset dirs.
    const tomlPath = path.join(workspace, 'channel.toml')
    writeFileSync(
      tomlPath,
      [
        'name = "example"',
        'niche = ["space facts", "astronomy"]',
        'script_model = "claude-sonnet-5"',
        // bg_dir is a top-level key; it must precede every [section]
        // header, else TOML nests them under the last-opened table (e.g. budget).
        `bg_dir = ${JSON.stringify(bgDir)}`,
        'videos_per_day = 2',
        '',
        '[voice]',
        'voice_id = "EXAVITQu4vr4xnSDxMaL"',
        '',
        '[budget]',
        'per_day_usd = 20.0',
        '',
      ].join('\n'),
    )

    const channel = loadChannelConfig(tomlPath)
    const db = openDb(path.join(workspace, 'brainrot.db'))
    const jobId = createJob(db, channel, { topic: 'Space facts about Venus' })

    // Pre-seed script/voice/captions as done.
    for (const stage of ['script', 'voice', 'captions']) {
      db.prepare(
        `INSERT INTO job_stages (job_id, stage, status, finished_at)
         VALUES (?, ?, 'done', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(job_id, stage) DO UPDATE SET status='done'`,
      ).run(jobId, stage)
    }

    // Seed the run dir with real fixtures.
    const runDir = path.join(runsRoot, jobId)
    mkdirSync(path.join(runDir, 'script'), { recursive: true })
    copyFileSync(
      path.join(REPO_ROOT, 'tests-fixtures/golden/script.json'),
      path.join(runDir, 'script', 'script.json'),
    )
    mkdirSync(path.join(runDir, 'voice'), { recursive: true })
    await execa('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      path.join(runDir, 'voice', 'narration.wav'),
      '-y',
    ])
    writeFileSync(
      path.join(runDir, 'voice', 'voice.json'),
      JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 3000 }),
    )
    mkdirSync(path.join(runDir, 'captions'), { recursive: true })
    copyFileSync(
      path.join(REPO_ROOT, 'tests-fixtures/golden/words.json'),
      path.join(runDir, 'captions', 'words.json'),
    )

    const stages = [
      scriptStage,
      voiceStage,
      captionsStage,
      visualsVolumeStage,
      assembleStage,
      qcStage({ minMs: 1000 }),
    ]
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('ready')
    expect(result.videoPath).toBeDefined()
    expect(existsSync(result.videoPath!)).toBe(true)

    // Seeded stages were skipped (not re-run): their status is still 'done'
    // and no network provider was invoked.
    const seeded = db
      .prepare(
        `SELECT stage, status FROM job_stages WHERE job_id = ? AND stage IN ('script','voice','captions')`,
      )
      .all(jobId) as { stage: string; status: string }[]
    expect(seeded.length).toBe(3)
    for (const s of seeded) expect(s.status).toBe('done')

    const p = await probe(result.videoPath!)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.fps).toBeGreaterThanOrEqual(29)
    expect(p.fps).toBeLessThanOrEqual(31)
    expect(p.hasAudio).toBe(true)
    expect(p.durationMs).toBeGreaterThanOrEqual(2800) // ~3s from seeded voice.json
    expect(p.durationMs).toBeLessThanOrEqual(3400)

    const checkpoint = db
      .prepare("SELECT artifact_dir FROM job_stages WHERE job_id = ? AND stage = 'qc'")
      .get(jobId) as { artifact_dir: string }
    expect(checkpoint.artifact_dir).toContain(path.join(runDir, 'attempts'))
    const qc = JSON.parse(readFileSync(path.join(checkpoint.artifact_dir, 'qc.json'), 'utf8')) as {
      passed: boolean
    }
    expect(qc.passed).toBe(true)
  }, 240000)
})
