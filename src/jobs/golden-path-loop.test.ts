import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { loadChannelsDir } from '../config/channel.js'
import { openDb } from '../db/index.js'
import { listTopics } from '../scout/topics.js'
import { scoutChannel } from '../scout/scout.js'
import type { FetchLike } from '../scout/sources/types.js'
import { produceNextTick } from '../loop/produce-next.js'
import { publishNextTick } from '../loop/publish-next.js'
import { parseTokenKey } from '../publish/crypto.js'
import { upsertToken } from '../publish/tokens.js'
import { YT_UPLOAD_SCOPE } from '../publish/platforms/youtube.js'
import type { PlatformMeta, PublishAdapter } from '../publish/types.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// Reddit .rss fixture: the public Atom feed redditSource reads keylessly,
// <entry><id> carrying the t3_ fullname. One post scores above the channel
// threshold, one below.
const REDDIT_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>/r/space/.rss</id>
  <title>/r/space</title>
  <entry>
    <id>t3_moon</id>
    <link href="https://www.reddit.com/r/space/comments/t3_moon/" />
    <title>Moon drifting away measured precisely</title>
  </entry>
  <entry>
    <id>t3_ad</id>
    <link href="https://www.reddit.com/r/space/comments/t3_ad/" />
    <title>Buy my telescope (ad)</title>
  </entry>
</feed>`

// Serves only r/space's feed; any other URL is a test bug, never a
// silent live-network hit.
const fetchImpl: FetchLike = async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.includes('/r/space/.rss')) {
    return new Response(REDDIT_FEED, {
      status: 200,
      headers: { 'Content-Type': 'application/atom+xml' },
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

// The scorer's structuredCompletion consumes a forced 'emit' tool_use; the
// response shape mirrors fakeClient in src/providers/anthropic.test.ts.
function scoringClient(): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({
    content: [
      {
        type: 'tool_use',
        name: 'emit',
        id: 't1',
        input: {
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
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200 },
  })
  return { client: { messages: { create } } as unknown as Anthropic, create }
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
    const workspace = tmp('brainrot-loop-e2e-')
    const channelsDir = path.join(workspace, 'channels')
    const runsRoot = path.join(workspace, 'runs')
    mkdirSync(channelsDir, { recursive: true })
    mkdirSync(runsRoot, { recursive: true })

    // Real channel TOML incl. [scout] and [publish] — the same file
    // scoutChannel (loaded via loadChannelsDir here), produceNextTick, and
    // publishNextTick (via opts.channelsDir) all read. bg/bgm dirs are
    // schema-required strings; fake stages never read them. slots =
    // ["00:00"] is deliberately the earliest possible slot: it is <= any
    // local HH:MM, so the due-slot check below needs no assumption about
    // the test runner's timezone.
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
        'min_score = 60',
        '',
        '[publish]',
        'slots = ["00:00"]',
        '',
        '[publish.youtube]',
        '',
      ].join('\n'),
    )

    // Determinism regardless of the developer shell: the default global cap.
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '25')

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

    // ── Publish: the ready video fills the channel's one due slot ───────
    // Client-credential and token-decryption env, read at call time by
    // publishNextTick exactly like every other env-sourced constant in
    // this codebase — never at module load.
    vi.stubEnv('YT_CLIENT_ID', 'test-client-id')
    vi.stubEnv('YT_CLIENT_SECRET', 'test-client-secret')
    vi.stubEnv('BRAINROT_TOKEN_KEY', 'a'.repeat(64))
    const tokenKey = parseTokenKey('a'.repeat(64))

    // slot "00:00" is due at any local wall-clock time, so this fixed
    // `now` makes no assumption about the test runner's timezone.
    const publishNow = () => new Date('2024-01-01T12:00:00Z')

    const uploadCalls: { videoPath: string; meta: PlatformMeta }[] = []
    // A full adapter stub (upload only — credential resolution is bypassed
    // outright) for the 'published' call below, mirroring publish-next.test.ts's
    // own fakeAdapter conversion.
    const fakeAdapter: PublishAdapter = {
      platformId: 'youtube',
      quota: { scope: 'global', envVar: 'BRAINROT_YT_UPLOADS_PER_DAY', cap: () => 6 },
      hasCredential: () => true,
      resolveCredential: async () => 'fake-access-token',
      async upload(req) {
        uploadCalls.push({ videoPath: req.videoPath, meta: req.meta })
        return { postId: 'fakeVideoId1', url: 'https://youtube.com/shorts/fakeVideoId1' }
      },
    }

    // Before any grant is on file, the due slot is blocked on auth — a
    // blocked candidate never claims its slot, so it stays open for the
    // next tick (verified below). No `adapters` override here: this exercises
    // the real ADAPTERS.youtube credential check (client env presence, then a
    // decryptable stored token), which the fakeAdapter above would bypass.
    const noGrant = await publishNextTick(db, { channelsDir, now: publishNow })
    expect(noGrant).toEqual({ action: 'noop', reason: 'no-auth' })
    expect(uploadCalls).toEqual([])

    // Consent flow output (Task 9): an encrypted refresh token on file.
    upsertToken(db, 'youtube', 'example', 'rt-test-token', YT_UPLOAD_SCOPE, tokenKey)

    const published = await publishNextTick(db, {
      channelsDir,
      now: publishNow,
      adapters: { youtube: fakeAdapter },
    })
    expect(published).toEqual({
      action: 'published',
      channel: 'example',
      platform: 'youtube',
      jobId: tick.jobId,
      slot: '00:00',
      postId: 'fakeVideoId1',
      url: 'https://youtube.com/shorts/fakeVideoId1',
    })
    expect(uploadCalls).toEqual([
      {
        videoPath: path.join(runsRoot, tick.jobId!, 'assemble', 'final.mp4'),
        meta: { title: 'Moon', description: 'd', hashtags: ['#moon'] },
      },
    ])

    const libAfterPublish = db
      .prepare('SELECT state FROM library WHERE job_id = ?')
      .get(tick.jobId!) as { state: string }
    expect(libAfterPublish.state).toBe('published')

    const publishRow = db
      .prepare('SELECT status, post_id, url FROM publishes WHERE job_id = ?')
      .get(tick.jobId!) as { status: string; post_id: string; url: string }
    expect(publishRow).toEqual({
      status: 'done',
      post_id: 'fakeVideoId1',
      url: 'https://youtube.com/shorts/fakeVideoId1',
    })

    // publish-next released its own lease too
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
