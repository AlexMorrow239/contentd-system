import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadChannelsDir } from '../../config/channel.js'
import { openDb } from '../../db/index.js'
import { listTopics } from '../../scout/topics.js'
import { scoutChannel } from '../../scout/scout.js'
import { produceNextTick } from '../../loop/produce-next.js'
import { stubStorageEnv } from '../../testing/storage.js'
import { STAGE_ORDER } from '../types.js'
import type { JobContext, StageDef, StageName } from '../types.js'
import { tmpDir } from '../../testing/tmp.js'
import { emitToolUse, fakeClient } from '../../testing/anthropic.js'
import type { FakeAnthropic } from '../../testing/anthropic.js'
import { arcticShiftJson, fetchStub } from '../../testing/arctic-shift.js'

// Arctic Shift search response: the keyless archive redditSource reads r/space
// through. One post scores above the channel threshold, one below.
const SPACE_SEARCH = arcticShiftJson([
  { id: 'moon', title: 'Moon drifting away measured precisely' },
  { id: 'ad', title: 'Buy my telescope (ad)' },
])

// Serves only r/space's search; any other URL is a test bug, never a
// silent live-network hit.
const fetchImpl = fetchStub({ 'subreddit=space': SPACE_SEARCH })

// The scorer's structuredCompletion consumes a forced 'emit' tool_use.
function scoringClient(): FakeAnthropic {
  return fakeClient(
    emitToolUse(
      {
        scores: [
          {
            candidateIndex: 0,
            score: 85,
            topic: 'The Moon is escaping Earth',
            reason: 'novel physics hook',
          },
          { candidateIndex: 1, score: 10, topic: 'Telescope ad', reason: 'commercial spam' },
        ],
      },
      { input_tokens: 1000, output_tokens: 200 },
    ),
  )
}

// Fake happy-path stages (mirrors buildStages in runner.test.ts). runJob's
// final library gate needs qc/qc.json parseable with a boolean `passed`
// (missing or corrupt -> job 'failed', no library row), script/script.json
// parseable when present (its platformMeta becomes library metadata), and
// assemble/final.mp4 existing for JobResult.videoPath. passed=true ->
// library state 'ready' (library-landed -> the claimed topic flips 'used').
// Deliberately orchestration-scoped (spec §9): the loop invokes the same
// runJob/pipelineStages as `produce`, so the real pipeline stays covered by
// the existing golden-path test rather than re-rendered here.
function fakeStagesFor(calls: StageName[]): () => StageDef[] {
  return () =>
    STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        calls.push(name)
        if (name === 'script') {
          writeFileSync(
            ctx.artifactPath('script', 'script.json'),
            JSON.stringify({
              hook: 'Did you know?',
              segments: [{ text: 'The Moon drifts away.', visualDirection: 'moon' }],
              platformMeta: {
                youtube: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
                tiktok: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
                instagram: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
              },
            }),
          )
        } else if (name === 'assemble') {
          writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
        } else if (name === 'qc') {
          writeFileSync(
            ctx.artifactPath('qc', 'qc.json'),
            JSON.stringify({ passed: true, checks: [] }),
          )
        } else {
          writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
        }
      },
    }))
}

