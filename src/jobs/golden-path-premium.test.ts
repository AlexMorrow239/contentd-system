import { afterAll, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { loadChannelConfig } from '../config/channel.js'
import { openDb } from '../db/index.js'
import { createJob, runJob } from './runner.js'
import { probe } from '../media/ffmpeg.js'
import { scriptStage } from '../stages/script.js'
import { voiceStage } from '../stages/voice.js'
import { captionsStage } from '../stages/captions.js'
import { visualsPremiumStage } from '../stages/visuals-premium.js'
import { assembleStage } from '../stages/assemble.js'
import { qcStage } from '../stages/qc.js'
import type { QcResult } from '../stages/qc.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

// qc's premium vision-spot-check calls visionJudgment (forced 'emit' tool) with
// schema { pass: boolean, issues: string[] }. This client always approves; the
// response shape mirrors fakeClient in src/providers/anthropic.test.ts.
const fakeVisionClient = {
  messages: {
    async create() {
      return {
        content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { pass: true, issues: [] } }],
        usage: { input_tokens: 500, output_tokens: 50 },
      }
    },
  },
} as unknown as Anthropic

describe('golden-path premium e2e', () => {
  it('assembles seeded premium artifacts into a ready multi-clip video (no network)', async () => {
    const workspace = tmp('brainrot-premium-e2e-')
    const bgDir = path.join(workspace, 'bg') // schema-required; premium never reads it
    const bgmDir = path.join(workspace, 'bgm') // empty -> no bgm
    const runsRoot = path.join(workspace, 'runs')
    mkdirSync(bgDir, { recursive: true })
    mkdirSync(bgmDir, { recursive: true })
    mkdirSync(runsRoot, { recursive: true })

    // Plan-1-shaped TOML on purpose: [voice.premium] and [premium] are optional
    // (Task 5 applies defaults) and unused here because every premium-provider
    // stage is pre-seeded as done — this test exercises assemble + qc + runner.
    const tomlPath = path.join(workspace, 'channel.toml')
    writeFileSync(
      tomlPath,
      [
        'name = "example"',
        'niche = ["space facts", "astronomy"]',
        'script_model = "claude-sonnet-5"',
        // top-level keys must precede every [section] header (smol-toml scoping)
        `bg_dir = ${JSON.stringify(bgDir)}`,
        `bgm_dir = ${JSON.stringify(bgmDir)}`,
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
        '',
      ].join('\n'),
    )

    const channel = loadChannelConfig(tomlPath)
    const db = openDb(path.join(workspace, 'brainrot.db'))
    const jobId = createJob(db, channel, { topic: 'Why Venus melts lead', tier: 'premium' })

    // Pre-seed every stage before assemble as done (same pattern as the
    // volume golden path, plus visuals).
    for (const stage of ['script', 'voice', 'captions', 'visuals']) {
      db.prepare(
        `INSERT INTO job_stages (job_id, stage, status, finished_at)
         VALUES (?, ?, 'done', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(job_id, stage) DO UPDATE SET status='done'`,
      ).run(jobId, stage)
    }

    const runDir = path.join(runsRoot, jobId)

    // script: a ScenesOutput artifact exactly as Task 10's stage writes it
    // (format stamp included). 23 narration words total (hook 5 + 9 + 9) ->
    // narration-complete needs voice.durationMs >= 23 * 200ms = 4600ms; 6000ms passes.
    mkdirSync(path.join(runDir, 'script'), { recursive: true })
    writeFileSync(
      path.join(runDir, 'script', 'script.json'),
      JSON.stringify(
        {
          format: 'scenes',
          hook: 'Venus hides a molten secret',
          styleBlock:
            'Painterly sci-fi illustration, warm amber palette, volumetric light, consistent composition across scenes.',
          scenes: [
            {
              narration: 'Its surface glows hot enough to melt solid lead.',
              visualPrompt: 'Glowing volcanic plains of Venus under thick amber clouds',
              motionPrompt: 'slow push-in over the plains',
            },
            {
              narration: 'And a single day there outlasts the entire year.',
              visualPrompt: 'Venus rotating slowly against a dense star field',
              motionPrompt: 'gentle orbital drift',
            },
          ],
          platformMeta: {
            youtube: {
              title: 'Venus: Hotter Than an Oven',
              description: 'Why Venus out-bakes Mercury.',
              hashtags: ['#venus', '#space'],
            },
            tiktok: {
              title: 'Venus is WILD',
              description: 'Hot enough to melt lead.',
              hashtags: ['#venus', '#space'],
            },
            instagram: {
              title: 'Venus Facts',
              description: 'The hottest planet, explained.',
              hashtags: ['#venus', '#space'],
            },
          },
        },
        null,
        2,
      ),
    )

    // voice: 6s sine narration + ElevenLabs-shaped VoiceMeta (premium success).
    mkdirSync(path.join(runDir, 'voice'), { recursive: true })
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      path.join(runDir, 'voice', 'narration.wav'), '-y',
    ])
    writeFileSync(
      path.join(runDir, 'voice', 'voice.json'),
      JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs: 6000 }),
    )

    // captions: the scenes narration tiled evenly across the 6s track.
    const spoken = [
      'Venus', 'hides', 'a', 'molten', 'secret',
      'Its', 'surface', 'glows', 'hot', 'enough', 'to', 'melt', 'solid', 'lead.',
      'And', 'a', 'single', 'day', 'there', 'outlasts', 'the', 'entire', 'year.',
    ]
    const sliceMs = 6000 / spoken.length
    mkdirSync(path.join(runDir, 'captions'), { recursive: true })
    writeFileSync(
      path.join(runDir, 'captions', 'words.json'),
      JSON.stringify({
        words: spoken.map((word, i) => ({
          word,
          startMs: Math.round(i * sliceMs),
          endMs: Math.round((i + 1) * sliceMs),
        })),
      }),
    )

    // visuals: two 5s 1080x1920 clips + keyframes + the Task 13 manifest.
    // Windows [0,3000) and [3000,6000) tile voice.durationMs exactly; each 5s
    // clip covers its 3s window at playbackRate 1 (Task 14 fitClipToWindow trims),
    // and probes inside scene-coverage's sane range [3000,15000].
    const visualsDir = path.join(runDir, 'visuals')
    mkdirSync(visualsDir, { recursive: true })
    for (const nn of ['01', '02']) {
      await execa('ffmpeg', [
        '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=1080x1920:rate=30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        path.join(visualsDir, `scene-${nn}.mp4`), '-y',
      ])
      await execa('ffmpeg', [
        '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=1080x1920:rate=1',
        '-frames:v', '1',
        path.join(visualsDir, `scene-${nn}.png`), '-y',
      ])
    }
    writeFileSync(
      path.join(visualsDir, 'scenes.json'),
      JSON.stringify(
        {
          method: 'aligned',
          scenes: [
            {
              index: 1, startMs: 0, endMs: 3000,
              keyframe: 'scene-01.png', clip: 'scene-01.mp4', clipDurationSec: 5,
              imageAttempts: 1, videoAttempts: 1, costUsdMicros: 405_000,
            },
            {
              index: 2, startMs: 3000, endMs: 6000,
              keyframe: 'scene-02.png', clip: 'scene-02.mp4', clipDurationSec: 5,
              imageAttempts: 1, videoAttempts: 1, costUsdMicros: 405_000,
            },
          ],
        },
        null,
        2,
      ),
    )

    // The premium stage list as the CLI wires it, except qc takes the injected
    // always-pass vision client (the default would construct a real Anthropic
    // client) and a minMs below the 6s fixture.
    const stages = [
      scriptStage,
      voiceStage,
      captionsStage,
      visualsPremiumStage,
      assembleStage,
      qcStage({ minMs: 1000, client: fakeVisionClient }),
    ]
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    // Triage aid: on any non-ready outcome, surface stage rows + qc detail
    // instead of a bare status mismatch.
    if (result.status !== 'ready') {
      const stageRows = db
        .prepare('SELECT stage, status, error FROM job_stages WHERE job_id = ?')
        .all(jobId)
      const qcPath = path.join(runDir, 'qc', 'qc.json')
      const qcRaw = existsSync(qcPath) ? readFileSync(qcPath, 'utf8') : '(no qc.json written)'
      throw new Error(
        `premium golden path not ready: ${JSON.stringify({ result, stageRows })}\nqc.json: ${qcRaw}`,
      )
    }

    expect(result.videoPath).toBeDefined()
    expect(existsSync(result.videoPath!)).toBe(true)

    // Seeded stages were skipped, not re-run: reaching assemble at all proves
    // visualsPremiumStage never ran (no fal/vision provider exists in-process
    // to answer it), and the rows are still 'done'.
    const seeded = db
      .prepare(
        `SELECT stage, status FROM job_stages WHERE job_id = ? AND stage IN ('script','voice','captions','visuals')`,
      )
      .all(jobId) as { stage: string; status: string }[]
    expect(seeded.length).toBe(4)
    for (const s of seeded) expect(s.status).toBe('done')

    const p = await probe(result.videoPath!)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.fps).toBeGreaterThanOrEqual(29)
    expect(p.fps).toBeLessThanOrEqual(31)
    expect(p.hasAudio).toBe(true)
    expect(p.durationMs).toBeGreaterThanOrEqual(5800) // 2 x 3000ms scene windows
    expect(p.durationMs).toBeLessThanOrEqual(6400)

    const qc = JSON.parse(readFileSync(path.join(runDir, 'qc', 'qc.json'), 'utf8')) as QcResult
    const failedChecks = qc.checks.filter((c) => !c.passed)
    expect(failedChecks, JSON.stringify(failedChecks)).toEqual([])
    expect(qc.passed).toBe(true)
    const names = qc.checks.map((c) => c.name)
    expect(names).toContain('scene-coverage')
    expect(names).toContain('vision-spot-check')

    // The fake vision call still went through the paid-call bookkeeping.
    const visionCosts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM costs WHERE job_id = ? AND provider = 'anthropic' AND operation = 'qc-vision'`,
      )
      .get(jobId) as { n: number }
    expect(visionCosts.n).toBe(1)

    const lib = db
      .prepare('SELECT state, video_path FROM library WHERE job_id = ?')
      .get(jobId) as { state: string; video_path: string } | undefined
    expect(lib).toBeDefined()
    expect(lib!.state).toBe('ready')
  }, 240000)
})