describe('golden-path loop e2e', () => {
  it('scouts a fixture feed into the topic queue, then one tick produces it into the library', async () => {
    const workspace = tmpDir('brainrot-loop-e2e-')
    const channelsDir = path.join(workspace, 'channels')
    const runsRoot = path.join(workspace, 'runs')
    mkdirSync(channelsDir, { recursive: true })
    mkdirSync(runsRoot, { recursive: true })

    // Real channel TOML incl. [scout] and platforms — the same file
    // scoutChannel (loaded via loadChannelsDir here) and produceNextTick
    // both read. bg/bgm dirs are schema-required strings; fake stages never
    // read them.
    writeFileSync(
      path.join(channelsDir, 'example.toml'),
      [
        'name = "example"',
        'niche = ["space facts", "astronomy"]',
        'script_model = "claude-sonnet-5"',
        // top-level keys must precede every [section] header (smol-toml scoping)
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        'videos_per_day = 2',
        'platforms = ["youtube"]',
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
        '[scout]',
        'subreddits = ["space"]',
        '',
      ].join('\n'),
    )

    // Determinism regardless of the developer shell: the default global cap.
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '25')
    // Same reason: the produce tick refuses when object storage is unset, and
    // this e2e injects its own stages rather than reaching a real store.
    stubStorageEnv()

    const db = openDb(path.join(workspace, 'brainrot.db'))
    const channels = loadChannelsDir(channelsDir)
    expect(channels.map((c) => c.name)).toEqual(['example'])

    // ── Scout: fixture feed → one batched scoring call → topic queue ────
    const { client, create } = scoringClient()
    const scout = await scoutChannel(db, channels[0], { client, fetchImpl })
    expect(scout.channel).toBe('example')
    expect(scout.fetched).toBe(2)
    expect(scout.queued).toBe(1)
    expect(scout.rejected).toBe(1)
    expect(scout.sourceErrors).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)

    const candidates = listTopics(db, { channel: 'example', status: 'candidate' })
    expect(candidates).toHaveLength(1)
    const topic = candidates[0]
    // the reframed topic becomes the title; the raw headline is provenance
    expect(topic.title).toBe('The Moon is escaping Earth')
    expect(topic.rawTitle).toBe('Moon drifting away measured precisely')
    expect(topic.source).toBe('reddit:r/space')

    // scout spend ledgered under the sentinel (counts toward the global cap)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM costs WHERE job_id = 'scout:example' AND operation = 'scout-score'",
        )
        .get(),
    ).toEqual({ n: 1 })

    // ── Produce: one tick claims the topic and lands it in the library ──
    const calls: StageName[] = []
    const tick = await produceNextTick(db, {
      channelsDir,
      runsRoot,
      stagesFor: fakeStagesFor(calls),
    })

    // Triage aid: on any non-landed outcome, surface the stage rows
    // instead of a bare field mismatch.
    if (tick.action !== 'produced' || tick.status !== 'ready') {
      const stageRows = tick.jobId
        ? db.prepare('SELECT stage, status, error FROM job_stages WHERE job_id = ?').all(tick.jobId)
        : []
      throw new Error(`loop golden path did not land: ${JSON.stringify({ tick, stageRows })}`)
    }

    expect(tick.topicId).toBe(topic.id)
    expect(tick.jobId).toBeDefined()
    expect(calls).toEqual([...STAGE_ORDER])
    // the produce-next CLI prints this object verbatim as its one JSON line
    expect(JSON.parse(JSON.stringify(tick))).toEqual(tick)

    const job = db
      .prepare('SELECT channel, tier, topic, status FROM jobs WHERE id = ?')
      .get(tick.jobId!) as { channel: string; tier: string; topic: string; status: string }
    expect(job).toEqual({
      channel: 'example',
      tier: 'volume',
      topic: 'The Moon is escaping Earth',
      status: 'done',
    })

    const lib = db.prepare('SELECT state FROM library WHERE job_id = ?').get(tick.jobId!) as
      { state: string } | undefined
    expect(lib?.state).toBe('ready')

    const used = db.prepare('SELECT status, job_id FROM topics WHERE id = ?').get(topic.id) as {
      status: string
      job_id: string
    }
    expect(used).toEqual({ status: 'used', job_id: tick.jobId })

    // the tick's lease was released in its finally
    expect(db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 })

    // ── Second tick: queue drained (the rejected topic is never eligible) ──
    const second = await produceNextTick(db, {
      channelsDir,
      runsRoot,
      stagesFor: fakeStagesFor([]),
    })
    expect(second).toEqual({ action: 'noop', reason: 'no-eligible-work' })

    db.close()
  })
})
