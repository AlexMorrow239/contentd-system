# Premium Tier + Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm brainrot produce --tier premium` work end-to-end — AI-generated visuals per scene (FLUX keyframe → Claude vision check → Kling image-to-video via fal.ai), ElevenLabs voice with provider word timings, premium QC — and retire the Plan 1 hardening backlog.

**Architecture:** Premium is a flow through the existing pipeline, not a second pipeline: same `STAGE_ORDER`, `JobContext`, artifact conventions, and resume semantics. Tier branching happens inside script/voice/visuals; the runner, DB schema, and budget checkpoint stay tier-agnostic. Two new provider adapters (`fal.ts`, `elevenlabs.ts`) plus a vision-judgment extension to the Anthropic provider; scene time windows are computed deterministically from word timings (captions already run before visuals).

**Tech Stack:** TypeScript ^5.9 (strict ESM, NodeNext), Node ≥22, pnpm, vitest 4, better-sqlite3 v12, zod v4, Remotion 4.0.491, @anthropic-ai/sdk, @fal-ai/client (new), ElevenLabs REST API, kokoro-js, WhisperX sidecar (FastAPI), ffmpeg 8.x, commander.

**Design spec:** `docs/superpowers/specs/2026-07-19-premium-tier-design.md` (parent: `docs/superpowers/specs/2026-07-18-brainrot-machine-design.md`)

## Global Constraints

- TypeScript is pinned `^5.9` — the TS 7 native preview breaks Remotion's esbuild-loader. Do not upgrade.
- Strict ESM, `moduleResolution: NodeNext`; relative imports inside `src/` carry the `.js` suffix.
- `remotion/` has its own tsconfig (Bundler resolution). Files in `src/` must never import from `remotion/`; Remotion components import shared types from `src/remotion-types.ts`. Build gate: `pnpm build` = `tsc --noEmit && tsc -p remotion --noEmit` — both must pass after every task.
- Money is integer micro-USD (`usdMicros`) everywhere; time is integer milliseconds. Never floats in ledgers.
- All DB access goes through `openDb` from `src/db/index.ts`. better-sqlite3 v12 keeps FKs OFF via explicit pragma — do not change.
- Price lookup happens BEFORE any paid API call (unknown model/provider throws at zero spend). Every paid call: `assertBudget` before, `recordCost` after.
- Tests never hit the network except `*.contract.test.ts`, which run only under `CONTRACT=1` (vitest.config.ts ternary — already in place). vitest 4 constructor mocks need `function`/`class`, not arrows.
- The whole existing suite plus `pnpm build` must stay green after every task. The volume tier's behavior must not change.
- Channel TOML: top-level keys must precede the first `[table]` header (smol-toml binds later keys into the open table).
- Secrets via env only (`.env`, dotenv). New env vars this plan: `FAL_KEY`, `ELEVENLABS_API_KEY`, `BRAINROT_GLOBAL_DAILY_USD` (default `25`).
- Only new runtime dependency allowed: `@fal-ai/client`.
- Conventional commits; each task ends with a commit.
- Output invariant: 1080×1920 @ 30fps, H.264 + AAC.

## Interface Contract (binding across tasks)

Types/signatures below are BINDING. Later tasks consume them by exactly these names.

```ts
// src/config/channel.ts (Task 5)
export interface PremiumVoiceConfig { provider: 'elevenlabs'; voiceId: string; modelId: string }
export interface PremiumConfig { imageModel: string; videoModel: string; stylePrefix?: string; sceneConcurrency: number }
export interface ChannelConfig {
  name: string
  niche: string[]
  tierMix: { volume: number; premium: number }
  voice: { volume: string; premium?: PremiumVoiceConfig }
  premium: PremiumConfig            // always present; defaults applied when [premium] absent
  captionStyle: CaptionStyle        // unchanged
  bgDir: string
  bgmDir: string
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
}
// Defaults when absent from TOML: imageModel 'fal-ai/flux/dev', videoModel
// 'fal-ai/kling-video/v3/standard/image-to-video' (Task 8 author verifies the exact
// current fal endpoint ids and records them), sceneConcurrency 3,
// premium_per_video_usd 7.0. [voice.premium] modelId default 'eleven_multilingual_v2'.

// src/jobs/costs.ts (Task 6) — signature change; tier picks the per-video cap
export function assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void
// Enforces, in order: per-video cap (tier premium → premiumPerVideoUsdMicros, else perVideoUsdMicros);
// per-channel daily (SUM(costs JOIN jobs ON costs.job_id = jobs.id) WHERE jobs.channel = ?, today UTC) vs channel.budget.perDayUsdMicros;
// global daily (SUM(costs), today UTC) vs env BRAINROT_GLOBAL_DAILY_USD (default 25) in micros.

// src/providers/anthropic.ts (Task 7)
export async function visionJudgment<T>(opts: {
  model: string; system: string; prompt: string; imagePaths: string[];
  schema: z.ZodType<T>; maxTokens?: number; client?: Anthropic
}): Promise<{ data: T; cost: LlmUsageCost }>
// Same forced-tool 'emit' + PRICE_TABLE-before-call + coerceJsonStrings pattern as structuredCompletion.

// src/providers/fal.ts (Task 8)
export type FalPrice = { kind: 'per-image'; usdMicros: number } | { kind: 'per-second'; usdMicrosPerSecond: number } | { kind: 'per-video'; usdMicros: number }
export const FAL_PRICE_TABLE: Record<string, FalPrice>
export function estimateImageCostMicros(model: string): number          // throws if model unknown
export function estimateVideoCostMicros(model: string, durationSec: number): number  // throws if model unknown
export interface FalClientLike {
  subscribe(model: string, opts: { input: Record<string, unknown> }): Promise<{ data: Record<string, unknown> }>
  storage: { upload(file: Blob): Promise<string> }
}
export async function generateImage(opts: { model: string; prompt: string; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>
export async function animateImage(opts: { model: string; imagePath: string; motionPrompt: string; durationSec: 5 | 10; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>
// 9:16 is hard-coded in the adapter (per-endpoint input naming verified by the author).
// Cost returned = table list price (fal responses carry no billing); ledger at list price.

// src/providers/elevenlabs.ts (Task 9)
export const ELEVENLABS_USD_MICROS_PER_1K_CHARS = 300_000  // $0.30/1k chars (Creator overage); comment why
export function estimateTtsCostMicros(text: string): number
export async function synthWithTimestamps(opts: {
  voiceId: string; modelId: string; text: string; apiKey?: string; fetchImpl?: typeof fetch
}): Promise<{ wavBytes: Buffer; durationMs: number; words: WordTiming[]; costUsdMicros: number }>
// POST /v1/text-to-speech/{voiceId}/with-timestamps?output_format=pcm_24000; groups
// character timings into words (split on whitespace); wraps PCM via existing encodePcmWav.

// src/stages/script.ts (Task 10)
export const ScenesOutputSchema = z.object({
  hook: z.string(),
  styleBlock: z.string(),
  scenes: z.array(z.object({ narration: z.string(), visualPrompt: z.string(), motionPrompt: z.string() })),
  platformMeta: /* same platform schema as ScriptOutputSchema */
})
export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' }
export type ScriptArtifact = ScriptOutput | ScenesOutput
export function isScenesOutput(s: ScriptArtifact): s is ScenesOutput
// The LLM schema has NO format field; the stage stamps { ...data, format: 'scenes' } when
// writing script.json. Volume script.json stays exactly as today (no format field).
// narrationText/narrationWordCount (src/stages/narration-text.ts) accept ScriptArtifact:
// scenes narration = hook + scenes[].narration joined with SINGLE SPACES (binding —
// voice, captions, qc, and scene-windows all depend on this exact composition).

// voice artifacts (Task 11)
export interface VoiceMeta { provider: 'kokoro' | 'edge-tts' | 'elevenlabs'; voiceId: string; durationMs: number }
// Premium ElevenLabs success ALSO writes voice/timings.json: { words: WordTiming[] }
// (identical shape to captions/words.json). Fallback path deletes any stale timings.json.

// captions (Task 11): if voice/timings.json exists with words.length > 0 → copy to
// captions/words.json and skip WhisperX; else existing WhisperX path unchanged.

// src/stages/scene-windows.ts (Task 12)
export interface SceneWindow { startMs: number; endMs: number }
export interface SceneWindowsResult { windows: SceneWindow[]; method: 'aligned' | 'proportional' }
export function computeSceneWindows(script: ScenesOutput, words: WordTiming[], totalDurationMs: number): SceneWindowsResult
// Pure. windows.length === script.scenes.length; windows tile [0, totalDurationMs] exactly
// (window k end === window k+1 start). Scene 1's window starts at 0 (covers the hook).
// Word matching: normalized token walk (lowercase, strip non-alphanumerics), tolerant of
// dropped words; on irrecoverable mismatch fall back to proportional-by-word-count. Never throws.

// visuals manifest (Task 13): runs/<jobId>/visuals/scenes.json
export interface SceneManifestEntry {
  index: number                            // 1-based, matching the scene-NN file names
  startMs: number; endMs: number
  keyframe: string; clip: string           // file names relative to the visuals artifact dir
  clipDurationSec: 5 | 10                  // rule: windowMs <= 5000 ? 5 : 10
  imageAttempts: number; videoAttempts: number; costUsdMicros: number
}
export interface ScenesManifest { method: 'aligned' | 'proportional'; scenes: SceneManifestEntry[] }
export const visualsPremiumStage: StageDef   // name: 'visuals'
export function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]>
// Keyframe loop: up to 3 image attempts, each vision-checked ({ pass: boolean; critique: string }
// schema via visionJudgment, model = channel.scriptModel); fail appends critique to the prompt.
// ESTIMATED_VISION_COST_MICROS = 15_000 is a LOCAL constant in each consuming stage
// (visuals-premium.ts and qc.ts) — it is a pre-flight estimate, not a price-table entry.
// Budget gates pass (estimate + in-flight reservations) to assertBudget — the stage tracks
// un-ledgered estimates in-process so concurrent scenes cannot jointly overshoot a cap
// (single-process scope; the Plan 3 daemon revisits).
// Animate: up to 2 attempts. All scenes settle before failure is raised (max resume progress);
// if any scene error is BudgetExceededError, rethrow that one so the runner parks 'blocked'.
// Resume: a scene whose clip file already exists is skipped (reused).

// src/remotion-types.ts (Task 14)
export type SceneClip = { src: string; durationMs: number; playbackRate: number }
export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc?: string      // volume: single looped background (exactly one of these two is set)
  sceneClips?: SceneClip[]    // premium: sequenced clips
  bgmSrc?: string
  bgmVolume?: number
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
// src/stages/assemble.ts (Task 14)
export function fitClipToWindow(clipMs: number, windowMs: number): { playbackRate: number; durationMs: number }
// windowMs <= clipMs → { 1, windowMs }; else rate = clipMs/windowMs clamped to >= 0.75,
// durationMs = windowMs (a clip exhausted at 0.75 freezes its last frame; QC freeze check bounds it).

// qc (Task 15): qcStage(opts?: { minMs?: number; maxMs?: number; client?: Anthropic }): StageDef
// Premium-only additional checks: 'scene-coverage' (manifest windows tile [0, voice.durationMs]
// within 50ms tolerance; every clip exists and probes sane) and 'vision-spot-check'
// (3 frames at 10%/50%/90% via ffmpeg; visionJudgment vs scene intents; provider error =
// failed check, not a crash; assertBudget + recordCost like any paid call).
```

### Artifact map (premium job)

```
runs/<jobId>/script/script.json      ScenesOutput (format: 'scenes')
runs/<jobId>/voice/narration.wav     WAV
runs/<jobId>/voice/voice.json        VoiceMeta
runs/<jobId>/voice/timings.json      { words: WordTiming[] }   (ElevenLabs success only)
runs/<jobId>/captions/words.json     { words: WordTiming[] }
runs/<jobId>/visuals/scene-NN.png    keyframes (NN = 01-based, zero-padded)
runs/<jobId>/visuals/scene-NN.mp4    clips
runs/<jobId>/visuals/scenes.json     ScenesManifest
runs/<jobId>/assemble/final.mp4      1080×1920@30 H.264+AAC
runs/<jobId>/qc/qc.json              QcResult
```

### File structure

```
Create:  src/providers/fal.ts, fal.test.ts, fal.contract.test.ts
         src/providers/elevenlabs.ts, elevenlabs.test.ts, elevenlabs.contract.test.ts
         src/stages/scene-windows.ts, scene-windows.test.ts
         src/stages/visuals-premium.ts, visuals-premium.test.ts
         src/media/wav.test.ts (if absent)
         src/jobs/golden-path-premium.test.ts
Modify:  src/jobs/runner.ts (+ runner.test.ts)          — Task 1
         src/stages/assemble.ts (+ assemble.test.ts)    — Tasks 2, 14
         sidecar/whisperx/app.py (+ test_app.py)        — Task 3
         src/media/wav.ts, src/stages/voice.ts          — Tasks 4, 11
         src/config/channel.ts (+ test), channels/example.toml, src/stages/_testkit.ts — Task 5
         src/jobs/costs.ts (+ test), src/stages/script.ts — Tasks 6, 10
         src/providers/anthropic.ts (+ test)            — Task 7
         src/stages/captions.ts (+ test)                — Task 11
         src/remotion-types.ts, remotion/ShortVideo.tsx — Task 14
         src/stages/qc.ts (+ test)                      — Task 15
         src/cli.ts (+ test), .env.example, README.md, package.json — Task 16
```

---


---

### Task 1: Runner final-gate hardening + stale stage error clearing

**Files:**
- Create: (none)
- Modify: `src/jobs/runner.ts`
- Test: `src/jobs/runner.test.ts`

**Interfaces:**

Consumes (existing code, all unchanged by this task):

```ts
// src/jobs/runner.ts (existing exports)
export interface JobResult {
  jobId: string
  status: 'ready' | 'needs-review' | 'failed' | 'blocked'
  videoPath?: string
}
export function createJob(db: Database, channel: ChannelConfig, opts: { topic: string; tier: Tier }, _options?: { runsRoot?: string }): string
export async function runJob(db: Database, channel: ChannelConfig, jobId: string, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>

// src/jobs/types.ts
export const STAGE_ORDER: StageName[]   // ['script','voice','captions','visuals','assemble','qc']
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }

// src/jobs/costs.ts
export class BudgetExceededError extends Error

// src/db/index.ts
export function openDb(dbPath: string): Database
```

Produces (behavioral contract — signatures unchanged; later tasks rely on these semantics):

1. `runJob` never resolves (or rejects) leaving `jobs.status = 'running'` after the stage loop. Any error in the post-stages window — corrupt/missing `qc/qc.json`, corrupt `script/script.json`, or a failed library transaction — marks the job `'failed'` with `finished_at` set and resolves `{ jobId, status: 'failed' }` (no `videoPath`, no library row).
2. A stage that succeeds sets `job_stages.error = NULL`, so a resume that recovers a previously failed stage leaves no stale error text behind. (Task 13's per-scene resume and Task 16's golden-path test both re-run jobs and read these rows.)
3. A job failed at the final gate has all six stages `'done'`; re-running `runJob` skips every stage and retries only the final gate — fixing the artifact on disk and re-running heals the job. This is intentional, not a bug.

**Context for the engineer:** the current final gate (`src/jobs/runner.ts`, the block after the stage loop) does a bare `JSON.parse(readFileSync(join(runDir, 'qc', 'qc.json'), 'utf8'))` and a bare `script.json` read. If either artifact is corrupt or missing, the exception escapes `runJob` after the job was already set to `'running'` — the job is stuck `'running'` forever and the CLI crashes instead of printing a JSON result line. Separately, `markStageDone` (`UPDATE job_stages SET status = ?, finished_at = ? ...`) never touches the `error` column, so a stage that failed once and succeeded on resume keeps its old error text.

- [ ] **Step 1: Write the failing final-gate tests**

  Open `src/jobs/runner.test.ts`. All needed imports (`writeFileSync`, `STAGE_ORDER`, `StageDef`, `JobContext`, `createJob`, `runJob`, plus the local `setup`/`testChannel`/`row`/`buildStages` helpers) are already present — no import changes. Insert the following three tests inside `describe('runJob', ...)`, immediately after the last existing test (`'is idempotent even with a pre-seeded library row (crash before job marked done)'`) and before the closing `})` of the describe block:

  ```ts
  it('final gate: corrupt qc.json → job failed in DB (not stuck running), no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'qc') {
          // The stage itself "succeeds" but leaves a corrupt artifact behind.
          writeFileSync(ctx.artifactPath('qc', 'qc.json'), 'not json {{{')
        } else {
          writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
        }
      },
    }))

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    const job = row<{ status: string; finished_at: string | null }>(
      db,
      'SELECT status, finished_at FROM jobs WHERE id = ?',
      jobId,
    )
    expect(job.status).toBe('failed')
    expect(job.finished_at).not.toBeNull()
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('final gate: missing qc.json → job failed in DB, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'qc') return // stage completes but never writes qc.json
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('final gate: corrupt script.json → job failed, not an unhandled throw', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'script') {
          writeFileSync(ctx.artifactPath('script', 'script.json'), '{ truncated')
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

    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result).toEqual({ jobId, status: 'failed' })
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })
  ```

- [ ] **Step 2: Run the runner tests — expect the three new tests to FAIL**

  ```sh
  pnpm vitest run src/jobs/runner.test.ts
  ```

  Expected: 10 pass, 3 fail. Each new test fails because `await runJob(...)` REJECTS instead of resolving `{ jobId, status: 'failed' }`:
  - corrupt qc.json → `SyntaxError: Unexpected token 'o', "not json {{{" is not valid JSON`
  - missing qc.json → `Error: ENOENT: no such file or directory, open '.../qc/qc.json'`
  - corrupt script.json → `SyntaxError: Expected property name or '}' in JSON at position 2 ...`

  (If a failure message differs from these, that's fine — the point is the rejection escaping `runJob`. If any NEW test PASSES here, stop: the premise is wrong, re-read `runner.ts`.)

- [ ] **Step 3: Implement the final-gate try/catch in `src/jobs/runner.ts`**

  In `src/jobs/runner.ts`, replace the entire post-loop block — everything from the line `const qc = JSON.parse(readFileSync(join(runDir, 'qc', 'qc.json'), 'utf8')) as {` down to the closing `}` of the final `return { ... }` at the end of `runJob` — with:

  ```ts
  // Final gate: everything below reads artifacts and finalizes DB state. Any
  // error here (corrupt/missing qc.json or script.json, a failed transaction)
  // must not leave the job stuck 'running': mark it failed and report that.
  try {
    const qc = JSON.parse(readFileSync(join(runDir, 'qc', 'qc.json'), 'utf8')) as {
      passed: boolean
    }
    const state: 'ready' | 'needs-review' = qc.passed ? 'ready' : 'needs-review'

    const videoPath = join(runDir, 'assemble', 'final.mp4')
    const scriptPath = join(runDir, 'script', 'script.json')
    let metadataJson = '{}'
    if (existsSync(scriptPath)) {
      const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as { platformMeta?: unknown }
      metadataJson = JSON.stringify(script.platformMeta ?? {})
    }

    // Idempotent: a resume that reaches this final window again (all stages already
    // 'done') upserts the same library row and re-marks the job done without a
    // PRIMARY KEY conflict. The upsert + job-done update run in one transaction so
    // the two writes commit together.
    const libraryUpsert = db.prepare(
      'INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(job_id) DO UPDATE SET video_path=excluded.video_path, metadata_json=excluded.metadata_json, state=excluded.state',
    )
    const markJobDone = db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?')
    db.transaction(() => {
      libraryUpsert.run(jobId, videoPath, metadataJson, state)
      markJobDone.run('done', nowIso(), jobId)
    })()

    return {
      jobId,
      status: state,
      videoPath: existsSync(videoPath) ? videoPath : undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message }, 'final gate failed')
    db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
      'failed',
      nowIso(),
      jobId,
    )
    return { jobId, status: 'failed' }
  }
  ```

  This closing brace of the `catch` is followed by the closing `}` of `runJob` — the function ends there. No import changes (`existsSync`, `readFileSync`, `join`, `nowIso`, `log` are all already in scope). The stage loop above this block is untouched in this step. Note the two throws ABOVE the stage loop (`invalid job id`, `job not found`) still reject — they fire before the job is marked `'running'`, so the existing path-traversal test (which asserts a rejection) stays green.

- [ ] **Step 4: Run the runner tests — expect all 13 to PASS**

  ```sh
  pnpm vitest run src/jobs/runner.test.ts
  ```

  Expected: `Test Files  1 passed`, `Tests  13 passed`. The pre-existing 10 must all still pass — in particular `'rejects a path-traversal job id...'` (still a rejection) and both idempotency tests (final gate succeeds, `try` branch taken).

- [ ] **Step 5: Write the failing stale-error test**

  Append this test inside the same `describe('runJob', ...)` block, after the three tests from Step 1:

  ```ts
  it('resume after a failed stage clears the stale job_stages.error on success', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })

    // First run: captions blows up and records an error on its stage row.
    const failing: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'captions') throw new Error('boom captions')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const first = await runJob(db, channel, jobId, failing, { runsRoot })
    expect(first.status).toBe('failed')
    expect(
      row<{ error: string | null }>(
        db,
        'SELECT error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'captions',
      ).error,
    ).toBe('boom captions')

    // Resume with healthy stages: captions succeeds this time. Its stage row
    // must come out status='done' with the stale error cleared to NULL.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(second.status).toBe('ready')
    const captions = row<{ status: string; error: string | null }>(
      db,
      'SELECT status, error FROM job_stages WHERE job_id = ? AND stage = ?',
      jobId,
      'captions',
    )
    expect(captions.status).toBe('done')
    expect(captions.error).toBeNull()
  })
  ```

- [ ] **Step 6: Run the runner tests — expect exactly this new test to FAIL**

  ```sh
  pnpm vitest run src/jobs/runner.test.ts
  ```

  Expected: 13 pass, 1 fail. The failure is the final assertion:
  `AssertionError: expected 'boom captions' to be null` — `markStageDone` currently leaves the old error text in place.

- [ ] **Step 7: Clear the error column in `markStageDone`**

  In `src/jobs/runner.ts`, replace:

  ```ts
  const markStageDone = db.prepare(
    'UPDATE job_stages SET status = ?, finished_at = ? WHERE job_id = ? AND stage = ?',
  )
  ```

  with:

  ```ts
  // error = NULL: a stage succeeding on resume must not keep the error text
  // recorded by a previous failed attempt.
  const markStageDone = db.prepare(
    'UPDATE job_stages SET status = ?, finished_at = ?, error = NULL WHERE job_id = ? AND stage = ?',
  )
  ```

  The call site (`markStageDone.run('done', nowIso(), jobId, stage.name)`) is unchanged — `error = NULL` is literal SQL, not a parameter. `markStageFailed` is untouched, so the existing `'middle-stage throw...'` test (which asserts the error text persists on a FAILED stage) stays green.

- [ ] **Step 8: Run the runner tests — expect all 14 to PASS**

  ```sh
  pnpm vitest run src/jobs/runner.test.ts
  ```

  Expected: `Tests  14 passed`.

- [ ] **Step 9: Full suite and build gate**

  ```sh
  pnpm test
  pnpm build
  ```

  Expected: every test file passes — the whole pre-existing suite plus the 4 new runner tests, zero failures (`golden-path.test.ts` does a real Remotion render, so allow it a minute) — and `pnpm build` (`tsc --noEmit && tsc -p remotion --noEmit`) exits 0 with no output.

- [ ] **Step 10: Commit**

  ```sh
  git add src/jobs/runner.ts src/jobs/runner.test.ts
  git commit -m "fix: harden runner final gate and clear stale stage errors on resume"
  ```

---

### Task 2: Remotion bundle robustness (memo poisoning + cwd-dependent entry)

**Files:**
- Modify: `src/stages/assemble.ts`
- Test: `src/stages/assemble.test.ts`

**Interfaces:**
- Consumes (existing code):
  - `src/jobs/types.ts`: `interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }`, `interface JobContext { jobId; db; channel; tier; topic; runDir; artifactPath(stage, file): string; log }`
  - `@remotion/bundler`: `bundle(options: { entryPoint: string }): Promise<string>` — mocked in the new tests via `vi.doMock`
  - `@remotion/renderer`: `selectComposition`, `renderMedia` — mocked in the new tests
  - Local helpers already defined in `src/stages/assemble.test.ts`: `tmp(prefix: string): string`, `makeChannel(bgmDir: string): ChannelConfig`, `makeCtx(runDir: string, channel: ChannelConfig): JobContext`. (This task runs BEFORE Task 5, so `ChannelConfig` is still the Plan-1 shape and `makeChannel` stays as-is; Task 5 owns updating fixtures for the new premium fields.)
- Produces:
  - No exported-API change: `export const assembleStage: StageDef` keeps its exact signature.
  - Two behavioral guarantees that Task 14 (which reworks this file's render path) MUST preserve:
    1. The module-level bundle memo self-heals: a rejected `bundle()` promise clears the memo so the next call retries (the original caller still observes the rejection).
    2. The Remotion entry point is `fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))` (module-relative), never `path.resolve('remotion/index.ts')` (cwd-relative).
  - Test seams Task 14 can reuse: `seedRenderInputs(ctx)` and `mockRenderer()` helpers plus the `vi.doMock` + `vi.resetModules()` + dynamic-import pattern in `assemble.test.ts` for fast (non-rendering) assertions on props passed to `bundle`/`renderMedia`.

Background: `src/stages/assemble.ts:9-15` memoizes `bundle({ entryPoint: path.resolve('remotion/index.ts') })` in a module-level `bundlePromise`. Two defects: (a) a rejected promise is memoized forever, so one transient bundling failure (e.g. esbuild OOM) poisons every later job in the process; (b) `path.resolve('remotion/index.ts')` resolves against `process.cwd()`, so invoking the CLI from any directory other than the repo root bundles a nonexistent entry. Both fixes are internal to `getBundle()`; the volume render path is otherwise untouched (the existing real-render test in this file must stay green, unmodified).

Note on test mechanics: the bundle memo is module-level state, so each new test needs a FRESH copy of `assemble.ts` with its remotion deps mocked. `vi.mock` is hoisted file-wide and would poison the existing real-render test in the same file — use `vi.doMock` (not hoisted, applies to subsequent dynamic imports only) + `vi.resetModules()` + `await import('./assemble.js')` instead. The static `import { assembleStage }` at the top of the file resolved the REAL modules before any `doMock`, so the real-render test is unaffected. Vitest runs with the default `forks` pool (no `pool` override in `vitest.config.ts`), so `process.chdir` is available in workers.

- [ ] **Step 1: Write the failing memo-poisoning test.** In `src/stages/assemble.test.ts`, replace the import block (lines 1-11) with:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { openDb } from '../db/index.js'
import { probe } from '../media/ffmpeg.js'
import { assembleStage } from './assemble.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext } from '../jobs/types.js'
```

(Only two changes: `afterEach` and `vi` added to the vitest import; new `fileURLToPath` import.) Then append at the very end of the file:

```ts
// ── Bundle robustness (mocked @remotion/bundler + @remotion/renderer) ────────
// The bundle memo is module-level state, so each test dynamically imports a
// FRESH assemble.ts with its remotion deps mocked: vi.doMock (not hoisted) +
// vi.resetModules(). The static `assembleStage` import at the top of this file
// already bound the REAL modules, so the render test above is unaffected.

function seedRenderInputs(ctx: JobContext): void {
  // bundle/render are mocked below: file CONTENTS are never decoded, so junk
  // bytes stand in for real media. Only the stage's fs reads/copies must work.
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 }),
  )
  writeFileSync(
    ctx.artifactPath('captions', 'words.json'),
    JSON.stringify({ words: [{ word: 'hello', startMs: 0, endMs: 400 }] }),
  )
  writeFileSync(ctx.artifactPath('visuals', 'background.mp4'), 'junk-video-bytes')
  writeFileSync(ctx.artifactPath('voice', 'narration.wav'), 'junk-wav-bytes')
}

function mockRenderer(): void {
  vi.doMock('@remotion/renderer', () => ({
    selectComposition: vi.fn().mockResolvedValue({
      id: 'ShortVideo',
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 30,
    }),
    renderMedia: vi.fn().mockResolvedValue(undefined),
  }))
}

describe('assembleStage bundle robustness', () => {
  afterEach(() => {
    vi.doUnmock('@remotion/bundler')
    vi.doUnmock('@remotion/renderer')
    vi.resetModules()
  })

  it('retries bundle() after a rejection instead of memoizing the failure', async () => {
    const serveUrl = tmp('brainrot-serveurl-')
    const bundleMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('esbuild exploded'))
      .mockResolvedValue(serveUrl)
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = makeCtx(tmp('brainrot-run-'), makeChannel(tmp('brainrot-bgm-')))
    seedRenderInputs(ctx)

    await expect(freshStage.run(ctx)).rejects.toThrow('esbuild exploded')
    // A poisoned memo replays the same rejection here without ever calling
    // bundle() again; the fix must clear the memo so this run re-bundles.
    await expect(freshStage.run(ctx)).resolves.toBeUndefined()
    expect(bundleMock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t 'retries bundle'
```

Expected: 1 failed (the 180s real-render test is filtered out as skipped by `-t`). Failure is on the second run's assertion, roughly:

```
AssertionError: promise rejected "Error: esbuild exploded" instead of resolving
```

because the current code memoizes the rejected promise and never calls `bundle()` a second time.

- [ ] **Step 3: Minimal fix — self-healing memo.** In `src/stages/assemble.ts`, replace lines 9-15:

```ts
let bundlePromise: Promise<string> | undefined
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({ entryPoint: path.resolve('remotion/index.ts') })
  }
  return bundlePromise
}
```

with:

```ts
let bundlePromise: Promise<string> | undefined
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    const inFlight = bundle({ entryPoint: path.resolve('remotion/index.ts') })
    // A rejected bundle() must not poison the memo for the process lifetime:
    // clear it so the next caller retries. Callers still observe the original
    // rejection through the returned promise — this .catch only manages the
    // memo (and marks the rejection handled on this side branch). The identity
    // guard keeps a newer in-flight bundle from being wiped by an older failure.
    inFlight.catch(() => {
      if (bundlePromise === inFlight) bundlePromise = undefined
    })
    bundlePromise = inFlight
  }
  return bundlePromise
}
```

- [ ] **Step 4: Run it — expect PASS.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t 'retries bundle'
```

Expected: 1 passed (fast — nothing real is bundled or rendered).

- [ ] **Step 5: Write the failing cwd-independence test.** In `src/stages/assemble.test.ts`, inside the `assembleStage bundle robustness` describe block, append after the first `it(...)`:

```ts
  it('passes a cwd-independent entry point to bundle()', async () => {
    const bundleMock = vi.fn().mockResolvedValue(tmp('brainrot-serveurl-'))
    vi.doMock('@remotion/bundler', () => ({ bundle: bundleMock }))
    mockRenderer()
    vi.resetModules()
    const { assembleStage: freshStage } = await import('./assemble.js')

    const ctx = makeCtx(tmp('brainrot-run-'), makeChannel(tmp('brainrot-bgm-')))
    seedRenderInputs(ctx)

    // Simulate the CLI being launched from anywhere but the repo root.
    const repoCwd = process.cwd()
    process.chdir(tmp('brainrot-elsewhere-'))
    try {
      await freshStage.run(ctx)
    } finally {
      process.chdir(repoCwd)
    }

    // This test file sits next to assemble.ts, so the same relative hop yields
    // the exact path the module must resolve regardless of process.cwd().
    const expectedEntry = fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))
    expect(existsSync(expectedEntry)).toBe(true) // guards the ../.. depth itself
    expect(bundleMock).toHaveBeenCalledWith({ entryPoint: expectedEntry })
  })
```

- [ ] **Step 6: Run it — expect FAIL.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t 'cwd-independent'
```

Expected: 1 failed on the final assertion — `path.resolve('remotion/index.ts')` resolved against the temp cwd, so the received call is `{ entryPoint: '/…/brainrot-elsewhere-XXXX/remotion/index.ts' }` while the expected argument is `{ entryPoint: '/…/project-brainrot/remotion/index.ts' }`:

```
AssertionError: expected "spy" to be called with arguments: [ { entryPoint: '…/remotion/index.ts' } ]
```

- [ ] **Step 7: Minimal fix — module-relative entry point.** In `src/stages/assemble.ts`: add one import and a module constant, and use it in `getBundle`. After the edit, the top of the file (through `getBundle`) reads exactly:

```ts
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { WordTiming } from '../providers/whisperx.js'
import type { ShortVideoProps } from '../remotion-types.js'

// Resolved relative to THIS module, not process.cwd(): the CLI may be invoked
// from any directory (pnpm -C, cron, a wrapper script), and a cwd-relative
// path.resolve('remotion/index.ts') would point bundling at a nonexistent tree.
const REMOTION_ENTRY = fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))

let bundlePromise: Promise<string> | undefined
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    const inFlight = bundle({ entryPoint: REMOTION_ENTRY })
    // A rejected bundle() must not poison the memo for the process lifetime:
    // clear it so the next caller retries. Callers still observe the original
    // rejection through the returned promise — this .catch only manages the
    // memo (and marks the rejection handled on this side branch). The identity
    // guard keeps a newer in-flight bundle from being wiped by an older failure.
    inFlight.catch(() => {
      if (bundlePromise === inFlight) bundlePromise = undefined
    })
    bundlePromise = inFlight
  }
  return bundlePromise
}
```

`path` stays imported — it is still used for `path.join` in the stage body below. Everything from `export const assembleStage` down is unchanged in this task.

- [ ] **Step 8: Run the whole robustness block — expect PASS.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t 'bundle robustness'
```

Expected: 2 passed, real-render test skipped by the filter.

- [ ] **Step 9: Full gates.**

```bash
pnpm test
pnpm build
```

Expected: every suite green, including the unmodified real-render `assembleStage` test (this one takes ~3 min: real bundle + render) and `remotion/remotion.test.ts` (which calls `bundle` directly with its own cwd-relative path from the repo root — unaffected by this change). `pnpm build` = `tsc --noEmit && tsc -p remotion --noEmit`, both clean.

- [ ] **Step 10: Commit.**

```bash
git add src/stages/assemble.ts src/stages/assemble.test.ts
git commit -m "fix: retry remotion bundle after failure and resolve entry point cwd-independently"
```

---

### Task 3: Sidecar streaming upload + size cap

**Files:**
- Modify: `sidecar/whisperx/app.py`
- Test: `sidecar/whisperx/test_app.py`

**Interfaces:**
- Consumes: FastAPI/Starlette `UploadFile.read(size: int) -> bytes` (incremental multipart reads; returns `b""` at EOF); env `WHISPERX_MAX_UPLOAD_MB` (new, sidecar-local; default `64`), read once at module import — same convention as the existing `WHISPERX_DEVICE`; the existing test seam in `sidecar/whisperx/test_app.py` (`monkeypatch.setattr(app_module.whisperx, ...)` fakes + `fastapi.testclient.TestClient(app_module.app)` — whisperx is never really invoked in unit tests).
- Produces: `POST /align` gains a `413` response — `{"detail": "audio upload exceeds <MAX_UPLOAD_BYTES> byte limit"}` — when the multipart `audio` body exceeds the cap; the `200` contract is unchanged (`{"words": [{"word", "start", "end"}]}`, seconds as floats). Module constants `CHUNK_SIZE` (1 MiB) and `MAX_UPLOAD_BYTES` in `sidecar/whisperx/app.py` (monkeypatch seams for tests). No TS-side change: `alignTranscript` (`src/providers/whisperx.ts` lines 36–39) already turns any non-200 into `Error("alignTranscript: whisperx responded 413: <body>")`, so an oversized upload surfaces as a captions-stage failure with the sidecar's detail string. No later task consumes anything new from this task.

**Steps:**

- [ ] **Step 1: Write the failing tests.** Append three tests to `sidecar/whisperx/test_app.py`. The file becomes exactly (the first two tests are the existing ones, byte-identical — do not touch them):

```python
import io
import wave

import numpy as np
from fastapi.testclient import TestClient

import app as app_module


def _wav_bytes(seconds=1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * rate * seconds)
    return buf.getvalue()


def test_align_returns_word_timings(monkeypatch):
    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: (object(), {"language": "en"}),
    )
    monkeypatch.setattr(
        app_module.whisperx, "load_audio",
        lambda p: np.zeros(16000, dtype=np.float32),
    )
    monkeypatch.setattr(
        app_module.whisperx, "align",
        lambda *a, **k: {
            "word_segments": [
                {"word": "hello", "start": 0.10, "end": 0.42, "score": 0.9},
                {"word": "world", "start": 0.55, "end": 0.90, "score": 0.9},
                {"word": "??", "score": 0.0},  # unalignable -> dropped
            ]
        },
    )
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", _wav_bytes(), "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "words": [
            {"word": "hello", "start": 0.10, "end": 0.42},
            {"word": "world", "start": 0.55, "end": 0.90},
        ]
    }


def test_align_missing_transcript_is_422():
    client = TestClient(app_module.app)
    resp = client.post("/align", files={"audio": ("n.wav", _wav_bytes(), "audio/wav")})
    assert resp.status_code == 422


def test_default_upload_cap_is_64_mib():
    # Cap is read from WHISPERX_MAX_UPLOAD_MB at import time; the test env does
    # not set it, so the module must expose the 64 MiB default.
    assert app_module.MAX_UPLOAD_BYTES == 64 * 1024 * 1024


def test_oversized_upload_is_413_before_alignment(monkeypatch):
    calls = []
    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: calls.append("load_align_model"),
    )
    monkeypatch.setattr(
        app_module.whisperx, "load_audio", lambda p: calls.append("load_audio")
    )
    monkeypatch.setattr(
        app_module.whisperx, "align", lambda *a, **k: calls.append("align")
    )
    monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 1000)  # 1s wav is ~32 KiB
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", _wav_bytes(), "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 413
    assert "exceeds" in resp.json()["detail"]
    assert calls == []  # rejected before any whisperx work ran


def test_chunked_write_preserves_bytes(monkeypatch):
    wav = _wav_bytes()
    seen = {}

    def fake_load_audio(path):
        with open(path, "rb") as f:
            seen["bytes"] = f.read()
        return np.zeros(16000, dtype=np.float32)

    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: (object(), {"language": "en"}),
    )
    monkeypatch.setattr(app_module.whisperx, "load_audio", fake_load_audio)
    monkeypatch.setattr(
        app_module.whisperx, "align", lambda *a, **k: {"word_segments": []}
    )
    monkeypatch.setattr(app_module, "CHUNK_SIZE", 1024)  # force ~32 read iterations
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", wav, "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"words": []}
    assert seen["bytes"] == wav  # chunk-reassembled temp file is byte-identical
```

What each new test pins down: `test_default_upload_cap_is_64_mib` — the env default (64 MiB in bytes). `test_oversized_upload_is_413_before_alignment` — the cap fires with 413 and no whisperx function (`load_audio`, `load_align_model`, `align`) is ever invoked; the cap is monkeypatched down to 1000 bytes so a 1-second (~32 KiB) fixture wav trips it without a giant upload. `test_chunked_write_preserves_bytes` — with `CHUNK_SIZE` forced to 1 KiB the loop runs ~32 iterations and the temp file handed to `whisperx.load_audio` is byte-identical to the uploaded wav (proves the streaming rewrite loses nothing). Note the handler must reference `CHUNK_SIZE`/`MAX_UPLOAD_BYTES` as module globals (plain names, looked up at call time) — that is what makes `monkeypatch.setattr(app_module, ...)` effective.

- [ ] **Step 2: Run the sidecar tests, expect the three new ones to fail.**

```bash
cd sidecar/whisperx && .venv/bin/python -m pytest -q
```

Expected: `3 failed, 2 passed`. The failures are all attribute errors because the constants do not exist yet:
- `test_default_upload_cap_is_64_mib` → `AttributeError: module 'app' has no attribute 'MAX_UPLOAD_BYTES'`
- `test_oversized_upload_is_413_before_alignment` → `AttributeError: <module 'app' ...> has no attribute 'MAX_UPLOAD_BYTES'` (raised by `monkeypatch.setattr`)
- `test_chunked_write_preserves_bytes` → `AttributeError: <module 'app' ...> has no attribute 'CHUNK_SIZE'` (raised by `monkeypatch.setattr`)

(The venv was created in Plan 1 Task 8 and already contains pytest, fastapi, httpx, and whisperx. If it is missing, recreate it: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest httpx`.)

- [ ] **Step 3: Implement the chunked upload loop with the cap.** `sidecar/whisperx/app.py` becomes exactly (the only changes: the two new constants with their comment block, and the `align` handler's temp-file section — everything from `duration = ...` down is untouched):

```python
import os
import tempfile

import whisperx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

app = FastAPI()

DEVICE = os.environ.get("WHISPERX_DEVICE", "cpu")
SAMPLE_RATE = 16000  # whisperx.load_audio always resamples to 16 kHz

# Uploads are streamed to the temp file in CHUNK_SIZE reads and rejected with
# 413 the moment the running total exceeds MAX_UPLOAD_BYTES — the request body
# is never held in a single bytes object. The cap is env-configurable
# (WHISPERX_MAX_UPLOAD_MB, default 64, read once at import like DEVICE). Both
# are module-level globals so tests can monkeypatch them.
CHUNK_SIZE = 1024 * 1024  # 1 MiB
MAX_UPLOAD_BYTES = int(os.environ.get("WHISPERX_MAX_UPLOAD_MB", "64")) * 1024 * 1024

# Alignment model is loaded once and cached at module level. Lazy so importing
# this module (e.g. in tests) does not trigger a model download.
_align = {"model": None, "metadata": None}


def get_align_model():
    if _align["model"] is None:
        model, metadata = whisperx.load_align_model(language_code="en", device=DEVICE)
        _align["model"] = model
        _align["metadata"] = metadata
    return _align["model"], _align["metadata"]


@app.post("/align")
async def align(audio: UploadFile = File(...), transcript: str = Form(...)):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        received = 0
        while True:
            chunk = await audio.read(CHUNK_SIZE)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"audio upload exceeds {MAX_UPLOAD_BYTES} byte limit",
                )
            tmp.write(chunk)
        tmp.flush()
        audio_array = whisperx.load_audio(tmp.name)

    duration = len(audio_array) / SAMPLE_RATE
    # Alignment-only: one segment spanning the whole clip carries the plain
    # transcript; whisperx places each word within it.
    segments = [{"start": 0.0, "end": float(duration), "text": transcript}]
    model, metadata = get_align_model()
    try:
        result = whisperx.align(
            segments, model, metadata, audio_array, DEVICE, return_char_alignments=False
        )
    except Exception as exc:  # alignment failure -> 500 with detail
        raise HTTPException(status_code=500, detail=f"alignment failed: {exc}")

    words = [
        {"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
        for w in result.get("word_segments", [])
        if w.get("start") is not None and w.get("end") is not None
    ]
    return {"words": words}
```

Notes for the implementer:
- The over-cap check runs before `tmp.write(chunk)`, so nothing beyond the cap ever lands on disk; the `HTTPException` propagates out of the `with` block, which deletes the temp file.
- `raise HTTPException(413, ...)` inside the handler is the standard FastAPI path — TestClient sees status 413 with `{"detail": ...}`.
- An empty upload writes zero chunks and proceeds exactly as the old `data = b""` path did — behavior unchanged.

- [ ] **Step 4: Run the sidecar tests, expect pass.**

```bash
cd sidecar/whisperx && .venv/bin/python -m pytest -q
```

Expected: `5 passed` (plus third-party DeprecationWarnings — pre-existing Python-3.14-vs-pinned-fastapi noise documented in Plan 1, not ours to fix; the count grows with the number of requests the suite makes).

- [ ] **Step 5: Full-repo gates.** From the repo root:

```bash
pnpm test && pnpm build
```

Expected: the entire vitest suite passes (this task touches no TypeScript, so the count is whatever the previous task left green) and both tsc project checks pass. This proves nothing on the Node side regressed.

- [ ] **Step 6: Commit.**

```bash
git add sidecar/whisperx/app.py sidecar/whisperx/test_app.py
git commit -m "fix: stream sidecar upload in 1MiB chunks, 413 over WHISPERX_MAX_UPLOAD_MB cap"
```

- [ ] **Step 7 (follow-up, NOT blocking): rebuild the sidecar container.** The Docker image copies `app.py` at build time, so the running container keeps the old handler until rebuilt:

```bash
docker compose build whisperx
```

Verification of the Python change itself already ran via pytest locally (Steps 2/4), so do not block on this step — run it whenever Docker is next available, and before the next containerized `produce` run that should enforce the cap. No `docker-compose.yml` change is needed: the 64 MiB default applies; an operator wanting a different cap adds `WHISPERX_MAX_UPLOAD_MB` under the service's existing `environment:` block.

---

### Task 4: Kokoro trailing-silence trim (timing-tail fix)

**Background (why this exists):** Plan 1's real tail run produced a 15375ms `narration.wav` whose aligned words end at ~10490ms. Kokoro pads every generated chunk with multi-second trailing silence, so `synthChunked`'s PCM concatenation embeds a silent gap after every chunk plus a long dead tail after the last one — captions end while the video keeps playing. The fix is a pure PCM primitive in `src/media/wav.ts` that trims each chunk's trailing silence down to a short keep-window, applied per-chunk inside `synthChunked` so both the internal gaps and the final tail are capped.

**Files:**
- Create: `src/media/wav.test.ts`
- Modify: `src/media/wav.ts`, `src/stages/voice.ts`, `src/stages/voice.test.ts`
- Test: `src/media/wav.test.ts`, `src/stages/voice.test.ts`

**Interfaces:**

Consumes (all already exist on main; read them before editing):

```ts
// src/media/wav.ts (existing exports; unchanged by this task)
export function encodePcmWav(parts: Buffer[], sampleRate: number, channels: number): Buffer
export function pcmFromFloat32(samples: Float32Array): Buffer
export function parseWav(buf: Buffer): ParsedWav
export function parseWavDurationMs(buf: Buffer): number

// src/stages/narration-text.ts (existing)
export function countWords(text: string): number

// src/stages/voice.ts (existing; the private synthChunked helper is the modify point)
export const voiceStage: StageDef            // name: 'voice'
export const MAX_CHUNK_WORDS = 60
export function splitForTts(text: string): string[]

// src/stages/_testkit.ts (existing test helpers)
export function testScript(opts?: { hook?: string; segments?: string[] }): ScriptOutput
export function makeCtx(channel?: ChannelConfig, topic?: string): JobContext
```

Produces (later tasks rely on this exact signature — Task 9's ElevenLabs adapter and Task 11's voice-stage rework keep the kokoro/edge fallback chain, which flows through the trimmed `synthChunked` path unchanged):

```ts
// src/media/wav.ts
export function trimTrailingSilence(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  opts?: { thresholdAmp?: number; keepMs?: number },
): Buffer
// Scans 16-bit LE PCM from the end for the last sample whose |amplitude| exceeds
// thresholdAmp (default 330 ≈ -40 dBFS on int16); returns the buffer cut keepMs
// (default 250ms) beyond that sample, on a frame boundary (channels × 2 bytes).
// An all-silent buffer is returned INTACT (never trims a chunk to zero bytes).
```

Behavioral guarantee produced: every chunk synthesized by the kokoro and edge-tts paths carries at most ~250ms of trailing silence, so `voice.json.durationMs` tracks spoken content and the caption timeline reaches the end of the audio.

- [ ] **Step 1: Write the failing unit tests for `trimTrailingSilence` (create `src/media/wav.test.ts`)**

  This file does not exist yet. Create it with exactly:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { encodePcmWav, parseWavDurationMs, pcmFromFloat32, trimTrailingSilence } from './wav.js';

  const RATE = 24000; // kokoro's native sample rate

  // Mono 16-bit PCM buffer from int16 sample values (small hand-built fixtures).
  function pcm16(values: number[]): Buffer {
    const buf = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return buf;
  }

  // `loudMs` of a 440Hz sine at 0.5 amplitude followed by `silentMs` of zeros.
  function sineThenSilence(loudMs: number, silentMs: number): Buffer {
    const loud = Math.round((loudMs / 1000) * RATE);
    const silent = Math.round((silentMs / 1000) * RATE);
    const samples = new Float32Array(loud + silent);
    for (let i = 0; i < loud; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    return pcmFromFloat32(samples);
  }

  describe('trimTrailingSilence', () => {
    it('cuts a long silent tail down to keepMs past the last loud sample', () => {
      const pcm = sineThenSilence(1000, 3000); // 4s total, audible content ends at 1s
      const trimmed = trimTrailingSilence(pcm, RATE, 1);
      const frames = trimmed.length / 2;
      // The last above-threshold sine sample sits within one 440Hz cycle
      // (~55 samples) of the 1s mark; default keepMs=250 leaves 6000 more frames.
      const expectedMax = Math.round(1.25 * RATE);
      expect(frames).toBeLessThanOrEqual(expectedMax);
      expect(frames).toBeGreaterThanOrEqual(expectedMax - 60);
      // Re-encoded, the chunk reads back as ~1250ms instead of 4000ms.
      const roundTripMs = parseWavDurationMs(encodePcmWav([trimmed], RATE, 1));
      expect(roundTripMs).toBeGreaterThanOrEqual(1245);
      expect(roundTripMs).toBeLessThanOrEqual(1250);
    });

    it('returns an all-silence buffer intact (never trims a chunk to zero)', () => {
      const pcm = pcm16(new Array(500).fill(0));
      const trimmed = trimTrailingSilence(pcm, RATE, 1);
      expect(trimmed.equals(pcm)).toBe(true);
      expect(trimmed.length).toBe(1000);
    });

    it('treats sub-threshold hiss as silence, but keeps it under a lower threshold', () => {
      // rate 100 keeps fixtures tiny: default keepMs 250 -> 25 frames kept.
      const rate = 100;
      const values = [...new Array<number>(10).fill(5000), ...new Array<number>(100).fill(200)];
      // 200 < default threshold 330 -> the hiss is silence; cut to 10 loud + 25 kept.
      expect(trimTrailingSilence(pcm16(values), rate, 1).length / 2).toBe(35);
      // thresholdAmp 100 -> the hiss counts as signal; nothing follows it to trim.
      expect(trimTrailingSilence(pcm16(values), rate, 1, { thresholdAmp: 100 }).length / 2).toBe(110);
    });

    it('honours a custom keepMs', () => {
      const rate = 100;
      const values = [...new Array<number>(10).fill(5000), ...new Array<number>(100).fill(0)];
      expect(trimTrailingSilence(pcm16(values), rate, 1, { keepMs: 500 }).length / 2).toBe(60);
    });

    it('never cuts past the end when the tail is shorter than keepMs', () => {
      const rate = 100;
      // 50ms of tail < 250ms keep window: buffer comes back whole.
      const values = [...new Array<number>(10).fill(5000), ...new Array<number>(5).fill(0)];
      expect(trimTrailingSilence(pcm16(values), rate, 1).length / 2).toBe(15);
    });

    it('respects stereo interleaving: any-channel loudness, frame-aligned cut', () => {
      const rate = 100;
      // 10 frames where only the RIGHT channel is loud, then 100 silent frames.
      const interleaved: number[] = [];
      for (let i = 0; i < 10; i++) interleaved.push(0, 5000);
      for (let i = 0; i < 100; i++) interleaved.push(0, 0);
      const trimmed = trimTrailingSilence(pcm16(interleaved), rate, 2);
      expect(trimmed.length % 4).toBe(0); // whole L/R frames only
      expect(trimmed.length / 4).toBe(35); // 10 loud + 25 kept frames
      // Loud right-channel samples survive at their interleaved positions.
      expect(trimmed.readInt16LE(0)).toBe(0);
      expect(trimmed.readInt16LE(2)).toBe(5000);
    });
  });
  ```

- [ ] **Step 2: Run the new test file — expect FAIL**

  ```bash
  pnpm vitest run src/media/wav.test.ts
  ```

  Expected: the whole file fails to load with
  `SyntaxError: The requested module './wav.js' does not provide an export named 'trimTrailingSilence'`.
  (All 6 tests reported as failed/unrun for that one reason.)

- [ ] **Step 3: Implement `trimTrailingSilence` in `src/media/wav.ts`**

  Append this at the end of `src/media/wav.ts` (after `parseWavDurationMs`). No other lines in the file change; the function reuses the module-level `BYTES_PER_SAMPLE = 2` constant already defined at the top:

  ```ts
  // Kokoro pads every generated chunk with multi-second trailing silence, so
  // naive chunk concatenation embeds internal dead air and a long silent tail
  // that desynchronizes captions from video (Plan 1 real tail run: 15375ms
  // narration whose aligned words end at ~10490ms). 330/32767 ≈ -40 dBFS — quiet
  // enough that no speech tail is clipped, loud enough to see past codec dither.
  const DEFAULT_TRIM_THRESHOLD_AMP = 330;
  const DEFAULT_TRIM_KEEP_MS = 250;

  /**
   * Cut trailing silence from a 16-bit LE PCM payload: find the last sample in
   * any channel whose |amplitude| exceeds `thresholdAmp`, keep `keepMs` of tail
   * beyond it, and cut on a frame boundary. An all-silent payload is returned
   * intact — trimming a chunk to zero would silently drop it from the narration.
   */
  export function trimTrailingSilence(
    pcm: Buffer,
    sampleRate: number,
    channels: number,
    opts: { thresholdAmp?: number; keepMs?: number } = {},
  ): Buffer {
    const thresholdAmp = opts.thresholdAmp ?? DEFAULT_TRIM_THRESHOLD_AMP;
    const keepMs = opts.keepMs ?? DEFAULT_TRIM_KEEP_MS;
    const bytesPerFrame = channels * BYTES_PER_SAMPLE;
    const frameCount = Math.floor(pcm.length / bytesPerFrame);

    // Last frame in which any channel exceeds the threshold; -1 when all-silent.
    let lastLoudFrame = -1;
    outer: for (let frame = frameCount - 1; frame >= 0; frame--) {
      const base = frame * bytesPerFrame;
      for (let ch = 0; ch < channels; ch++) {
        if (Math.abs(pcm.readInt16LE(base + ch * BYTES_PER_SAMPLE)) > thresholdAmp) {
          lastLoudFrame = frame;
          break outer;
        }
      }
    }
    if (lastLoudFrame === -1) return pcm;

    const keepFrames = Math.round((keepMs / 1000) * sampleRate);
    const endFrame = Math.min(frameCount, lastLoudFrame + 1 + keepFrames);
    return pcm.subarray(0, endFrame * bytesPerFrame);
  }
  ```

- [ ] **Step 4: Run the wav tests again — expect PASS**

  ```bash
  pnpm vitest run src/media/wav.test.ts
  ```

  Expected: `Test Files 1 passed`, `Tests 6 passed`.

- [ ] **Step 5: Full suite + build green, then commit the primitive**

  ```bash
  pnpm test && pnpm build
  ```

  Expected: every test file passes (nothing else imports the new export yet) and both `tsc --noEmit` runs are clean.

  ```bash
  git add src/media/wav.ts src/media/wav.test.ts
  git commit -m "feat: add trimTrailingSilence pcm primitive to media/wav"
  ```

- [ ] **Step 6: Write the failing voice-stage test (per-chunk trim)**

  In `src/stages/voice.test.ts`, add one test inside the existing `describe('voiceStage', ...)` block, directly after the test titled `'splits long narration into multiple under-budget kokoro calls and concatenates them'`. It reuses the file's existing `LONG_SCRIPT` (285 words -> 5 chunks of 57 words), `KOKORO_RATE` (24000), `countWords`, `ctxWithScript`, and `parseWavDurationMs` imports — no new imports are needed:

  ```ts
    it('caps per-chunk trailing silence so concatenation has no internal gaps or dead tail', async () => {
      const ctx = await ctxWithScript(LONG_SCRIPT);
      // Each chunk: audible speech at 2 words/sec followed by 3s of pure silence —
      // the shape real kokoro output has (multi-second silent pad per generation).
      const generate = vi.fn(async (t: string) => {
        const speech = countWords(t) * (KOKORO_RATE / 2);
        const audio = new Float32Array(speech + KOKORO_RATE * 3);
        audio.fill(0.5, 0, speech);
        return { audio, sampling_rate: KOKORO_RATE };
      });
      vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

      await voiceStage.run(ctx);

      const texts = generate.mock.calls.map((c) => c[0] as string);
      expect(texts.length).toBeGreaterThan(1);
      // Each chunk keeps its speech plus at most 250ms of tail: the 3s pads are
      // gone both between chunks (internal gaps) and after the last one (tail).
      const expectedMs = texts.reduce((ms, t) => ms + countWords(t) * 500 + 250, 0);
      const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'));
      expect(parseWavDurationMs(wav)).toBe(expectedMs);
      const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
      expect(meta.durationMs).toBe(expectedMs);
    });
  ```

  Do NOT touch the existing tests. Their kokoro/edge mocks emit all-zero PCM (`new Float32Array(n)` and `buildWav`'s zeroed data), which the all-silence rule returns intact — their duration expectations stay exact after the trim lands. That interplay is deliberate: it is the "never trim to zero" rule doing double duty.

- [ ] **Step 7: Run the voice tests — expect FAIL with a duration mismatch**

  ```bash
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: the new test fails on the `parseWavDurationMs` assertion with
  `AssertionError: expected 157500 to be 143750` (5 chunks × 57 words: untrimmed 5 × (28500 + 3000) = 157500ms vs trimmed 5 × (28500 + 250) = 143750ms). All other tests in the file still pass.

- [ ] **Step 8: Wire the trim into `synthChunked` (`src/stages/voice.ts`)**

  Two edits. First, extend the wav import at the top of `src/stages/voice.ts`:

  ```ts
  import { encodePcmWav, pcmFromFloat32, parseWav, parseWavDurationMs, trimTrailingSilence } from '../media/wav.js';
  ```

  Second, replace the whole `synthChunked` function (its doc comment gains the rationale; the only code change is the `parts.push` line):

  ```ts
  /**
   * Synthesize `text` one under-budget chunk at a time and write the concatenated
   * PCM as a single WAV. Chunks are synthesized sequentially on purpose: kokoro is
   * local ONNX inference against one model instance and edge-tts reuses one socket,
   * so concurrency would only contend.
   *
   * Each chunk's trailing silence is capped before concatenation: kokoro pads
   * every generation with multi-second silence, which would otherwise embed dead
   * air between chunks and a long silent tail after the last word (Plan 1 real
   * tail run: 15375ms narration whose aligned words end ~10490ms — captions stop
   * while the video keeps running).
   */
  async function synthChunked(
    text: string,
    provider: string,
    synth: (chunk: string) => Promise<PcmChunk>,
    wavPath: string,
  ): Promise<void> {
    const parts: Buffer[] = [];
    let sampleRate = 0;
    let channels = 0;
    for (const chunk of splitForTts(text)) {
      const pcm = await synth(chunk);
      parts.push(trimTrailingSilence(pcm.data, pcm.sampleRate, Math.max(1, pcm.channels)));
      sampleRate = pcm.sampleRate;
      channels = pcm.channels;
    }
    if (parts.length === 0 || sampleRate <= 0) throw new Error(`${provider} produced no audio`);
    await fs.writeFile(wavPath, encodePcmWav(parts, sampleRate, Math.max(1, channels)));
  }
  ```

  Nothing else in `voice.ts` changes: both `synthKokoro` and `synthEdge` already funnel through `synthChunked`, so the edge-tts fallback gets the same per-chunk cap for free, and the implausibly-short truncation guard downstream is unaffected (trimming only ever removes silence after the last audible sample, and real speech at 2.5–3 words/sec sits far above the 5 words/sec floor).

- [ ] **Step 9: Run the voice tests again — expect PASS**

  ```bash
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: `Test Files 1 passed`, all tests green — the new trim test AND every pre-existing test (all-zero mock audio is returned intact by the all-silence rule, so no existing expectation moved).

- [ ] **Step 10: Full suite + build green, then commit the fix**

  ```bash
  pnpm test && pnpm build
  ```

  Expected: the whole suite passes (including golden-path — its seeded fixtures never pass through `synthChunked`) and both `tsc --noEmit` runs are clean.

  ```bash
  git add src/stages/voice.ts src/stages/voice.test.ts
  git commit -m "fix: cap per-chunk kokoro trailing silence to realign caption tail"
  ```

- [ ] **Step 11 (OPTIONAL, non-blocking): real-kokoro before/after check**

  Mocks cannot prove the real model's silent pad is what gets cut. The kokoro model is cached locally from Plan 1's runs, so one real synth is cheap and offline. Write this scratch script to `.superpowers/sdd/verify-trim.ts` (`.superpowers/sdd/.gitignore` is `*`, so it cannot be committed):

  ```ts
  // Scratch verification: real kokoro synth, print duration before/after trim.
  import { KokoroTTS, type GenerateOptions } from 'kokoro-js'
  import { pcmFromFloat32, trimTrailingSilence } from '../../src/media/wav.js'

  const text =
    'Venus spins backwards compared to every other planet orbiting our star and nobody really knows exactly why that happens.'
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' })
  const audio = await tts.generate(text, { voice: 'af_heart' as GenerateOptions['voice'] })
  const pcm = pcmFromFloat32(audio.audio)
  const trimmed = trimTrailingSilence(pcm, audio.sampling_rate, 1)
  const ms = (b: Buffer) => Math.floor((b.length / 2 / audio.sampling_rate) * 1000)
  console.log(`raw ${ms(pcm)}ms -> trimmed ${ms(trimmed)}ms (cut ${ms(pcm) - ms(trimmed)}ms)`)
  ```

  ```bash
  pnpm tsx .superpowers/sdd/verify-trim.ts
  ```

  Expected shape of output: `raw <N>ms -> trimmed <M>ms (cut <N-M>ms)` where the cut is greater than 0 (kokoro's pad varies per generation; anything from a few hundred ms up is normal) and the trimmed duration is plausible for 19 words (~6–9s at 2.5–3 words/sec). If the model is not cached and the machine is offline, skip this step — it gates nothing. Delete nothing afterwards; the directory is gitignored.

---

### Task 5: Channel config — per-tier voice, [premium], premium budget cap

**Files:**
- Modify: `src/config/channel.ts`
- Modify: `channels/example.toml`
- Modify: `src/stages/_testkit.ts`
- Modify (mechanical — inline `ChannelConfig` literals gain the new required fields): `src/jobs/runner.test.ts`, `src/jobs/costs.test.ts`, `src/stages/assemble.test.ts`, `src/stages/qc.test.ts`, `src/stages/visuals-volume.test.ts`, `src/stages/script.test.ts`
- Test: `src/config/channel.test.ts`

> Why the six extra test files: `pnpm build` runs `tsc --noEmit` with `"include": ["src"]`, which typechecks every `src/**/*.test.ts`. Those six files construct full `ChannelConfig` object literals; once `premium` and `budget.premiumPerVideoUsdMicros` are required, they no longer compile without the new fields. The edits are purely additive (new fields with default values) — no behavior of those tests changes.

**Interfaces:**
- Consumes:
  - `loadChannelConfig(path: string): ChannelConfig` and `CaptionStyle` — existing `src/config/channel.ts` (Plan 1). Volume-tier fields keep their exact current shapes.
  - `parse as parseToml` from `smol-toml` and `z` from `zod` (v4) — existing dependencies; no new packages.
  - Nothing from Tasks 1–4 (they touch runner/assemble/sidecar/wav, none of which this task reads).
- Produces (BINDING, verbatim from the Interface Contract):
  ```ts
  // src/config/channel.ts
  export interface PremiumVoiceConfig { provider: 'elevenlabs'; voiceId: string; modelId: string }
  export interface PremiumConfig { imageModel: string; videoModel: string; stylePrefix?: string; sceneConcurrency: number }
  export interface ChannelConfig {
    name: string
    niche: string[]
    tierMix: { volume: number; premium: number }
    voice: { volume: string; premium?: PremiumVoiceConfig }
    premium: PremiumConfig            // always present; defaults applied when [premium] absent
    captionStyle: CaptionStyle        // unchanged
    bgDir: string
    bgmDir: string
    budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
    scriptModel: string
  }
  ```
  - Extra (non-contract, convenience) export: `DEFAULT_PREMIUM: PremiumConfig` — the single source of the `[premium]` defaults (`imageModel: 'fal-ai/flux/dev'`, `videoModel: 'fal-ai/kling-video/v3/standard/image-to-video'`, `sceneConcurrency: 3`). Used by the loader and by `_testkit.ts`. If Task 8's live verification of fal endpoint ids differs from the contract values, Task 8 updates this constant in the same commit as its `FAL_PRICE_TABLE`.
  - TOML key mapping (snake_case → camelCase, matching existing convention):
    - `[voice.premium]` `provider` / `voice_id` / `model` → `voice.premium.{provider, voiceId, modelId}`; `model` defaults to `'eleven_multilingual_v2'`; whole table optional → `voice.premium` is `undefined` when absent.
    - The volume voice deliberately stays a bare string (a kokoro voice id) rather than the `[voice.volume]` table sketched in an earlier spec draft; the design spec has been corrected to match.
    - `[premium]` `image_model` / `video_model` / `style_prefix` / `scene_concurrency` → `premium.{imageModel, videoModel, stylePrefix, sceneConcurrency}`; table optional (whole-object default), each field individually defaulted when the table is partial.
    - `[budget]` `premium_per_video_usd` → `budget.premiumPerVideoUsdMicros`; optional, default `7.0` USD → `7_000_000` micros.
  - `testChannel()` in `src/stages/_testkit.ts` now returns a fully premium-capable config: `voice.premium` set (ElevenLabs "Sarah"), `premium: { ...DEFAULT_PREMIUM }`, `budget.premiumPerVideoUsdMicros: 7_000_000`. Consumed by tests in Tasks 6, 10, 11, 13, 15, 16. A test that needs a channel WITHOUT premium voice overrides it: `testChannel({ voice: { volume: 'af_heart' } })`.
  - `channels/example.toml` demonstrates every new key and stays the parse fixture for `channel.test.ts`.

- [ ] **Step 1: Update `channels/example.toml` with the new blocks.** Top-level keys stay before the first `[table]` header (smol-toml binds later top-level keys into the open table). `[voice.premium]` is a sub-table of `[voice]`; `premium_per_video_usd` lives inside `[budget]`. Full new file content:

```toml
name = "example"
niche = ["space facts", "astronomy"]
script_model = "claude-sonnet-5"
bg_dir = "assets/bg"
bgm_dir = "assets/bgm"

[tier_mix]
volume = 2
premium = 1

[voice]
volume = "af_heart"

[voice.premium]
provider = "elevenlabs"
voice_id = "EXAVITQu4vr4xnSDxMaL"  # "Sarah" — public ElevenLabs premade voice
model = "eleven_multilingual_v2"

[premium]
image_model = "fal-ai/flux/dev"
video_model = "fal-ai/kling-video/v3/standard/image-to-video"
style_prefix = "vivid digital illustration, cinematic lighting"
scene_concurrency = 3

[caption_style]
font = "Inter"
font_size_px = 72
active_color = "#FFD700"
inactive_color = "#FFFFFF"
stroke_px = 8

[budget]
per_video_usd = 8.0    # volume per-video cap; loader converts to usdMicros
premium_per_video_usd = 7.0
per_day_usd = 20.0
```

- [ ] **Step 2: Write the failing tests — replace `src/config/channel.test.ts` entirely.** Keeps every Plan 1 assertion (updated for the new shape) and adds: Plan-1-era TOML backward compatibility, `[voice.premium]` model default, partial `[premium]` per-field defaults, and `premium_per_video_usd` micros conversion. `PLAN1_LINES` reproduces the pre-task `channels/example.toml` shape verbatim — that is the backward-compatibility contract. Appending table headers at the end of the file is valid TOML (a `[voice.premium]` header may appear after `[budget]`); a bare key appended at the end lands in `[budget]` because `[budget]` is the last table in `PLAN1_LINES`.

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChannelConfig } from './channel.js'

function writeToml(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'chan-'))
  const file = join(dir, 'channel.toml')
  writeFileSync(file, lines.join('\n'))
  return file
}

// Exactly the Plan-1-era channels/example.toml shape: no [voice.premium], no
// [premium], no premium_per_video_usd. Parsing this unchanged is the backward-
// compatibility contract. NOTE: [budget] is the last table, so a bare key
// appended to this array lands inside [budget].
const PLAN1_LINES = [
  'name = "legacy"',
  'niche = ["space facts", "astronomy"]',
  'script_model = "claude-sonnet-5"',
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
  '',
]

describe('loadChannelConfig', () => {
  it('parses channels/example.toml into a ChannelConfig', () => {
    const cfg = loadChannelConfig('channels/example.toml')
    expect(cfg.name).toBe('example')
    expect(cfg.niche).toEqual(['space facts', 'astronomy'])
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
    expect(cfg.tierMix).toEqual({ volume: 2, premium: 1 })
    expect(cfg.voice).toEqual({
      volume: 'af_heart',
      premium: {
        provider: 'elevenlabs',
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        modelId: 'eleven_multilingual_v2',
      },
    })
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      stylePrefix: 'vivid digital illustration, cinematic lighting',
      sceneConcurrency: 3,
    })
    expect(cfg.captionStyle).toEqual({
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    })
    expect(cfg.bgDir).toBe('assets/bg')
    expect(cfg.bgmDir).toBe('assets/bgm')
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: 20_000_000,
    })
  })

  it('parses a Plan-1-era TOML: voice.premium undefined, premium defaults applied', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.voice.premium).toBeUndefined()
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      sceneConcurrency: 3,
    })
    expect(cfg.premium.stylePrefix).toBeUndefined()
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000, // default 7.0 USD
      perDayUsdMicros: 20_000_000,
    })
  })

  it('defaults [voice.premium] model to eleven_multilingual_v2 when omitted', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[voice.premium]',
        'provider = "elevenlabs"',
        'voice_id = "EXAVITQu4vr4xnSDxMaL"',
      ]),
    )
    expect(cfg.voice.premium).toEqual({
      provider: 'elevenlabs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
    })
  })

  it('applies per-field defaults inside a partial [premium] table', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[premium]', 'scene_concurrency = 5', 'style_prefix = "watercolor"']),
    )
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      stylePrefix: 'watercolor',
      sceneConcurrency: 5,
    })
  })

  it('converts an explicit premium_per_video_usd to micros', () => {
    // appended bare key lands in [budget] (last table in PLAN1_LINES)
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, 'premium_per_video_usd = 3.5']))
    expect(cfg.budget.premiumPerVideoUsdMicros).toBe(3_500_000)
  })

  it('defaults scriptModel to claude-sonnet-5 when script_model is absent', () => {
    const cfg = loadChannelConfig(
      writeToml(PLAN1_LINES.filter((l) => l !== 'script_model = "claude-sonnet-5"')),
    )
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
  })

  it('throws when a required field is missing', () => {
    // strip the entire [budget] table
    const idx = PLAN1_LINES.indexOf('[budget]')
    expect(() => loadChannelConfig(writeToml(PLAN1_LINES.slice(0, idx)))).toThrow()
  })

  it('throws when the file does not exist', () => {
    expect(() => loadChannelConfig('channels/does-not-exist.toml')).toThrow()
  })
})
```

- [ ] **Step 3: Run the test expecting failure.** Command: `pnpm vitest run src/config/channel.test.ts`. Expected: 8 tests, 5 failed / 3 passed. The old `rawSchema` (zod strips unknown keys) silently drops every new TOML key, so:
  - `parses channels/example.toml…` → `AssertionError: expected { volume: 'af_heart' } to deeply equal { volume: 'af_heart', premium: { …(3) } }`
  - `parses a Plan-1-era TOML…`, `applies per-field defaults…` → `expected undefined to deeply equal { imageModel: 'fal-ai/flux/dev', … }` (`cfg.premium` does not exist yet)
  - `defaults [voice.premium] model…` → `expected undefined to deeply equal { provider: 'elevenlabs', … }`
  - `converts an explicit premium_per_video_usd…` → `expected undefined to be 3500000`
  - The three Plan 1 regression tests (`defaults scriptModel…`, `throws when a required field is missing`, `throws when the file does not exist`) still pass.

- [ ] **Step 4: Implement — replace `src/config/channel.ts` entirely.** Design notes baked in: zod v4's `.default()` short-circuits with an output-typed value, so the absent-table default is applied in the mapping (`raw.premium ? … : { ...DEFAULT_PREMIUM }`) while per-field defaults for a *present* table use scalar zod `.default(...)` — both read from the single `DEFAULT_PREMIUM` constant. `stylePrefix: raw.premium.style_prefix` may assign `undefined` to the optional property; `exactOptionalPropertyTypes` is not enabled, so this compiles, and vitest's `toEqual` ignores `undefined`-valued keys.

```ts
import { readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

export interface CaptionStyle {
  font: string
  fontSizePx: number
  activeColor: string
  inactiveColor: string
  strokePx: number
}

export interface PremiumVoiceConfig {
  provider: 'elevenlabs'
  voiceId: string
  modelId: string
}

export interface PremiumConfig {
  imageModel: string
  videoModel: string
  stylePrefix?: string
  sceneConcurrency: number
}

export interface ChannelConfig {
  name: string
  niche: string[]
  tierMix: { volume: number; premium: number }
  voice: { volume: string; premium?: PremiumVoiceConfig }
  premium: PremiumConfig
  captionStyle: CaptionStyle
  bgDir: string
  bgmDir: string
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
}

/**
 * Defaults for the [premium] TOML table: applied whole when the table is
 * absent, per-field (via the zod defaults below) when it is partial.
 * Endpoint ids follow the plan's Interface Contract; FAL_PRICE_TABLE in
 * src/providers/fal.ts (Task 8) is the source of truth for verified live
 * ids and prices — if verification changes an id, update it here too.
 */
export const DEFAULT_PREMIUM: PremiumConfig = {
  imageModel: 'fal-ai/flux/dev',
  videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
  sceneConcurrency: 3,
}

const DEFAULT_PREMIUM_PER_VIDEO_USD = 7.0
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'

const rawSchema = z.object({
  name: z.string(),
  niche: z.array(z.string()),
  script_model: z.string().default('claude-sonnet-5'),
  tier_mix: z.object({
    volume: z.number(),
    premium: z.number(),
  }),
  voice: z.object({
    volume: z.string(),
    premium: z
      .object({
        provider: z.literal('elevenlabs'),
        voice_id: z.string(),
        model: z.string().default(DEFAULT_ELEVENLABS_MODEL_ID),
      })
      .optional(),
  }),
  premium: z
    .object({
      image_model: z.string().default(DEFAULT_PREMIUM.imageModel),
      video_model: z.string().default(DEFAULT_PREMIUM.videoModel),
      style_prefix: z.string().optional(),
      scene_concurrency: z.number().default(DEFAULT_PREMIUM.sceneConcurrency),
    })
    .optional(),
  caption_style: z.object({
    font: z.string(),
    font_size_px: z.number(),
    active_color: z.string(),
    inactive_color: z.string(),
    stroke_px: z.number(),
  }),
  budget: z.object({
    per_video_usd: z.number(),
    premium_per_video_usd: z.number().default(DEFAULT_PREMIUM_PER_VIDEO_USD),
    per_day_usd: z.number(),
  }),
  bg_dir: z.string(),
  bgm_dir: z.string(),
})

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

export function loadChannelConfig(path: string): ChannelConfig {
  const text = readFileSync(path, 'utf8')
  const raw = rawSchema.parse(parseToml(text))
  return {
    name: raw.name,
    niche: raw.niche,
    tierMix: { volume: raw.tier_mix.volume, premium: raw.tier_mix.premium },
    voice: {
      volume: raw.voice.volume,
      premium: raw.voice.premium
        ? {
            provider: raw.voice.premium.provider,
            voiceId: raw.voice.premium.voice_id,
            modelId: raw.voice.premium.model,
          }
        : undefined,
    },
    premium: raw.premium
      ? {
          imageModel: raw.premium.image_model,
          videoModel: raw.premium.video_model,
          stylePrefix: raw.premium.style_prefix,
          sceneConcurrency: raw.premium.scene_concurrency,
        }
      : { ...DEFAULT_PREMIUM },
    captionStyle: {
      font: raw.caption_style.font,
      fontSizePx: raw.caption_style.font_size_px,
      activeColor: raw.caption_style.active_color,
      inactiveColor: raw.caption_style.inactive_color,
      strokePx: raw.caption_style.stroke_px,
    },
    bgDir: raw.bg_dir,
    bgmDir: raw.bgm_dir,
    budget: {
      perVideoUsdMicros: usdToMicros(raw.budget.per_video_usd),
      premiumPerVideoUsdMicros: usdToMicros(raw.budget.premium_per_video_usd),
      perDayUsdMicros: usdToMicros(raw.budget.per_day_usd),
    },
    scriptModel: raw.script_model,
  }
}
```

- [ ] **Step 5: Run the test expecting success.** Command: `pnpm vitest run src/config/channel.test.ts`. Expected: `Test Files  1 passed (1)`, `Tests  8 passed (8)`.

- [ ] **Step 6: Update `testChannel()` in `src/stages/_testkit.ts`.** The shared fixture becomes premium-capable by default (volume-tier stages never read the new fields, so no existing test's behavior changes). Note `_testkit.ts` uses semicolons — keep them. Replace the current `import type { ChannelConfig } …` line with the two-line import, and replace the whole `testChannel` function:

```ts
import { DEFAULT_PREMIUM } from '../config/channel.js';
import type { ChannelConfig } from '../config/channel.js';
```

```ts
export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: 'test',
    niche: ['space facts', 'astronomy'],
    tierMix: { volume: 2, premium: 1 },
    voice: {
      volume: 'af_heart',
      premium: { provider: 'elevenlabs', voiceId: 'EXAVITQu4vr4xnSDxMaL', modelId: 'eleven_multilingual_v2' },
    },
    premium: { ...DEFAULT_PREMIUM },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    ...overrides,
  };
}
```

(`{ ...DEFAULT_PREMIUM }` is spread per call so no two tests share a mutable object. Later tasks that need a channel *without* premium voice pass `testChannel({ voice: { volume: 'af_heart' } })`.)

- [ ] **Step 7: Mechanical compile fixes — add the new required fields to every inline `ChannelConfig` literal.** Six files, two edits each (except `script.test.ts`, one edit). These literals are local test fixtures that never hit the network, so plain string values (not the `DEFAULT_PREMIUM` import) keep the edits minimal. Apply exactly:

  **`src/jobs/runner.test.ts`** — inside `function testChannel()`: after the line `voice: { volume: 'af_heart' },` insert
  ```ts
    premium: { imageModel: 'fal-ai/flux/dev', videoModel: 'fal-ai/kling-video/v3/standard/image-to-video', sceneConcurrency: 3 },
  ```
  and replace
  ```ts
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
  ```
  with
  ```ts
    budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros: 20_000_000 },
  ```

  **`src/jobs/costs.test.ts`** — inside `function channel(...)`: after `voice: { volume: 'af_heart' },` insert the same `premium: { … }` line as above, and replace
  ```ts
    budget: { perVideoUsdMicros, perDayUsdMicros },
  ```
  with
  ```ts
    budget: { perVideoUsdMicros, premiumPerVideoUsdMicros: 7_000_000, perDayUsdMicros },
  ```

  **`src/stages/assemble.test.ts`** — inside `function makeChannel(bgmDir)`: after `voice: { volume: 'af_heart' },` insert the same `premium: { … }` line, and replace `budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },` with the three-field budget line from `runner.test.ts` above.

  **`src/stages/qc.test.ts`** — inside `makeCtx`'s `const channel: ChannelConfig = { … }` literal: same two edits (insert `premium: { … }` after the `voice:` line; budget line gains `premiumPerVideoUsdMicros: 7_000_000`).

  **`src/stages/visuals-volume.test.ts`** — inside `function makeChannel(bgDir)`: same two edits.

  **`src/stages/script.test.ts`** — the budget-override test constructs a partial budget; replace
  ```ts
    const ctx = makeCtx(testChannel({ budget: { perVideoUsdMicros: 1, perDayUsdMicros: 1 } }));
  ```
  with
  ```ts
    const ctx = makeCtx(testChannel({ budget: { perVideoUsdMicros: 1, premiumPerVideoUsdMicros: 1, perDayUsdMicros: 1 } }));
  ```

- [ ] **Step 8: Full suite + build gate.** Commands: `pnpm test` then `pnpm build`. Expected: every test file passes — `channel.test.ts` now at its new count, every other file unchanged-green from the previous task (`src/jobs/golden-path.test.ts` writes its own Plan-1-era TOML and now doubles as a live backward-compatibility proof); both tsc gates pass. `pnpm build` (`tsc --noEmit && tsc -p remotion --noEmit`) exits 0 — this is the check that the Step 7 literal fixes are complete. If tsc reports a missing `premium` or `premiumPerVideoUsdMicros` in any other file, fix that literal the same way before proceeding.

- [ ] **Step 9: Commit.**
  ```
  git add src/config/channel.ts src/config/channel.test.ts channels/example.toml src/stages/_testkit.ts src/jobs/runner.test.ts src/jobs/costs.test.ts src/stages/assemble.test.ts src/stages/qc.test.ts src/stages/visuals-volume.test.ts src/stages/script.test.ts && git commit -m "feat: per-tier voice, [premium] block, and premium per-video budget cap in channel config"
  ```

---

### Task 6: Budget semantics — tier-aware caps, per-channel + global daily

**Files:**
- Modify: `src/jobs/costs.ts`, `src/stages/script.ts`
- Test: `src/jobs/costs.test.ts`

**Interfaces:**
- Consumes: `openDb(dbPath: string): Database` (`src/db/index.ts`); `ChannelConfig` (`src/config/channel.ts`, post-Task-5 shape — `budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }`, `name: string`); `Tier = 'volume' | 'premium'` and `JobContext.tier` (`src/jobs/types.ts`); `createJob(db, channel, opts: { topic: string; tier: Tier }): string` (`src/jobs/runner.ts`, test seeding — cost rows attribute to a channel through the `jobs` table); `testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig` (`src/stages/_testkit.ts`, carries the Task 5 premium fields); env `BRAINROT_GLOBAL_DAILY_USD` (USD, default 25, read from `process.env` at call time — dotenv is loaded once in `src/cli.ts`).
- Produces: `assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void` — the BINDING Interface Contract signature; `tier` is REQUIRED so every stale 4-arg call site is a compile error. Enforces, in order: (1) per-video cap — `tier === 'premium'` → `budget.premiumPerVideoUsdMicros`, else `budget.perVideoUsdMicros`, vs lifetime `SUM(costs.usd_micros) WHERE job_id = ?`; (2) per-channel daily — today-UTC `SUM(costs JOIN jobs ON costs.job_id = jobs.id) WHERE jobs.channel = ?` vs `budget.perDayUsdMicros`; (3) global daily — today-UTC `SUM(costs)` across all channels vs `BRAINROT_GLOBAL_DAILY_USD` in micros. All comparisons strict `>` (equal-to-cap passes). `BudgetExceededError.message` starts with the cap name — `per-video` / `premium per-video` / `channel-day` / `global-day` — the runner surfaces it verbatim as the blocked reason. `recordCost` and `BudgetExceededError` are unchanged. Tasks 10, 11, 13, and 15 call `assertBudget(..., ctx.tier)` or `assertBudget(..., 'premium')` with exactly this signature.

- [ ] **Step 1: Write the failing test — rewrite `src/jobs/costs.test.ts`.** Full replacement of the file. Channels come from `testChannel()` (Task 5) so future `ChannelConfig` fields land in one fixture; every job that carries spend is a real `jobs` row (the channel-day cap attributes cost rows through the `jobs` JOIN — `costs` has no channel column). Note: `pnpm build` goes red at this step (the tests pass a 5th argument the current signature lacks) and stays red until Step 5 — vitest's esbuild transform does not typecheck, so the tests still run:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import type { ChannelConfig } from '../config/channel.js'
import { createJob } from './runner.js'
import { testChannel } from '../stages/_testkit.js'
import { assertBudget, BudgetExceededError, recordCost } from './costs.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-costs-'))
  return openDb(join(dir, 'brainrot.db'))
}

// Budget shorthand: testChannel() (Task 5) supplies every non-budget field.
function channel(
  name: string,
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number },
): ChannelConfig {
  return testChannel({ name, budget })
}

// Cost rows attribute to a channel through the jobs table (costs has no channel
// column), so every job that carries spend must exist as a real jobs row.
function seedJob(db: Database, ch: ChannelConfig, tier: 'volume' | 'premium' = 'volume'): string {
  return createJob(db, ch, { topic: 'budget test topic', tier })
}

const GENEROUS = 100_000_000 // $100 — never the cap under test

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('recordCost + assertBudget', () => {
  it('records a cost row', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 1_500_000)
    const row = db
      .prepare('SELECT job_id, provider, operation, usd_micros FROM costs')
      .get() as { job_id: string; provider: string; operation: string; usd_micros: number }
    expect(row).toEqual({
      job_id: 'job-1',
      provider: 'anthropic',
      operation: 'script',
      usd_micros: 1_500_000,
    })
    db.close()
  })

  it('passes when spend is under every cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: 20_000_000,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 2_000_000)
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })

  it('throws on a volume per-video breach, naming the per-video cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 7_500_000)
    // 7.5M + 1M = 8.5M > 8M volume cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(BudgetExceededError)
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('premium tier judges the job against the premium per-video cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 1_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch, 'premium')
    recordCost(db, jobId, 'fal', 'image', 2_000_000)
    // Identical db state, tier argument alone picks the cap (assertBudget uses
    // the tier PARAMETER, not the jobs row): 2M + 1M busts the 1M volume cap
    // but fits the 7M premium cap.
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'premium')).not.toThrow()
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('throws on a premium per-video breach, naming the premium cap', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch, 'premium')
    recordCost(db, jobId, 'fal', 'video', 6_500_000)
    // 6.5M + 1M = 7.5M > 7M premium cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'premium')).toThrow(
      /^premium per-video budget exceeded/,
    )
    db.close()
  })

  // These seed spend via recordCost ('now') and assert in the same tick; the
  // only race is a sub-second UTC-midnight rollover between the two statements
  // — accepted. A 00:00:00Z CI failure here is that race, not a regression.
  it("channel-day cap counts only the channel's own jobs", () => {
    const db = tempDb()
    const chA = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 10_000_000,
    })
    const chB = channel('chan-b', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 10_000_000,
    })
    const jobA1 = seedJob(db, chA)
    const jobA2 = seedJob(db, chA)
    const jobB = seedJob(db, chB)
    recordCost(db, jobA1, 'anthropic', 'script', 6_000_000)
    recordCost(db, jobA2, 'fal', 'image', 3_500_000)
    // chan-a today: 9.5M; + 1M = 10.5M > its 10M channel-day cap
    expect(() => assertBudget(db, chA, jobA2, 1_000_000, 'volume')).toThrow(
      /^channel-day budget exceeded for "chan-a"/,
    )
    // chan-b has spent nothing today: the identical call passes (global day
    // would be 10.5M, well under the $25 default global cap)
    expect(() => assertBudget(db, chB, jobB, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })

  it('global-day cap reads BRAINROT_GLOBAL_DAILY_USD and sums across channels', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', '5')
    const db = tempDb()
    const chA = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const chB = channel('chan-b', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobA = seedJob(db, chA)
    const jobB = seedJob(db, chB)
    recordCost(db, jobA, 'anthropic', 'script', 3_000_000)
    recordCost(db, jobB, 'fal', 'image', 1_500_000)
    // all channels today: 4.5M; + 1M = 5.5M > 5M env cap — trips even though
    // chan-b's own channel-day sum is only 2.5M
    expect(() => assertBudget(db, chB, jobB, 1_000_000, 'volume')).toThrow(
      /^global-day budget exceeded/,
    )
    db.close()
  })

  it('global-day cap defaults to $25 when the env var is unset', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', undefined) // deterministic even if the shell exports it
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'fal', 'video', 24_500_000)
    // 24.5M + 0.5M == 25M default cap exactly: boundary passes (strict >)
    expect(() => assertBudget(db, ch, jobId, 500_000, 'volume')).not.toThrow()
    // 24.5M + 1M = 25.5M > 25M default cap
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).toThrow(
      /^global-day budget exceeded/,
    )
    db.close()
  })

  it('spend from a previous UTC day is invisible to daily caps but counts per-video', () => {
    const db = tempDb()
    const daily = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 5_000_000,
    })
    const jobId = seedJob(db, daily)
    db.prepare(
      "INSERT INTO costs (job_id, provider, operation, usd_micros, created_at) VALUES (?, 'fal', 'video', ?, '2020-01-01T00:00:00.000Z')",
    ).run(jobId, 4_900_000)
    // 4.9M spent in 2020: today's daily sums are 0, so +1M clears the 5M daily cap
    expect(() => assertBudget(db, daily, jobId, 1_000_000, 'volume')).not.toThrow()
    // ...but the per-video cap is lifetime: 4.9M + 1M busts a 5M per-video cap
    const tight = channel('chan-a', {
      perVideoUsdMicros: 5_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 5_000_000,
    })
    expect(() => assertBudget(db, tight, jobId, 1_000_000, 'volume')).toThrow(
      /^per-video budget exceeded/,
    )
    db.close()
  })

  it('rejects a malformed BRAINROT_GLOBAL_DAILY_USD instead of silently uncapping', () => {
    vi.stubEnv('BRAINROT_GLOBAL_DAILY_USD', 'twenty')
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: GENEROUS,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: GENEROUS,
    })
    const jobId = seedJob(db, ch)
    let caught: unknown
    try {
      assertBudget(db, ch, jobId, 1_000, 'volume')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    // Misconfiguration is a crash (job 'failed'), not a budget outcome ('blocked'):
    // a plain Error, NOT BudgetExceededError, so the runner does not park it.
    expect(caught).not.toBeInstanceOf(BudgetExceededError)
    expect((caught as Error).message).toMatch(/BRAINROT_GLOBAL_DAILY_USD/)
    db.close()
  })

  it('passes at the exact per-video boundary (total + upcoming equals the cap)', () => {
    const db = tempDb()
    const ch = channel('chan-a', {
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: GENEROUS,
      perDayUsdMicros: 20_000_000,
    })
    const jobId = seedJob(db, ch)
    recordCost(db, jobId, 'anthropic', 'script', 7_000_000)
    // per-video: 7M + 1M == 8M cap; channel-day 8M < 20M; global 8M < 25M default
    expect(() => assertBudget(db, ch, jobId, 1_000_000, 'volume')).not.toThrow()
    db.close()
  })
})
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/jobs/costs.test.ts`. Expected: `Tests  6 failed | 5 passed (11)`. The old 4-arg implementation ignores the extra `tier` argument at runtime, so the failures are behavioral, exactly these six:
  - `premium tier judges the job against the premium per-video cap` — old code judges 3M against the 1M volume cap and throws where `.not.toThrow()` is expected: `AssertionError: expected [Function] to not throw an error but 'BudgetExceededError: per-video budge…' was thrown`.
  - `throws on a premium per-video breach, naming the premium cap` — old code sees a 100M cap, nothing thrown.
  - `channel-day cap counts only the channel's own jobs` — old message `per-day budget exceeded…` does not match `/^channel-day budget exceeded for "chan-a"/`.
  - `global-day cap reads BRAINROT_GLOBAL_DAILY_USD and sums across channels` — old code has no env cap, nothing thrown.
  - `global-day cap defaults to $25 when the env var is unset` — second assertion: nothing thrown.
  - `rejects a malformed BRAINROT_GLOBAL_DAILY_USD instead of silently uncapping` — nothing thrown, `expected undefined to be an instance of Error`.

- [ ] **Step 3: Write the implementation — replace `src/jobs/costs.ts`.** Enforcement order per the Interface Contract: per-video → channel-day → global-day; strict `>` everywhere; the channel-day sum JOINs through `jobs` because `costs` has no channel column:

```ts
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'
import type { Tier } from './types.js'

// Operator-level safety net across ALL channels (design spec §5).
const DEFAULT_GLOBAL_DAILY_USD = 25

export class BudgetExceededError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'BudgetExceededError'
  }
}

export function recordCost(
  db: Database,
  jobId: string,
  provider: string,
  operation: string,
  usdMicros: number,
): void {
  db.prepare(
    'INSERT INTO costs (job_id, provider, operation, usd_micros) VALUES (?, ?, ?, ?)',
  ).run(jobId, provider, operation, usdMicros)
}

// Parsed at call time (not module load) so tests and long-lived processes see
// env changes without a re-import. dotenv is loaded once in src/cli.ts.
function globalDailyCapMicros(): number {
  const raw = process.env.BRAINROT_GLOBAL_DAILY_USD
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_GLOBAL_DAILY_USD * 1_000_000
  }
  const usd = Number(raw)
  // A NaN cap would make every `>` comparison false and silently disable the
  // safety net. Fail loudly instead — a plain Error (not BudgetExceededError)
  // so the runner records a crash ('failed'), not a budget outcome ('blocked').
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(
      `invalid BRAINROT_GLOBAL_DAILY_USD: ${JSON.stringify(raw)} (expected a non-negative number of USD)`,
    )
  }
  return Math.round(usd * 1_000_000)
}

/**
 * Pre-call budget checkpoint. Enforces, in order:
 *  1. per-video cap — tier picks the cap (premium → premiumPerVideoUsdMicros),
 *     against the job's lifetime spend
 *  2. channel-day cap — today's UTC spend attributed through the jobs table
 *     vs channel.budget.perDayUsdMicros
 *  3. global-day cap — today's UTC spend across ALL channels vs
 *     BRAINROT_GLOBAL_DAILY_USD (USD, default 25)
 * All comparisons are strict `>` (equal-to-cap passes). Messages start with the
 * cap name (per-video / premium per-video / channel-day / global-day) — the
 * runner surfaces them verbatim as the blocked reason.
 */
export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  upcomingUsdMicros: number,
  tier: Tier,
): void {
  const perVideoCap =
    tier === 'premium' ? channel.budget.premiumPerVideoUsdMicros : channel.budget.perVideoUsdMicros
  const perVideoLabel = tier === 'premium' ? 'premium per-video' : 'per-video'
  const jobRow = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  const jobProjected = jobRow.total + upcomingUsdMicros
  if (jobProjected > perVideoCap) {
    throw new BudgetExceededError(
      `${perVideoLabel} budget exceeded: ${jobProjected} > ${perVideoCap} usdMicros`,
    )
  }

  // costs has no channel column: attribute today's spend through the jobs table.
  const channelDayRow = db
    .prepare(
      'SELECT COALESCE(SUM(c.usd_micros), 0) AS total FROM costs c JOIN jobs j ON c.job_id = j.id ' +
        "WHERE j.channel = ? AND substr(c.created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get(channel.name) as { total: number }
  const channelDayProjected = channelDayRow.total + upcomingUsdMicros
  if (channelDayProjected > channel.budget.perDayUsdMicros) {
    throw new BudgetExceededError(
      `channel-day budget exceeded for "${channel.name}": ${channelDayProjected} > ${channel.budget.perDayUsdMicros} usdMicros`,
    )
  }

  const globalCapMicros = globalDailyCapMicros()
  const globalDayRow = db
    .prepare(
      "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get() as { total: number }
  const globalDayProjected = globalDayRow.total + upcomingUsdMicros
  if (globalDayProjected > globalCapMicros) {
    throw new BudgetExceededError(
      `global-day budget exceeded: ${globalDayProjected} > ${globalCapMicros} usdMicros (BRAINROT_GLOBAL_DAILY_USD, default ${DEFAULT_GLOBAL_DAILY_USD})`,
    )
  }
}
```

- [ ] **Step 4: Run the test expecting pass.** Command: `pnpm vitest run src/jobs/costs.test.ts`. Expected: `Tests  11 passed (11)`. (`pnpm build` is still red — the stale call site in `script.ts` is caught next, by design.)

- [ ] **Step 5: Prove the compile gate, then fix the stale call site.** Command: `pnpm build`. Expected failure — this is the point of making `tier` required:

```
src/stages/script.ts(63,7): error TS2554: Expected 5 arguments, but got 4.
```

Then update `src/stages/script.ts` — the single `assertBudget` line gains `ctx.tier` (everything else in the file is untouched; full file for zero-ambiguity):

```ts
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { StageDef, JobContext } from '../jobs/types.js';
import { assertBudget, recordCost } from '../jobs/costs.js';
import { structuredCompletion } from '../providers/anthropic.js';

// Pre-flight budget reservation for the script LLM call (~$0.02). assertBudget
// blocks the stage if the job or day is already too close to its cap.
export const ESTIMATED_SCRIPT_COST_MICROS = 20_000;

const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: z.object({
    youtube: platformEntrySchema,
    tiktok: platformEntrySchema,
    instagram: platformEntrySchema,
  }),
});

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

function buildSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the story format: one strong hook, then a single narrative arc across the segments.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ');
}

function buildPrompt(topic: string, niche: string[]): string {
  return `Write a short-form video script about: ${topic}

Niche: ${niche.join(', ')}

Story-format requirements:
- hook: one line, at most 10 words, that stops the scroll. No emojis.
- segments: 4 to 8 segments forming one narrative arc. Each segment has:
  - text: 1 to 3 sentences of spoken narration. Plain and conversational, no stage directions.
  - visualDirection: a short phrase (3 to 8 words) naming the on-screen background visual for that segment.
- platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
  - title: at most 90 characters. No emojis.
  - description: 1 to 2 plain-spoken sentences. No emojis.
  - hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`;
}

export function createScriptStage(client?: Anthropic): StageDef {
  return {
    name: 'script',
    async run(ctx: JobContext): Promise<void> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS, ctx.tier);
      const { data, cost } = await structuredCompletion({
        model: ctx.channel.scriptModel,
        system: buildSystem(ctx.channel.niche),
        prompt: buildPrompt(ctx.topic, ctx.channel.niche),
        schema: ScriptOutputSchema,
        // Raise the ceiling above the 2048 default: a full script + platformMeta for
        // three platforms can exceed it, and a truncated forced tool_use surfaces as
        // an opaque ZodError rather than a clear length failure.
        maxTokens: 4096,
        client,
      });
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', cost.usdMicros);
      await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(data, null, 2));
    },
  };
}

export const scriptStage = createScriptStage();
```

- [ ] **Step 6: Run the touched suites expecting pass.** Command: `pnpm vitest run src/jobs/costs.test.ts src/stages/script.test.ts`. Expected: `Tests  14 passed (14)` (11 costs + 3 script). The existing script-stage budget test (`throws BudgetExceededError before calling the API when over budget`) still passes: `makeCtx` runs tier `'volume'`, so its `perVideoUsdMicros: 1` override trips the volume per-video cap exactly as before.

- [ ] **Step 7: Full gates.** Commands: `pnpm test` then `pnpm build`. Expected: every test file green (the suite grows by 6 tests net: costs went 5 → 11), and both `tsc --noEmit` passes exit 0.

- [ ] **Step 8: Commit.** Command: `git add src/jobs/costs.ts src/jobs/costs.test.ts src/stages/script.ts && git commit -m "feat: tier-aware per-video caps plus channel and global daily budgets"`.

---

---

### Task 7: Anthropic vision judgment

**Files:**
- Modify: `src/providers/anthropic.ts`
- Test: `src/providers/anthropic.test.ts` (modify — new `visionJudgment` describe block; the six existing `structuredCompletion` tests stay byte-identical)

**Interfaces:**
- Consumes (existing code in `src/providers/anthropic.ts`, unchanged from Plan 1):
  - `export const PRICE_TABLE: Record<string, { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number }>` — has entries for `claude-sonnet-5` ($3/$15 per MTok) and `claude-haiku-4-5` ($1/$5). Verified against current Anthropic pricing 2026-07-19; no table changes needed.
  - `export interface LlmUsageCost { usdMicros: number }`
  - `export async function structuredCompletion<T>(opts: { model; system; prompt; schema; maxTokens?; client? }): Promise<{ data: T; cost: LlmUsageCost }>` — its public behavior (including its exact error messages `structuredCompletion: no price table entry for model "..."` and `structuredCompletion: no emit tool_use block in response`) MUST NOT change; the existing tests in `src/providers/anthropic.test.ts` run untouched and stay green.
  - `@anthropic-ai/sdk` ^0.112: `Anthropic.ContentBlockParam` (union incl. image + text block params), base64 image source shape `{ type: 'image', source: { type: 'base64', media_type: 'image/png' | 'image/jpeg', data: string } }` — both exported on the top-level `Anthropic` namespace (verified in the installed SDK's `client.d.ts`).
- Produces (consumed by Task 13 `visualsPremiumStage` keyframe check and Task 15 qc `vision-spot-check`):

```ts
// src/providers/anthropic.ts
export async function visionJudgment<T>(opts: {
  model: string; system: string; prompt: string; imagePaths: string[];
  schema: z.ZodType<T>; maxTokens?: number; client?: Anthropic
}): Promise<{ data: T; cost: LlmUsageCost }>
```

  Semantics (binding for consumers):
  - Content layout of the single user message: one base64 image block per `imagePaths` entry, **in order, all before** a final text block carrying `prompt`.
  - `media_type` by file extension, case-insensitive: `.png` → `image/png`, `.jpg`/`.jpeg` → `image/jpeg`. Any other extension throws `visionJudgment: unsupported image extension ...` before any API call (zero spend).
  - Same forced-tool `'emit'` + `tool_choice: {type:'tool'}` pattern as `structuredCompletion`; same `PRICE_TABLE` lookup BEFORE the call (unknown model throws `visionJudgment: no price table entry for model "..."` at zero spend); same zod-validate-then-`coerceJsonStrings`-retry path; same `maxTokens` default (2048); cost computed from `response.usage` at `PRICE_TABLE` list prices.
  - Callers pass `model: channel.scriptModel` (`claude-sonnet-5` — vision-capable) and inject `client` in tests.

- [ ] **Step 1: Write the failing tests.** Replace `src/providers/anthropic.test.ts` with the following (the `structuredCompletion` describe block is the existing content, unchanged; new: the node imports, `visionJudgment` in the import list, and the `visionJudgment` describe block at the end):

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCompletion, visionJudgment } from './anthropic.js';

const schema = z.object({ answer: z.string(), n: z.number() });

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('structuredCompletion', () => {
  it('parses the emit tool input, computes cost, and passes a native JSON schema', async () => {
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi', n: 3 } }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    const { data, cost } = await structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client });
    expect(data).toEqual({ answer: 'hi', n: 3 });
    expect(cost.usdMicros).toBe(100 * 3 + 200 * 15); // 3300

    // The forced emit tool must carry the zod schema rendered to JSON Schema.
    const sentTool = create.mock.calls[0][0].tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.type).toBe('object');
    expect(sentTool.input_schema.required).toEqual(expect.arrayContaining(['answer', 'n']));
  });

  it('throws a zod error on malformed tool input', async () => {
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(z.ZodError);
  });

  it('coerces a JSON-stringified nested value before validating (observed real-model behavior)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) });
    const { client } = fakeClient({
      content: [
        {
          type: 'tool_use',
          name: 'emit',
          id: 't1',
          // Anthropic tool_choice does not guarantee schema-conformant output;
          // models occasionally stringify a nested array/object instead of
          // emitting it structurally. Reproduces a failure seen against the
          // real API where `segments` came back as a JSON string.
          input: { segments: JSON.stringify([{ text: 'a' }, { text: 'b' }]) },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const { data } = await structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema: arraySchema, client });
    expect(data).toEqual({ segments: [{ text: 'a' }, { text: 'b' }] });
  });

  it('still throws on genuinely malformed input (not a JSON string, just wrong)', async () => {
    const arraySchema = z.object({ segments: z.array(z.object({ text: z.string() })) });
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { segments: 'not json at all' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await expect(
      structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema: arraySchema, client }),
    ).rejects.toThrow(z.ZodError);
  });

  it('throws when there is no emit tool_use block', async () => {
    const { client } = fakeClient({ content: [{ type: 'text', text: 'nope' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(/no emit tool_use/);
  });

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { answer: 'hi', n: 3 } }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    await expect(
      structuredCompletion({ model: 'claude-nonexistent-9', system: 's', prompt: 'p', schema, client }),
    ).rejects.toThrow(/no price table entry for model/);
    // The paid call must never fire for a model we cannot price.
    expect(create).not.toHaveBeenCalled();
  });
});

describe('visionJudgment', () => {
  const judgmentSchema = z.object({ pass: z.boolean(), critique: z.string() });

  // Tiny fake image bytes: visionJudgment reads and base64-encodes files, it
  // never decodes them, so magic-number-only "images" are enough for unit tests.
  function writeImages(): { dir: string; pngPath: string; jpgPath: string; pngB64: string; jpgB64: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-vision-'));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0x04, 0x05, 0x06]);
    const pngPath = path.join(dir, 'scene-01.png');
    const jpgPath = path.join(dir, 'frame-2.JPG'); // uppercase on purpose: extension mapping is case-insensitive
    writeFileSync(pngPath, pngBytes);
    writeFileSync(jpgPath, jpgBytes);
    return { dir, pngPath, jpgPath, pngB64: pngBytes.toString('base64'), jpgB64: jpgBytes.toString('base64') };
  }

  it('sends base64 image blocks (media_type by extension) before the text prompt and parses the emit output', async () => {
    const { pngPath, jpgPath, pngB64, jpgB64 } = writeImages();
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { pass: true, critique: 'matches the scene' } }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
    const { data, cost } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'Does this keyframe match the scene intent?',
      imagePaths: [pngPath, jpgPath],
      schema: judgmentSchema,
      client,
    });
    expect(data).toEqual({ pass: true, critique: 'matches the scene' });
    expect(cost.usdMicros).toBe(1000 * 3 + 100 * 15); // 4500 — same PRICE_TABLE math as structuredCompletion

    const request = create.mock.calls[0][0];
    // Shared forced-tool core: emit tool, forced tool_choice.
    expect(request.tools[0].name).toBe('emit');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    // Content layout: every image block precedes the single trailing text block.
    expect(request.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpgB64 } },
      { type: 'text', text: 'Does this keyframe match the scene intent?' },
    ]);
  });

  it('rejects an unpriced model at zero spend, before the API is called', async () => {
    const { pngPath } = writeImages();
    const { client, create } = fakeClient({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      visionJudgment({ model: 'claude-nonexistent-9', system: 's', prompt: 'p', imagePaths: [pngPath], schema: judgmentSchema, client }),
    ).rejects.toThrow(/visionJudgment: no price table entry for model/);
    expect(create).not.toHaveBeenCalled();
  });

  it('throws on an unsupported image extension without calling the API', async () => {
    const { dir } = writeImages();
    const gifPath = path.join(dir, 'frame.gif');
    writeFileSync(gifPath, Buffer.from([0x47, 0x49, 0x46]));
    const { client, create } = fakeClient({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      visionJudgment({ model: 'claude-sonnet-5', system: 's', prompt: 'p', imagePaths: [gifPath], schema: judgmentSchema, client }),
    ).rejects.toThrow(/visionJudgment: unsupported image extension/);
    expect(create).not.toHaveBeenCalled();
  });

  it('coerces a JSON-stringified nested value via the shared retry path', async () => {
    const { pngPath } = writeImages();
    const listSchema = z.object({ issues: z.array(z.string()) });
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { issues: JSON.stringify(['caption obscures subject']) } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const { data } = await visionJudgment({
      model: 'claude-sonnet-5',
      system: 's',
      prompt: 'p',
      imagePaths: [pngPath],
      schema: listSchema,
      client,
    });
    expect(data).toEqual({ issues: ['caption obscures subject'] });
  });
});
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/providers/anthropic.test.ts`. Expected failure: the file fails at module load with `SyntaxError: The requested module './anthropic.js' does not provide an export named 'visionJudgment'` (vitest may prefix it with `[vite]`). Because the import line errors, all 10 tests in the file are reported failed/unrun — that includes the 6 pre-existing `structuredCompletion` tests; they come back in Step 4.

- [ ] **Step 3: Implement `visionJudgment` and extract the shared forced-tool core.** Replace `src/providers/anthropic.ts` in full with the code below. The diff vs. Plan 1: the body of `structuredCompletion` moves verbatim into an internal `forcedToolCompletion` helper that takes prebuilt user-message `content` (string or content-block array) and a `label` for error-message prefixes; `structuredCompletion` becomes a thin delegation (public signature and error messages unchanged); `visionJudgment` builds image blocks + text and delegates. `PRICE_TABLE`, `costMicros`, and `coerceJsonStrings` are untouched.

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface LlmUsageCost {
  usdMicros: number;
}

// List prices in usd-micros per 1,000,000 tokens.
// NOTE: claude-sonnet-5 has an intro promo of $2/$10 per MTok through 2026-08-31;
// we ledger at the durable list price ($3/$15) so the cost record stays correct
// after the promo ends. ($3/MTok == 3 usd-micros/token; $15/MTok == 15.)
export const PRICE_TABLE: Record<string, { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number }> = {
  'claude-sonnet-5': { inputUsdMicrosPerMTok: 3_000_000, outputUsdMicrosPerMTok: 15_000_000 },
  'claude-haiku-4-5': { inputUsdMicrosPerMTok: 1_000_000, outputUsdMicrosPerMTok: 5_000_000 },
};

type Price = { inputUsdMicrosPerMTok: number; outputUsdMicrosPerMTok: number };

function costMicros(price: Price, inputTokens: number, outputTokens: number): number {
  return (
    Math.round((inputTokens * price.inputUsdMicrosPerMTok) / 1_000_000) +
    Math.round((outputTokens * price.outputUsdMicrosPerMTok) / 1_000_000)
  );
}

// Recursively JSON.parse any string value that looks like a JSON array or
// object, so a model's occasional "nested value serialized as a string"
// quirk doesn't fail validation. Leaves ordinary strings untouched.
function coerceJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // The prefix check is only a cheap filter; JSON.parse rejects the rest.
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
    try {
      return coerceJsonStrings(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(coerceJsonStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, coerceJsonStrings(v)]));
  }
  return value;
}

// Shared forced-tool core for structuredCompletion and visionJudgment. The two
// public functions differ only in how the user message content is built (plain
// prompt string vs image blocks + prompt); everything else — price lookup
// BEFORE the paid call, the forced 'emit' tool, zod validation with the
// coerceJsonStrings retry, cost math — is identical and lives here. `label`
// keeps error messages caller-specific so a failure names its entry point.
async function forcedToolCompletion<T>(opts: {
  label: 'structuredCompletion' | 'visionJudgment';
  model: string;
  system: string;
  content: string | Anthropic.ContentBlockParam[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic;
}): Promise<{ data: T; cost: LlmUsageCost }> {
  const client = opts.client ?? new Anthropic();

  // Resolve the price BEFORE the paid API call: a model absent from PRICE_TABLE
  // must fail at zero spend, not after a real call whose cost can never reach the
  // ledger.
  const price = PRICE_TABLE[opts.model];
  if (!price) throw new Error(`${opts.label}: no price table entry for model "${opts.model}"`);

  // Zod v4 native JSON Schema. `reused: 'inline'` inlines any reused sub-schema so
  // the tool input_schema has no $ref (the Anthropic tool API does not resolve $ref).
  const inputSchema = z.toJSONSchema(opts.schema, { reused: 'inline' }) as Anthropic.Tool.InputSchema;

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    // Disable thinking: forced tool_choice is a deterministic structured
    // extraction, not a reasoning task; avoids the forced-tool/thinking
    // incompatibility and needless thinking-token spend on Sonnet 5.
    thinking: { type: 'disabled' },
    system: opts.system,
    messages: [{ role: 'user', content: opts.content }],
    tools: [
      {
        name: 'emit',
        description: 'Return the structured result. You MUST call this tool exactly once.',
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: 'emit' },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit',
  );
  if (!toolUse) throw new Error(`${opts.label}: no emit tool_use block in response`);

  // Anthropic's tool_choice does not guarantee schema-conformant output (no
  // `strict` mode in this SDK version): models occasionally stringify a
  // nested array/object instead of emitting it structurally. Validate first;
  // only on failure, walk the raw input and JSON.parse any string that looks
  // like a JSON array/object, then re-validate.
  const firstAttempt = opts.schema.safeParse(toolUse.input);
  let data: T;
  if (firstAttempt.success) {
    data = firstAttempt.data;
  } else {
    const retry = opts.schema.safeParse(coerceJsonStrings(toolUse.input));
    // Report the original error: it describes what the model actually sent,
    // not the rewritten value the coercion produced.
    if (!retry.success) throw firstAttempt.error;
    data = retry.data;
  }
  const cost: LlmUsageCost = { usdMicros: costMicros(price, response.usage.input_tokens, response.usage.output_tokens) };
  return { data, cost };
}

export async function structuredCompletion<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  return forcedToolCompletion({
    label: 'structuredCompletion',
    model: opts.model,
    system: opts.system,
    content: opts.prompt,
    schema: opts.schema,
    maxTokens: opts.maxTokens,
    client: opts.client,
  });
}

// media_type by extension. Verified against the Anthropic vision docs
// 2026-07-19: base64 image sources accept image/png, image/jpeg, image/gif,
// image/webp. This pipeline only ever produces PNG keyframes (Task 13) and PNG
// ffmpeg frame grabs (Task 15); jpg/jpeg is tolerated for future inputs, and
// anything else is a programmer error that must fail before any spend.
const IMAGE_MEDIA_TYPES: Record<string, 'image/png' | 'image/jpeg'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export async function visionJudgment<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  imagePaths: string[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  // Content layout: every image block first (base64, media_type by extension),
  // then the text prompt referencing them. Built before delegating so a missing
  // file or unsupported extension fails at zero spend, before any client work.
  const content: Anthropic.ContentBlockParam[] = opts.imagePaths.map((imagePath) => {
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      throw new Error(
        `visionJudgment: unsupported image extension "${ext}" for "${imagePath}" (expected .png, .jpg, or .jpeg)`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: readFileSync(imagePath).toString('base64') },
    };
  });
  content.push({ type: 'text', text: opts.prompt });

  return forcedToolCompletion({
    label: 'visionJudgment',
    model: opts.model,
    system: opts.system,
    content,
    schema: opts.schema,
    maxTokens: opts.maxTokens,
    client: opts.client,
  });
}
```

- [ ] **Step 4: Run the test expecting pass.** Command: `pnpm vitest run src/providers/anthropic.test.ts`. Expected: `Tests  10 passed (10)` — the 6 pre-existing `structuredCompletion` tests prove the extraction changed no public behavior, the 4 new ones cover `visionJudgment` (block layout + cost, unpriced model at zero spend, unsupported extension at zero spend, shared coercion retry).

- [ ] **Step 5: Full suite and build.** Commands: `pnpm test` then `pnpm build`. Expected: every unit test green (no network — the new tests use only an injected fake client and temp files), and both `tsc --noEmit` and `tsc -p remotion --noEmit` clean. `src/providers/anthropic.contract.test.ts` is excluded from `pnpm test` by vitest.config.ts but still type-checks under `pnpm build` — it compiles unchanged because `structuredCompletion`'s signature is unchanged.

- [ ] **Step 6: Commit.** Command: `git add src/providers/anthropic.ts src/providers/anthropic.test.ts && git commit -m "feat: add visionJudgment vision check to anthropic provider"`.

---

---

### Task 8: fal.ai provider adapter (+ contract tests)

**Files:**
- Create: `src/providers/fal.ts`, `src/providers/fal.test.ts`, `src/providers/fal.contract.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (add `@fal-ai/client` — the one new runtime dependency this plan allows)
- Test: `src/providers/fal.test.ts` (unit, zero network), `src/providers/fal.contract.test.ts` (real fal.ai calls, `CONTRACT=1` only; Kling additionally behind `CONTRACT_PREMIUM=1`)

**Interfaces:**
- Consumes: `probe(file: string): Promise<MediaProbe>` from `src/media/ffmpeg.js` (contract test only); the `fal` singleton from `@fal-ai/client` (reads `FAL_KEY` from env on its own); global `fetch` (Node ≥22) for asset downloads; `encodePcmWav` is NOT needed here. Budget/ledger integration (`assertBudget`/`recordCost`) deliberately lives in the calling stage (Task 13), exactly as `structuredCompletion` leaves it to the script stage — this adapter only *prices* and *executes*.
- Produces (binding, per the Interface Contract; consumed by Task 13 `visuals-premium.ts` and referenced by Task 16 docs):
  ```ts
  export type FalPrice = { kind: 'per-image'; usdMicros: number } | { kind: 'per-second'; usdMicrosPerSecond: number } | { kind: 'per-video'; usdMicros: number }
  export const FAL_PRICE_TABLE: Record<string, FalPrice>
  export function estimateImageCostMicros(model: string): number          // throws if model unknown
  export function estimateVideoCostMicros(model: string, durationSec: number): number  // throws if model unknown
  export interface FalClientLike {
    subscribe(model: string, opts: { input: Record<string, unknown> }): Promise<{ data: Record<string, unknown> }>
    storage: { upload(file: Blob): Promise<string> }
  }
  export async function generateImage(opts: { model: string; prompt: string; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>
  export async function animateImage(opts: { model: string; imagePath: string; motionPrompt: string; durationSec: 5 | 10; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>
  ```

**Verified endpoint facts (fal.ai model pages + queue OpenAPI, checked 2026-07-19):**
- `fal-ai/flux/dev` — input `{ prompt, image_size (preset enum or {width,height}), num_images, output_format ('jpeg'|'png'), ... }`; output `{ images: [{ url, width, height, content_type }], ... }`. Price **$0.025/megapixel, rounded UP to the nearest megapixel**. The 9:16 preset is `image_size: 'portrait_16_9'` (768×1344 ≈ 1.03 MP → bills as 2 MP worst case → $0.05/image).
- `fal-ai/kling-video/v3/standard/image-to-video` — input `{ prompt, start_image_url (required), duration: string "3".."15" (default "5"), generate_audio (default true), ... }`; output `{ video: { url, ... } }`. No `aspect_ratio` field: the clip inherits the start image's aspect (our keyframes are 9:16). Price **$0.084/s audio-off** ($0.126/s audio-on — we always send `generate_audio: false`; clips are muted in assembly anyway).
- `fal-ai/minimax/hailuo-02/standard/image-to-video` — input `{ prompt, image_url (required), duration: "6"|"10" (default "6"), resolution: "512P"|"768P" (default "768P"), prompt_optimizer (default true) }`; output `{ video: { url, ... } }`. Price **~$0.017/s at 512P** ($0.045/s at 768P). The adapter pins `512P`: this endpoint is the designated cheap-run/contract-test model, not the premium default. There is no 5s option — a 5s request maps to (and bills as) 6s.
- `@fal-ai/client` latest is **1.10.1**; `import { fal } from '@fal-ai/client'`; `fal.subscribe(endpointId, { input })` resolves `{ data, requestId }`; `fal.storage.upload(blob)` resolves a URL string; credentials auto-read from `FAL_KEY`.
- Note vs. the design-doc cost sketch: the era of "$0.02–0.05/video" MiniMax (Video-01, 2025) is gone; the cheapest real MiniMax clip today is 6s × $0.017 ≈ **$0.10**, so the `CONTRACT=1` tier for this task spends ~**$0.15** total (FLUX + MiniMax), not <$0.10.

**Steps:**

- [ ] **Step 1: Add the `@fal-ai/client` dependency.** From the repo root:
```bash
pnpm add @fal-ai/client
```
Expect `package.json` to gain `"@fal-ai/client": "^1.10.1"` (1.10.1 is latest as of 2026-07-19; record whatever version pnpm actually installs). Verify nothing broke — no source imports it yet:
```bash
pnpm test && pnpm build
```
Both green (whole suite as left by Task 7, both tsc passes). Commit — put the installed version in the body:
```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @fal-ai/client for fal.ai image/video generation" -m "@fal-ai/client 1.10.1 (latest at install time, 2026-07-19)"
```

- [ ] **Step 2: Write the failing unit tests.** Create `src/providers/fal.test.ts`. All tests inject a fake client and stub global `fetch` — the real `@fal-ai/client` singleton and the network are never touched (the `FAL_KEY` test proves the no-client path fails before any I/O):
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  estimateImageCostMicros,
  estimateVideoCostMicros,
  generateImage,
  animateImage,
  type FalClientLike,
} from './fal.js';

const FLUX = 'fal-ai/flux/dev';
const KLING = 'fal-ai/kling-video/v3/standard/image-to-video';
const MINIMAX = 'fal-ai/minimax/hailuo-02/standard/image-to-video';

function fakeFal(data: Record<string, unknown>): {
  client: FalClientLike;
  subscribe: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
} {
  const subscribe = vi.fn().mockResolvedValue({ data });
  const upload = vi.fn().mockResolvedValue('https://fal.storage/uploaded-keyframe.png');
  return { client: { subscribe, storage: { upload } } as unknown as FalClientLike, subscribe, upload };
}

// Arbitrary bytes standing in for a downloaded asset.
const FILE_BYTES = new Uint8Array([137, 80, 78, 71]);

function stubDownload(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => FILE_BYTES.buffer,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'brainrot-fal-'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('price estimators', () => {
  it('prices a FLUX keyframe per image', () => {
    expect(estimateImageCostMicros(FLUX)).toBe(50_000); // $0.05 conservative ($0.025/MP, portrait_16_9 rounds to 2 MP)
  });

  it('prices Kling per second of requested duration', () => {
    expect(estimateVideoCostMicros(KLING, 5)).toBe(420_000); // 5 x $0.084
    expect(estimateVideoCostMicros(KLING, 10)).toBe(840_000); // 10 x $0.084
  });

  it('prices MiniMax per billed second — a 5s request renders 6s', () => {
    expect(estimateVideoCostMicros(MINIMAX, 5)).toBe(102_000); // 6 x $0.017 (endpoint has no 5s option)
    expect(estimateVideoCostMicros(MINIMAX, 10)).toBe(170_000); // 10 x $0.017
  });

  it('throws on a model missing from the price table', () => {
    expect(() => estimateImageCostMicros('fal-ai/nope')).toThrow(/no price table entry/);
    expect(() => estimateVideoCostMicros('fal-ai/nope', 5)).toThrow(/no price table entry/);
  });

  it('throws when the price kind does not match the operation', () => {
    expect(() => estimateImageCostMicros(KLING)).toThrow(/not priced per-image/);
    expect(() => estimateVideoCostMicros(FLUX, 5)).toThrow(/not priced per-second/);
  });
});

describe('generateImage', () => {
  it('sends a FLUX-family 9:16 input and downloads the image to outPath', async () => {
    const { client, subscribe } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    const fetchMock = stubDownload();
    const outPath = path.join(tmpDir(), 'scene-01.png');

    const result = await generateImage({ model: FLUX, prompt: 'a moody lighthouse', outPath, client });

    expect(subscribe).toHaveBeenCalledWith(FLUX, {
      input: { prompt: 'a moody lighthouse', image_size: 'portrait_16_9', num_images: 1, output_format: 'png' },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://fal.cdn/img.png');
    expect(readFileSync(outPath)).toEqual(Buffer.from(FILE_BYTES));
    expect(result.costUsdMicros).toBe(50_000);
  });

  it('rejects an unpriced model before any client call', async () => {
    const { client, subscribe } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    const fetchMock = stubDownload();
    await expect(
      generateImage({ model: 'fal-ai/unknown-image', prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/no price table entry/);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the response carries no image url', async () => {
    const { client } = fakeFal({ images: [] });
    stubDownload();
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/no image url/);
  });

  it('throws when the asset download fails', async () => {
    const { client } = fakeFal({ images: [{ url: 'https://fal.cdn/img.png' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png'), client }),
    ).rejects.toThrow(/403/);
  });

  it('fails fast when FAL_KEY is missing and no client is injected', async () => {
    vi.stubEnv('FAL_KEY', undefined);
    const fetchMock = stubDownload();
    await expect(
      generateImage({ model: FLUX, prompt: 'p', outPath: path.join(tmpDir(), 'x.png') }),
    ).rejects.toThrow(/FAL_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('animateImage', () => {
  async function writeKeyframe(): Promise<string> {
    const p = path.join(tmpDir(), 'scene-01.png');
    await writeFile(p, Buffer.from([1, 2, 3]));
    return p;
  }

  it('uploads the keyframe and sends Kling input with audio off', async () => {
    const { client, subscribe, upload } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    const fetchMock = stubDownload();
    const imagePath = await writeKeyframe();
    const outPath = path.join(tmpDir(), 'scene-01.mp4');

    const result = await animateImage({ model: KLING, imagePath, motionPrompt: 'slow dolly in', durationSec: 10, outPath, client });

    expect(upload).toHaveBeenCalledTimes(1);
    const uploaded = upload.mock.calls[0][0];
    expect(uploaded).toBeInstanceOf(Blob);
    expect(uploaded.type).toBe('image/png');
    expect(subscribe).toHaveBeenCalledWith(KLING, {
      input: {
        prompt: 'slow dolly in',
        start_image_url: 'https://fal.storage/uploaded-keyframe.png',
        duration: '10',
        generate_audio: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://fal.cdn/clip.mp4');
    expect(readFileSync(outPath)).toEqual(Buffer.from(FILE_BYTES));
    expect(result.costUsdMicros).toBe(840_000);
  });

  it('maps a 5s request to MiniMax 6s input at 512P', async () => {
    const { client, subscribe } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    stubDownload();
    const imagePath = await writeKeyframe();
    const outPath = path.join(tmpDir(), 'scene-01.mp4');

    const result = await animateImage({ model: MINIMAX, imagePath, motionPrompt: 'gentle zoom', durationSec: 5, outPath, client });

    expect(subscribe).toHaveBeenCalledWith(MINIMAX, {
      input: {
        prompt: 'gentle zoom',
        image_url: 'https://fal.storage/uploaded-keyframe.png',
        duration: '6',
        resolution: '512P',
        prompt_optimizer: false,
      },
    });
    expect(result.costUsdMicros).toBe(102_000);
  });

  it('rejects an unpriced model before upload or subscribe', async () => {
    const { client, subscribe, upload } = fakeFal({ video: { url: 'https://fal.cdn/clip.mp4' } });
    stubDownload();
    const imagePath = await writeKeyframe();
    await expect(
      animateImage({ model: 'fal-ai/unknown-video', imagePath, motionPrompt: 'm', durationSec: 5, outPath: path.join(tmpDir(), 'x.mp4'), client }),
    ).rejects.toThrow(/no price table entry/);
    expect(upload).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('throws when the response carries no video url', async () => {
    const { client } = fakeFal({});
    stubDownload();
    const imagePath = await writeKeyframe();
    await expect(
      animateImage({ model: KLING, imagePath, motionPrompt: 'm', durationSec: 5, outPath: path.join(tmpDir(), 'x.mp4'), client }),
    ).rejects.toThrow(/no video url/);
  });
});
```

- [ ] **Step 3: Run the test, expect failure.** `pnpm vitest run src/providers/fal.test.ts` → the whole file fails at import: `Failed to resolve import "./fal.js" from "src/providers/fal.test.ts"` (the module does not exist yet).

- [ ] **Step 4: Implement `src/providers/fal.ts`.** Full file:
```ts
import { readFile, writeFile } from 'node:fs/promises';
import { fal } from '@fal-ai/client';

export type FalPrice =
  | { kind: 'per-image'; usdMicros: number }
  | { kind: 'per-second'; usdMicrosPerSecond: number }
  | { kind: 'per-video'; usdMicros: number };

// List prices verified against fal.ai model pages on 2026-07-19. fal responses
// carry no billing data, so the ledger records these list prices.
export const FAL_PRICE_TABLE: Record<string, FalPrice> = {
  // $0.025/megapixel, billed by rounding UP to the nearest megapixel
  // (fal.ai/models/fal-ai/flux/dev, checked 2026-07-19). The adapter requests
  // the portrait_16_9 preset (768x1344 ~= 1.03 MP), which bills as 2 MP in the
  // worst case -> $0.05/image. Ledger at the worst-case rounding so recorded
  // cost never understates real spend.
  'fal-ai/flux/dev': { kind: 'per-image', usdMicros: 50_000 },
  // $0.084/second with generate_audio=false — audio-on bills $0.126/s and our
  // clips are muted in assembly anyway (fal.ai/models/fal-ai/kling-video/v3/
  // standard/image-to-video, checked 2026-07-19).
  'fal-ai/kling-video/v3/standard/image-to-video': { kind: 'per-second', usdMicrosPerSecond: 84_000 },
  // ~$0.017/second at the 512P resolution this adapter pins for the endpoint
  // (768P bills $0.045/s; fal.ai/models/fal-ai/minimax/hailuo-02/standard/
  // image-to-video, checked 2026-07-19). Designated cheap-run + contract-test
  // model — the premium default is Kling above.
  'fal-ai/minimax/hailuo-02/standard/image-to-video': { kind: 'per-second', usdMicrosPerSecond: 17_000 },
};

export function estimateImageCostMicros(model: string): number {
  const price = FAL_PRICE_TABLE[model];
  if (!price) throw new Error(`fal: no price table entry for model "${model}"`);
  if (price.kind !== 'per-image') throw new Error(`fal: model "${model}" is not priced per-image`);
  return price.usdMicros;
}

export function estimateVideoCostMicros(model: string, durationSec: number): number {
  const price = FAL_PRICE_TABLE[model];
  if (!price) throw new Error(`fal: no price table entry for model "${model}"`);
  if (price.kind === 'per-second') return price.usdMicrosPerSecond * billedVideoSeconds(model, durationSec);
  if (price.kind === 'per-video') return price.usdMicros;
  throw new Error(`fal: model "${model}" is not priced per-second or per-video`);
}

export interface FalClientLike {
  subscribe(model: string, opts: { input: Record<string, unknown> }): Promise<{ data: Record<string, unknown> }>;
  storage: { upload(file: Blob): Promise<string> };
}

function defaultClient(): FalClientLike {
  // @fal-ai/client reads FAL_KEY from the environment on its own; this check
  // only turns a missing key into an immediate, clearly-named failure instead
  // of a late HTTP 401 from the queue API.
  if (!process.env.FAL_KEY) throw new Error('fal: FAL_KEY is not set (inject a client or add it to .env)');
  return fal as unknown as FalClientLike;
}

async function download(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal: asset download failed with ${res.status} for ${url}`);
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
}

export async function generateImage(opts: {
  model: string;
  prompt: string;
  outPath: string;
  client?: FalClientLike; // injected in tests; defaults to the real fal singleton
}): Promise<{ costUsdMicros: number }> {
  // Price BEFORE the paid call: an unpriced model must fail at zero spend.
  const costUsdMicros = estimateImageCostMicros(opts.model);
  const client = opts.client ?? defaultClient();
  // FLUX-family input shape. 9:16 is hard-coded here: portrait_16_9 (768x1344).
  // png output matches the visuals/scene-NN.png artifact convention.
  const { data } = await client.subscribe(opts.model, {
    input: { prompt: opts.prompt, image_size: 'portrait_16_9', num_images: 1, output_format: 'png' },
  });
  const images = data.images as Array<{ url?: string }> | undefined;
  const url = images?.[0]?.url;
  if (!url) throw new Error(`fal: no image url in response from ${opts.model}`);
  await download(url, opts.outPath);
  return { costUsdMicros };
}

export async function animateImage(opts: {
  model: string;
  imagePath: string;
  motionPrompt: string;
  durationSec: 5 | 10;
  outPath: string;
  client?: FalClientLike; // injected in tests; defaults to the real fal singleton
}): Promise<{ costUsdMicros: number }> {
  // Price BEFORE the paid call: an unpriced model must fail at zero spend.
  const costUsdMicros = estimateVideoCostMicros(opts.model, opts.durationSec);
  const client = opts.client ?? defaultClient();
  const bytes = await readFile(opts.imagePath);
  // Keyframes are always png (visuals/scene-NN.png artifact convention).
  const imageUrl = await client.storage.upload(new Blob([bytes], { type: 'image/png' }));
  const { data } = await client.subscribe(opts.model, {
    input: videoInput(opts.model, imageUrl, opts.motionPrompt, opts.durationSec),
  });
  const video = data.video as { url?: string } | undefined;
  if (!video?.url) throw new Error(`fal: no video url in response from ${opts.model}`);
  await download(video.url, opts.outPath);
  return { costUsdMicros };
}

// Per-endpoint input naming (schemas verified 2026-07-19 via each endpoint's
// queue OpenAPI). Both endpoints derive the clip's aspect ratio from the input
// image, so 9:16 comes from the 9:16 keyframe — no aspect field exists.
function videoInput(model: string, imageUrl: string, motionPrompt: string, durationSec: 5 | 10): Record<string, unknown> {
  if (model.startsWith('fal-ai/kling-video/')) {
    // Kling v3 i2v: duration is a string "3".."15"; audio off — narration owns
    // the audio track, and audio-on bills 50% more per second.
    return { prompt: motionPrompt, start_image_url: imageUrl, duration: String(durationSec), generate_audio: false };
  }
  if (model.startsWith('fal-ai/minimax/')) {
    // Hailuo-02 i2v: duration only allows "6" | "10" — a 5s request maps up to
    // 6s (billedVideoSeconds applies the same mapping so the ledger matches).
    // 512P pinned: this is the cheap-run model. prompt_optimizer off: motion
    // prompts are authored by the script stage; keep them verbatim.
    return {
      prompt: motionPrompt,
      image_url: imageUrl,
      duration: durationSec === 5 ? '6' : '10',
      resolution: '512P',
      prompt_optimizer: false,
    };
  }
  throw new Error(`fal: no input builder for model "${model}"`);
}

function billedVideoSeconds(model: string, durationSec: number): number {
  // Hailuo-02 only renders 6s or 10s; a 5s request renders (and bills) 6s.
  if (model.startsWith('fal-ai/minimax/') && durationSec === 5) return 6;
  return durationSec;
}
```

- [ ] **Step 5: Run the test, expect pass.** `pnpm vitest run src/providers/fal.test.ts` → 14 passing. Then the full gates:
```bash
pnpm test && pnpm build
```
All green (the whole suite green including this task's 14 new fal tests; both tsc passes). Commit:
```bash
git add src/providers/fal.ts src/providers/fal.test.ts
git commit -m "feat: add fal.ai provider adapter with priced image and video generation"
```

- [ ] **Step 6: Write the contract tests.** Create `src/providers/fal.contract.test.ts`. Tests within one file run in declaration order, so the MiniMax and Kling tests reuse the FLUX keyframe — contract spend stays at one image + one (or two) clips:
```ts
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateImage, animateImage } from './fal.js';
import { probe } from '../media/ffmpeg.js';

// Runs only via `pnpm test:contract` (CONTRACT=1; excluded from default
// `pnpm test`). Makes real fal.ai calls; needs FAL_KEY (shell env or .env —
// loaded here because vitest does not read .env on its own).
// Spend: FLUX keyframe $0.05 + MiniMax 512P 6s clip ~$0.10 => ~$0.15.
// The Kling block adds ~$0.42 and only runs when CONTRACT_PREMIUM=1 is also set.
const dir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-fal-contract-'));
const keyframePath = path.join(dir, 'keyframe.png');

describe('fal adapter (contract)', () => {
  it('generates a real FLUX 9:16 keyframe', async () => {
    const { costUsdMicros } = await generateImage({
      model: 'fal-ai/flux/dev',
      prompt: 'A lighthouse on a rocky cliff at dusk, dramatic clouds, cinematic lighting, vertical composition',
      outPath: keyframePath,
    });
    // A real 768x1344 png is far larger than any error payload could be.
    expect(statSync(keyframePath).size).toBeGreaterThan(50_000);
    expect(costUsdMicros).toBe(50_000);
  }, 180_000);

  it('animates the keyframe via MiniMax into a decodable 9:16 clip', async () => {
    const outPath = path.join(dir, 'clip-minimax.mp4');
    const { costUsdMicros } = await animateImage({
      model: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
      imagePath: keyframePath,
      motionPrompt: 'slow gentle zoom toward the lighthouse, clouds drifting',
      durationSec: 5,
      outPath,
    });
    const clip = await probe(outPath);
    expect(clip.durationMs).toBeGreaterThanOrEqual(4_000); // a 5s request renders ~6s on this endpoint
    expect(clip.height).toBeGreaterThan(clip.width); // 9:16 inherited from the keyframe
    expect(costUsdMicros).toBe(102_000);
  }, 600_000);
});

// A real Kling v3 standard clip costs ~$0.42 — opt in separately.
describe.skipIf(process.env.CONTRACT_PREMIUM !== '1')('fal adapter (contract, premium)', () => {
  it('animates the keyframe via Kling v3 standard', async () => {
    const outPath = path.join(dir, 'clip-kling.mp4');
    const { costUsdMicros } = await animateImage({
      model: 'fal-ai/kling-video/v3/standard/image-to-video',
      imagePath: keyframePath,
      motionPrompt: 'slow dolly toward the lighthouse as waves crash below',
      durationSec: 5,
      outPath,
    });
    const clip = await probe(outPath);
    expect(clip.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(clip.height).toBeGreaterThan(clip.width);
    expect(costUsdMicros).toBe(420_000);
  }, 600_000);
});
```

- [ ] **Step 7: Verify gating, then run the cheap contract tier for real.** First prove the default suite still never sees the contract file:
```bash
pnpm test
```
→ whole suite green, `fal.contract.test.ts` absent from the reported files (vitest.config.ts excludes `src/**/*.contract.test.ts` unless `CONTRACT=1`). Then, with `FAL_KEY` in `.env` or the shell, spend ~$0.15 to validate the real plumbing:
```bash
CONTRACT=1 pnpm vitest run src/providers/fal.contract.test.ts
```
→ 2 passing, 1 skipped (the Kling describe) — video generation takes minutes; the 600s per-test timeouts cover it. Optionally also prove the premium path (~$0.42 extra): `CONTRACT=1 CONTRACT_PREMIUM=1 pnpm vitest run src/providers/fal.contract.test.ts` → 3 passing. If `FAL_KEY` is not provisioned yet, skip the real run — Task 16's branch-end proof re-runs it — but the file must still typecheck in the next step.

- [ ] **Step 8: Final gates and commit.**
```bash
pnpm test && pnpm build
```
Both green (`pnpm build` typechecks the contract file via `tsc --noEmit` even though vitest skips it). Commit:
```bash
git add src/providers/fal.contract.test.ts
git commit -m "test: add fal.ai contract tests behind CONTRACT=1 (kling behind CONTRACT_PREMIUM=1)"
```

---

### Task 9: ElevenLabs provider adapter (+ contract test)

**Files:**
- Create: `src/providers/elevenlabs.ts`
- Test: `src/providers/elevenlabs.test.ts`, `src/providers/elevenlabs.contract.test.ts`

**Interfaces:**
- Consumes: `encodePcmWav(parts: Buffer[], sampleRate: number, channels: number): Buffer` and `parseWavDurationMs(buf: Buffer): number` from `src/media/wav.ts` (existing, unchanged); `WordTiming` (`{ word: string; startMs: number; endMs: number }`) from `src/providers/whisperx.ts` (existing); Node 22 globals `fetch` / `Response` / `AbortSignal.timeout`. Tests additionally use `parseWav(buf: Buffer): ParsedWav` from `src/media/wav.ts`.
- Produces (consumed by Task 11's voice stage; env var documented by Task 16):
  ```ts
  // src/providers/elevenlabs.ts
  export const ELEVENLABS_USD_MICROS_PER_1K_CHARS = 300_000
  export function estimateTtsCostMicros(text: string): number
  export async function synthWithTimestamps(opts: {
    voiceId: string; modelId: string; text: string; apiKey?: string; fetchImpl?: typeof fetch
  }): Promise<{ wavBytes: Buffer; durationMs: number; words: WordTiming[]; costUsdMicros: number }>
  ```

> The adapter is deliberately ledger-free: it never touches the DB. `assertBudget` (before, using `estimateTtsCostMicros`) and `recordCost('elevenlabs', 'tts', ...)` (after) are the voice stage's job (Task 11). External facts baked in below were verified 2026-07-19: endpoint `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps` with `output_format=pcm_24000` as a valid query value and response fields `audio_base64` + nullable `alignment { characters, character_start_times_seconds, character_end_times_seconds }` (elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps); Creator-plan overage price $0.30 per 1,000 characters (elevenlabs.io/pricing).

**Steps:**

- [ ] **Step 1: Write the failing pricing test.** Create `src/providers/elevenlabs.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ELEVENLABS_USD_MICROS_PER_1K_CHARS, estimateTtsCostMicros } from './elevenlabs.js';

describe('estimateTtsCostMicros', () => {
  it('charges the per-1k-character overage rate with ceil rounding', () => {
    expect(ELEVENLABS_USD_MICROS_PER_1K_CHARS).toBe(300_000);
    expect(estimateTtsCostMicros('a'.repeat(1000))).toBe(300_000); // exactly $0.30
    expect(estimateTtsCostMicros('ab')).toBe(600); // ceil(2 * 300_000 / 1000)
    expect(estimateTtsCostMicros('')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, expect failure.** `pnpm vitest run src/providers/elevenlabs.test.ts` → the suite fails to collect: `Error: Failed to load url ./elevenlabs.js (resolved id: ./elevenlabs.js) ... Does the file exist?` (`src/providers/elevenlabs.ts` does not exist yet).

- [ ] **Step 3: Implement pricing, run the test, expect pass.** Create `src/providers/elevenlabs.ts`:
```ts
// ElevenLabs bills TTS per character. $0.30 per 1,000 characters is the
// Creator-plan overage rate (verified 2026-07-19 against elevenlabs.io/pricing:
// Creator $0.30/1k, Pro $0.24/1k, Scale $0.18/1k). Subscription credits make the
// marginal character cheaper in practice, but the Creator overage rate is the
// durable worst case, so the ledger stays honest once included credits run out —
// same rationale as anthropic.ts ledgering list price through the sonnet-5 promo.
export const ELEVENLABS_USD_MICROS_PER_1K_CHARS = 300_000;

// Ceil per-character: a budget estimate must never under-reserve for a paid call.
export function estimateTtsCostMicros(text: string): number {
  return Math.ceil((text.length * ELEVENLABS_USD_MICROS_PER_1K_CHARS) / 1000);
}
```
Run `pnpm vitest run src/providers/elevenlabs.test.ts` → `Tests  1 passed (1)`.

- [ ] **Step 4: Write the failing synthesis tests.** Replace `src/providers/elevenlabs.test.ts` with the full suite (the pricing test is unchanged at the top; the fixture mimics a recorded `/with-timestamps` response for the text `'Hi,  there!'` — note the double space):
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseWav } from '../media/wav.js';
import { ELEVENLABS_USD_MICROS_PER_1K_CHARS, estimateTtsCostMicros, synthWithTimestamps } from './elevenlabs.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Recorded-style /with-timestamps response for the text 'Hi,  there!' (11 chars,
// double space). audio_base64 is 48,000 bytes of 16-bit mono PCM: at 24 kHz that
// is exactly 1000 ms of audio.
const FIXTURE = {
  audio_base64: Buffer.alloc(48_000).toString('base64'),
  alignment: {
    characters: ['H', 'i', ',', ' ', ' ', 't', 'h', 'e', 'r', 'e', '!'],
    character_start_times_seconds: [0, 0.058, 0.116, 0.174, 0.19, 0.209, 0.267, 0.325, 0.383, 0.441, 0.499],
    character_end_times_seconds: [0.058, 0.116, 0.174, 0.19, 0.209, 0.267, 0.325, 0.383, 0.441, 0.499, 0.557],
  },
};

// Injectable fetch: captures every call, answers with one canned JSON response.
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

describe('estimateTtsCostMicros', () => {
  it('charges the per-1k-character overage rate with ceil rounding', () => {
    expect(ELEVENLABS_USD_MICROS_PER_1K_CHARS).toBe(300_000);
    expect(estimateTtsCostMicros('a'.repeat(1000))).toBe(300_000); // exactly $0.30
    expect(estimateTtsCostMicros('ab')).toBe(600); // ceil(2 * 300_000 / 1000)
    expect(estimateTtsCostMicros('')).toBe(0);
  });
});

describe('synthWithTimestamps', () => {
  it('POSTs the synthesis request and returns wav bytes plus grouped word timings', async () => {
    const { impl, calls } = fakeFetch(200, FIXTURE);
    const res = await synthWithTimestamps({
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
      text: 'Hi,  there!',
      apiKey: 'k-test',
      fetchImpl: impl,
    });

    // Request shape: endpoint + PCM output format + auth header + JSON body.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps?output_format=pcm_24000',
    );
    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k-test');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hi,  there!', model_id: 'eleven_multilingual_v2' });

    // The raw PCM is wrapped in a canonical RIFF/WAVE container at 24 kHz mono.
    const wav = parseWav(res.wavBytes);
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.channels).toBe(1);
    expect(wav.data.length).toBe(48_000);
    expect(res.durationMs).toBe(1000);

    // Character runs group into words: punctuation stays attached, the double
    // space produces no empty word, times are integer ms.
    expect(res.words).toEqual([
      { word: 'Hi,', startMs: 0, endMs: 174 },
      { word: 'there!', startMs: 209, endMs: 557 },
    ]);

    // 11 characters at $0.30/1k → ceil(11 * 300_000 / 1000) = 3300 micros.
    expect(res.costUsdMicros).toBe(3300);
  });

  it('returns empty words when the response carries no alignment (audio still usable)', async () => {
    // 4800 PCM bytes at 24 kHz mono 16-bit = 100 ms.
    const { impl } = fakeFetch(200, { audio_base64: Buffer.alloc(4800).toString('base64'), alignment: null });
    const res = await synthWithTimestamps({ voiceId: 'v', modelId: 'm', text: 'x', apiKey: 'k', fetchImpl: impl });
    expect(res.words).toEqual([]);
    expect(res.durationMs).toBe(100);
  });

  it('throws before any network call when no API key is available', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    const { impl, calls } = fakeFetch(200, FIXTURE);
    await expect(
      synthWithTimestamps({ voiceId: 'v', modelId: 'm', text: 'x', fetchImpl: impl }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('throws with the HTTP status on a non-2xx response', async () => {
    const { impl } = fakeFetch(401, { detail: { status: 'invalid_api_key' } });
    await expect(
      synthWithTimestamps({ voiceId: 'v', modelId: 'm', text: 'x', apiKey: 'bad', fetchImpl: impl }),
    ).rejects.toThrow(/elevenlabs responded 401/);
  });
});
```

- [ ] **Step 5: Run the tests, expect failure.** `pnpm vitest run src/providers/elevenlabs.test.ts` → the suite fails to collect: `SyntaxError: The requested module './elevenlabs.js' does not provide an export named 'synthWithTimestamps'`.

- [ ] **Step 6: Implement `synthWithTimestamps`.** Replace `src/providers/elevenlabs.ts` with the complete module:
```ts
import { encodePcmWav, parseWavDurationMs } from '../media/wav.js';
import type { WordTiming } from './whisperx.js';

// ElevenLabs bills TTS per character. $0.30 per 1,000 characters is the
// Creator-plan overage rate (verified 2026-07-19 against elevenlabs.io/pricing:
// Creator $0.30/1k, Pro $0.24/1k, Scale $0.18/1k). Subscription credits make the
// marginal character cheaper in practice, but the Creator overage rate is the
// durable worst case, so the ledger stays honest once included credits run out —
// same rationale as anthropic.ts ledgering list price through the sonnet-5 promo.
export const ELEVENLABS_USD_MICROS_PER_1K_CHARS = 300_000;

// output_format=pcm_24000 returns raw 16-bit little-endian mono PCM at 24 kHz
// with no container, so the adapter wraps it in a RIFF/WAVE header itself.
const PCM_SAMPLE_RATE = 24_000;
const PCM_CHANNELS = 1;
const TIMEOUT_MS = 120_000;

// Ceil per-character: a budget estimate must never under-reserve for a paid call.
export function estimateTtsCostMicros(text: string): number {
  return Math.ceil((text.length * ELEVENLABS_USD_MICROS_PER_1K_CHARS) / 1000);
}

// Wire shape of POST /v1/text-to-speech/{voiceId}/with-timestamps (verified
// 2026-07-19: elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).
// `alignment` is nullable in the published schema; audio can arrive without it.
interface WithTimestampsResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
}

// Group character-level timings into words: every maximal run of non-whitespace
// characters is one word (punctuation stays attached — the same token style
// WhisperX emits, so captions and scene-window matching treat both sources alike).
function groupCharactersIntoWords(alignment: NonNullable<WithTimestampsResponse['alignment']>): WordTiming[] {
  const words: WordTiming[] = [];
  let word = '';
  let startSec = 0;
  let endSec = 0;
  for (let i = 0; i < alignment.characters.length; i++) {
    const ch = alignment.characters[i];
    if (/\s/.test(ch)) {
      if (word) {
        words.push({ word, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) });
        word = '';
      }
      continue;
    }
    if (!word) startSec = alignment.character_start_times_seconds[i];
    word += ch;
    endSec = alignment.character_end_times_seconds[i];
  }
  if (word) words.push({ word, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) });
  return words;
}

export async function synthWithTimestamps(opts: {
  voiceId: string;
  modelId: string;
  text: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ wavBytes: Buffer; durationMs: number; words: WordTiming[]; costUsdMicros: number }> {
  // Resolve the key before any network activity: a missing key must fail fast so
  // the voice stage can fall back to the volume chain at zero spend.
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('synthWithTimestamps: missing ElevenLabs API key (pass opts.apiKey or set ELEVENLABS_API_KEY)');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  // ElevenLabs responses carry no billing data; the ledger records the
  // deterministic per-character list price computed up front.
  const costUsdMicros = estimateTtsCostMicros(opts.text);

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}` +
    `/with-timestamps?output_format=pcm_24000`;

  // Same guard as whisperx.ts: a hung TTS endpoint must not wedge the voice
  // stage forever. Abort after TIMEOUT_MS and rethrow with a named message.
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`synthWithTimestamps: elevenlabs request timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`synthWithTimestamps: elevenlabs responded ${res.status}: ${raw}`);
  }

  const body = (await res.json()) as WithTimestampsResponse;
  const pcm = Buffer.from(body.audio_base64, 'base64');
  const wavBytes = encodePcmWav([pcm], PCM_SAMPLE_RATE, PCM_CHANNELS);
  const durationMs = parseWavDurationMs(wavBytes);
  // No alignment → empty words. The voice stage (Task 11) still writes
  // timings.json; captions treats words.length === 0 as "no provider timings"
  // and falls through to WhisperX, so the paid audio is never wasted.
  const words = body.alignment ? groupCharactersIntoWords(body.alignment) : [];
  return { wavBytes, durationMs, words, costUsdMicros };
}
```

- [ ] **Step 7: Run the tests, expect pass.** `pnpm vitest run src/providers/elevenlabs.test.ts` → `Tests  5 passed (5)`.

- [ ] **Step 8: Add the contract test.** Create `src/providers/elevenlabs.contract.test.ts`:
```ts
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { parseWav } from '../media/wav.js';
import { estimateTtsCostMicros, synthWithTimestamps } from './elevenlabs.js';

// Runs only via `pnpm test:contract` (excluded from default `pnpm test`).
// Makes ONE real ElevenLabs synthesis (39 chars ≈ $0.012 at the Creator overage
// rate); needs ELEVENLABS_API_KEY (shell env or .env — loaded here because
// vitest does not read .env on its own).
describe('synthWithTimestamps (contract)', () => {
  it('synthesizes a short phrase into parseable 24kHz WAV with monotonic word timings', async () => {
    const text = 'The quick brown fox jumps over the dog.'; // 39 chars, 8 words
    expect(estimateTtsCostMicros(text)).toBeLessThan(20_000); // hard guard: < $0.02

    const { wavBytes, durationMs, words, costUsdMicros } = await synthWithTimestamps({
      voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah — public premade voice; same id channels/example.toml uses (Task 5)
      modelId: 'eleven_multilingual_v2',
      text,
    });

    const wav = parseWav(wavBytes);
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.channels).toBe(1);
    expect(durationMs).toBeGreaterThan(1_000); // 8 spoken words cannot fit in under a second

    // Word grouping over real alignment data: near-complete (tolerate one
    // provider-side merge), monotonic, non-overlapping, inside the audio span.
    expect(words.length).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < words.length; i++) {
      expect(words[i].startMs).toBeLessThanOrEqual(words[i].endMs);
      if (i > 0) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].endMs);
    }
    expect(words[words.length - 1].endMs).toBeLessThanOrEqual(durationMs + 100);
    expect(costUsdMicros).toBe(estimateTtsCostMicros(text));
  }, 60_000);
});
```

- [ ] **Step 9: Verify the contract test is excluded from the default run.** `pnpm test` → confirm `elevenlabs.contract.test.ts` does NOT appear in the executed file list (vitest.config.ts excludes `src/**/*.contract.test.ts` unless `CONTRACT=1`) and the whole suite passes. Optional, if `ELEVENLABS_API_KEY` is set: `pnpm test:contract src/providers/elevenlabs.contract.test.ts` → 1 passing, ≈ $0.012 spent (the path filter keeps the other contract tests from firing).

- [ ] **Step 10: Full gate.** `pnpm test` → all suites pass; `pnpm build` → both `tsc --noEmit` and `tsc -p remotion --noEmit` exit clean.

- [ ] **Step 11: Commit.** `git add src/providers/elevenlabs.ts src/providers/elevenlabs.test.ts src/providers/elevenlabs.contract.test.ts && git commit -m "feat: add elevenlabs tts adapter with word timings and per-char pricing"`

---

### Task 10: Scenes script format

**Files:**
- Create: `src/stages/narration-text.test.ts`
- Modify: `src/stages/script.ts`, `src/stages/script.test.ts`, `src/stages/narration-text.ts`
- Test: `src/stages/script.test.ts`, `src/stages/narration-text.test.ts`

**Interfaces:**
- Consumes:
  - `assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void`, `recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void`, `class BudgetExceededError` — `src/jobs/costs.ts` (Task 6 signature; Task 6 already updated the `script.ts` call site to pass `ctx.tier`).
  - `structuredCompletion<T>(opts: { model: string; system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number; client?: Anthropic }): Promise<{ data: T; cost: LlmUsageCost }>` — `src/providers/anthropic.ts` (Plan 1, unchanged by this task).
  - `ChannelConfig` with `premium: PremiumConfig` where `PremiumConfig = { imageModel: string; videoModel: string; stylePrefix?: string; sceneConcurrency: number }` and `budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }` — `src/config/channel.ts` (Task 5).
  - `JobContext` (fields used: `tier`, `db`, `channel`, `jobId`, `topic`, `artifactPath`), `StageDef`, `Tier` — `src/jobs/types.ts`.
  - Test helpers `testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig` (carries the Task 5 premium fields, `premiumPerVideoUsdMicros: 7_000_000`), `makeCtx(channel?: ChannelConfig, topic?: string): JobContext` (hardcodes `tier: 'volume'` — premium tests spread-override it), `testScript(opts?): ScriptOutput` — `src/stages/_testkit.ts`.
- Produces (later tasks rely on these exact names):
  - `export const ScenesOutputSchema` (zod; LLM-facing — deliberately has NO `format` field) — `src/stages/script.ts`.
  - `export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' }` — consumed by Tasks 12 (`computeSceneWindows(script: ScenesOutput, ...)`), 13, 15.
  - `export type ScriptArtifact = ScriptOutput | ScenesOutput` and `export function isScenesOutput(s: ScriptArtifact): s is ScenesOutput` — consumed by Tasks 11, 13, 15.
  - Premium artifact `runs/<jobId>/script/script.json` = the validated scenes payload stamped `{ ...data, format: 'scenes' }`. Volume `script.json` stays byte-identical to Plan 1 (no `format` field).
  - `narrationText(script: ScriptArtifact): string` and `narrationWordCount(script: ScriptArtifact): number` — `src/stages/narration-text.ts`. Scenes composition is EXACTLY `[hook, ...scenes.map(s => s.narration)].join(' ')` (single spaces); Task 12's scene-boundary matching re-derives per-scene token positions from this exact composition. Story composition stays `[hook, ...segments.map(s => s.text)].join('\n\n')`, unchanged.
  - `createScriptStage(client?: Anthropic): StageDef`, `scriptStage`, `ESTIMATED_SCRIPT_COST_MICROS` — names and shapes unchanged (Task 16's CLI uses `scriptStage` for both tiers).

**Steps:**

- [ ] **Step 1: Write failing scenes tests in `src/stages/script.test.ts`.** Two edits to the existing file. First, extend the import from `./script.js` (currently `import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS } from './script.js';`) to:

```ts
import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS, ScenesOutputSchema, isScenesOutput } from './script.js';
```

Then append the following at the end of the file (after the existing `describe('scriptStage', ...)` block). It reuses the file's existing `fakeClient` helper and the `fs`, `makeCtx`, `testChannel`, `BudgetExceededError` imports — no other imports change. Note: `makeCtx` creates the job row with tier `'volume'`; `premiumCtx` overrides only `ctx.tier`, which is fine because nothing in the script stage reads the job row's tier column.

```ts
const VALID_SCENES = {
  hook: 'The ocean hides a second sun',
  styleBlock:
    'Muted teal and amber palette, painterly digital illustration, melancholy documentary mood, soft volumetric light filtering down through deep water.',
  scenes: [
    { narration: 'Sunlight only reaches the top two hundred meters of the ocean.', visualPrompt: 'A shaft of sunlight piercing dark blue open water, small fish silhouetted, wide composition', motionPrompt: 'slow push-in' },
    { narration: 'Below that, life makes its own light.', visualPrompt: 'A bioluminescent jellyfish glowing blue-green in pitch-black water, centered composition', motionPrompt: 'jellyfish pulsing gently' },
    { narration: 'Nine in ten deep-sea animals can glow.', visualPrompt: 'A field of scattered glowing creatures across a dark abyssal plain, wide shot', motionPrompt: 'lights twinkling in sequence' },
    { narration: 'They flash to hunt, to hide, and to find each other.', visualPrompt: 'An anglerfish with a glowing lure in total darkness, close-up composition', motionPrompt: 'lure swaying slowly' },
    { narration: 'The deep ocean is the largest lit stage on Earth.', visualPrompt: 'A vast dark seascape speckled with countless points of living light, extreme wide shot', motionPrompt: 'slow drift upward' },
  ],
  platformMeta: {
    youtube: { title: 'The Ocean Makes Its Own Light', description: 'Most deep-sea animals glow. Here is why.', hashtags: ['#ocean', '#science', '#deepsea'] },
    tiktok: { title: 'The ocean glows in the dark', description: 'Nine in ten deep-sea animals make their own light.', hashtags: ['#ocean', '#deepsea'] },
    instagram: { title: 'Why the deep ocean glows', description: 'Bioluminescence is the rule down there, not the exception.', hashtags: ['#ocean', '#science'] },
  },
};

// makeCtx hardcodes tier 'volume'; the script stage only reads ctx.tier (never
// the jobs row's tier column), so overriding the context field is sufficient.
function premiumCtx(channel = testChannel()) {
  return { ...makeCtx(channel), tier: 'premium' as const };
}

describe('ScenesOutputSchema', () => {
  it('accepts a scenes payload and rejects one missing styleBlock', () => {
    expect(ScenesOutputSchema.safeParse(VALID_SCENES).success).toBe(true);
    const { styleBlock: _omitted, ...noStyle } = VALID_SCENES;
    expect(ScenesOutputSchema.safeParse(noStyle).success).toBe(false);
  });

  it('isScenesOutput discriminates format-stamped artifacts from story artifacts', () => {
    expect(isScenesOutput({ ...VALID_SCENES, format: 'scenes' })).toBe(true);
    expect(isScenesOutput(VALID_SCRIPT)).toBe(false);
  });
});

describe('scriptStage (premium scenes)', () => {
  it('writes a format-stamped scenes script.json, records cost, and sends the scenes emit schema', async () => {
    const ctx = premiumCtx();
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 500, output_tokens: 800 },
    });
    await createScriptStage(client).run(ctx);

    const written = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'));
    expect(written).toEqual({ ...VALID_SCENES, format: 'scenes' });

    const rows = ctx.db.prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?').all(ctx.jobId);
    expect(rows).toEqual([{ provider: 'anthropic', operation: 'script', usd_micros: 500 * 3 + 800 * 15 }]);

    const sentArgs = create.mock.calls[0][0];
    expect(sentArgs.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    expect(sentArgs.max_tokens).toBe(4096);
    expect(sentArgs.system).toContain('scenes format');
    const sentTool = sentArgs.tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.required).toEqual(
      expect.arrayContaining(['hook', 'styleBlock', 'scenes', 'platformMeta']),
    );
    // The LLM never sees `format`: the stage stamps it after validation.
    expect(sentTool.input_schema.required).not.toContain('format');
    expect(Object.keys(sentTool.input_schema.properties)).not.toContain('format');
    // The prompt carries the constraints that keep spoken scenes coverable by 10s clips.
    expect(sentArgs.messages[0].content).toContain('at most 18 words');
    expect(sentArgs.messages[0].content).toContain('5 to 8 scenes');
  });

  it('seeds the styleBlock instruction with channel.premium.stylePrefix when set', async () => {
    const base = testChannel();
    const ctx = premiumCtx(
      testChannel({ premium: { ...base.premium, stylePrefix: 'gritty 1980s VHS documentary' } }),
    );
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createScriptStage(client).run(ctx);
    expect(create.mock.calls[0][0].messages[0].content).toContain('gritty 1980s VHS documentary');
  });

  it('uses a generic style instruction when stylePrefix is absent', async () => {
    const base = testChannel();
    // Build premium explicitly without stylePrefix so this test cannot be
    // affected by whatever default testChannel carries.
    const ctx = premiumCtx(
      testChannel({
        premium: {
          imageModel: base.premium.imageModel,
          videoModel: base.premium.videoModel,
          sceneConcurrency: base.premium.sceneConcurrency,
        },
      }),
    );
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCENES }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await createScriptStage(client).run(ctx);
    const prompt = create.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Choose a visual style that fits the topic');
    expect(prompt).not.toContain('style seed');
  });

  it('throws BudgetExceededError against the premium per-video cap before calling the API', async () => {
    // Volume cap stays wide open (8M micros); only the premium cap (1 micro) can
    // trip — proving the stage passes ctx.tier into the Task 6 assertBudget.
    const ctx = premiumCtx(
      testChannel({
        budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 1, perDayUsdMicros: 20_000_000 },
      }),
    );
    const { client, create } = fakeClient({});
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, expect failure.** `pnpm vitest run src/stages/script.test.ts` → the whole file errors at import time with `SyntaxError: The requested module './script.js' does not provide an export named 'ScenesOutputSchema'` (vitest transforms TS to ESM; `ScenesOutputSchema` and `isScenesOutput` do not exist yet). All tests in the file report as errored/failed.

- [ ] **Step 3: Implement the scenes format in `src/stages/script.ts`.** Replace the file's entire contents with the version below. Diff vs the current file: `platformMetaSchema` extracted (shared by both formats — JSON Schema output of `ScriptOutputSchema` is unchanged), `ScenesOutputSchema`/`ScenesOutput`/`ScriptArtifact`/`isScenesOutput` added, `buildScenesSystem`/`buildScenesPrompt` added, and `run()` gains the tier branch. The `assertBudget(..., ctx.tier)` call is exactly what Task 6 already left in place. The volume branch's behavior and its written `script.json` are byte-identical to before.

```ts
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { StageDef, JobContext } from '../jobs/types.js';
import { assertBudget, recordCost } from '../jobs/costs.js';
import { structuredCompletion } from '../providers/anthropic.js';

// Pre-flight budget reservation for the script LLM call (~$0.02). assertBudget
// blocks the stage if the job or day is already too close to its cap.
export const ESTIMATED_SCRIPT_COST_MICROS = 20_000;

const platformEntrySchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
});

// Shared by both output formats: platformMeta rules are identical for story
// and scenes scripts.
const platformMetaSchema = z.object({
  youtube: platformEntrySchema,
  tiktok: platformEntrySchema,
  instagram: platformEntrySchema,
});

// Mirrors the contract's ScriptOutput exactly (no length constraints — those
// are enforced by the prompt, keeping the tool input_schema constraint-free).
export const ScriptOutputSchema = z.object({
  hook: z.string(),
  segments: z.array(z.object({ text: z.string(), visualDirection: z.string() })),
  platformMeta: platformMetaSchema,
});

export type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

// LLM-facing schema for the premium `scenes` format. Deliberately carries NO
// `format` field: the model never sees or emits it. The stage stamps
// `format: 'scenes'` onto the validated payload when writing script.json so
// downstream stages can discriminate the two artifact shapes; volume
// script.json stays exactly as in Plan 1 (no format field).
export const ScenesOutputSchema = z.object({
  hook: z.string(),
  styleBlock: z.string(),
  scenes: z.array(
    z.object({ narration: z.string(), visualPrompt: z.string(), motionPrompt: z.string() }),
  ),
  platformMeta: platformMetaSchema,
});

export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' };
export type ScriptArtifact = ScriptOutput | ScenesOutput;

export function isScenesOutput(s: ScriptArtifact): s is ScenesOutput {
  return 'format' in s && s.format === 'scenes';
}

function buildSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the story format: one strong hook, then a single narrative arc across the segments.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ');
}

function buildPrompt(topic: string, niche: string[]): string {
  return `Write a short-form video script about: ${topic}

Niche: ${niche.join(', ')}

Story-format requirements:
- hook: one line, at most 10 words, that stops the scroll. No emojis.
- segments: 4 to 8 segments forming one narrative arc. Each segment has:
  - text: 1 to 3 sentences of spoken narration. Plain and conversational, no stage directions.
  - visualDirection: a short phrase (3 to 8 words) naming the on-screen background visual for that segment.
- platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
  - title: at most 90 characters. No emojis.
  - description: 1 to 2 plain-spoken sentences. No emojis.
  - hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`;
}

function buildScenesSystem(niche: string[]): string {
  return [
    `You are an expert short-form video scriptwriter for the "${niche.join(', ')}" niche.`,
    'You write punchy, retention-optimized narration for 9:16 vertical videos published to YouTube Shorts, TikTok, and Instagram Reels.',
    'Use the scenes format: one strong hook, a single visual style for the whole video, then a sequence of scenes, each pairing spoken narration with an AI image-generation prompt and a motion prompt.',
    'Return your answer ONLY by calling the `emit` tool. Never write prose or markdown.',
  ].join(' ');
}

function buildScenesPrompt(topic: string, niche: string[], stylePrefix?: string): string {
  const styleSeed = stylePrefix
    ? `Base the styleBlock on this channel style seed, keeping it clearly recognizable: ${stylePrefix}`
    : 'Choose a visual style that fits the topic and niche.';
  return `Write a scene-based short-form video script about: ${topic}

Niche: ${niche.join(', ')}

Scenes-format requirements:
- hook: one line, at most 10 words, that stops the scroll. No emojis.
- styleBlock: one paragraph defining the video's consistent visual identity — palette, medium, mood, and lighting. Every scene's keyframe image is generated with this exact paragraph prepended, so it must read as a reusable style description, not scene content. ${styleSeed}
- scenes: 5 to 8 scenes forming one narrative arc. Each scene has:
  - narration: 1 to 2 sentences of spoken narration, at most 18 words total, so the spoken scene fits inside a 10-second clip. Plain and conversational, no stage directions.
  - visualPrompt: a concrete single-shot image description — subject, setting, composition. Describe one still frame only; no camera moves, no motion words.
  - motionPrompt: a short phrase describing how the shot moves — camera motion or subject motion (for example "slow push-in" or "waves rolling toward the shore").
- platformMeta: provide entries for youtube, tiktok, and instagram. For each entry:
  - title: at most 90 characters. No emojis.
  - description: 1 to 2 plain-spoken sentences. No emojis.
  - hashtags: at most 5 hashtags, each starting with "#", lowercase, no spaces.

Tone: plain-spoken and factual. Do not use emojis anywhere. Do not use markdown.`;
}

export function createScriptStage(client?: Anthropic): StageDef {
  return {
    name: 'script',
    async run(ctx: JobContext): Promise<void> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS, ctx.tier);
      let artifact: ScriptArtifact;
      let costUsdMicros: number;
      if (ctx.tier === 'premium') {
        const { data, cost } = await structuredCompletion({
          model: ctx.channel.scriptModel,
          system: buildScenesSystem(ctx.channel.niche),
          prompt: buildScenesPrompt(ctx.topic, ctx.channel.niche, ctx.channel.premium.stylePrefix),
          schema: ScenesOutputSchema,
          // Raise the ceiling above the 2048 default: a full script + platformMeta for
          // three platforms can exceed it, and a truncated forced tool_use surfaces as
          // an opaque ZodError rather than a clear length failure.
          maxTokens: 4096,
          client,
        });
        // The LLM never emits `format`; stamp it here so every consumer of
        // script.json can discriminate scenes vs story artifacts.
        artifact = { ...data, format: 'scenes' };
        costUsdMicros = cost.usdMicros;
      } else {
        const { data, cost } = await structuredCompletion({
          model: ctx.channel.scriptModel,
          system: buildSystem(ctx.channel.niche),
          prompt: buildPrompt(ctx.topic, ctx.channel.niche),
          schema: ScriptOutputSchema,
          maxTokens: 4096,
          client,
        });
        artifact = data;
        costUsdMicros = cost.usdMicros;
      }
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', costUsdMicros);
      await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(artifact, null, 2));
    },
  };
}

export const scriptStage = createScriptStage();
```

- [ ] **Step 4: Run the tests, expect pass; commit.** `pnpm vitest run src/stages/script.test.ts` → 9 passing (3 pre-existing story tests untouched + 6 new). Then the full gates: `pnpm test` (whole suite green — the volume path's written artifact and prompts are unchanged, so no other test moves) and `pnpm build` (`tsc --noEmit && tsc -p remotion --noEmit`, both clean — this step only adds exports to `script.ts`; no other module references them yet). Commit:
  `git add src/stages/script.ts src/stages/script.test.ts && git commit -m "feat: add premium scenes script format with format-stamped artifact"`

- [ ] **Step 5: Write failing tests for scenes-aware narration text.** Create `src/stages/narration-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { narrationText, narrationWordCount } from './narration-text.js';
import type { ScenesOutput, ScriptArtifact } from './script.js';
import { testScript } from './_testkit.js';

function scenesArtifact(): ScenesOutput {
  return {
    format: 'scenes',
    hook: 'Hook here',
    styleBlock: 'Warm palette, watercolor medium, calm mood, golden-hour light.',
    scenes: [
      { narration: 'First scene line.', visualPrompt: 'v1', motionPrompt: 'm1' },
      { narration: 'Second scene line.', visualPrompt: 'v2', motionPrompt: 'm2' },
    ],
    platformMeta: {
      youtube: { title: 't', description: 'd', hashtags: [] },
      tiktok: { title: 't', description: 'd', hashtags: [] },
      instagram: { title: 't', description: 'd', hashtags: [] },
    },
  };
}

describe('narrationText', () => {
  it('joins hook + scene narrations with single spaces for scenes artifacts', () => {
    // EXACT composition contract: scene-windows (Task 12) re-derives scene
    // boundaries from hook-then-narrations joined with single spaces.
    expect(narrationText(scenesArtifact())).toBe('Hook here First scene line. Second scene line.');
  });

  it('keeps the story composition byte-identical (hook + segments, blank-line joined)', () => {
    expect(narrationText(testScript())).toBe('Hook here\n\nOne.\n\nTwo.');
  });

  it('handles a scenes artifact round-tripped through JSON, as stages read script.json', () => {
    const fromDisk = JSON.parse(JSON.stringify(scenesArtifact())) as ScriptArtifact;
    expect(narrationText(fromDisk)).toBe('Hook here First scene line. Second scene line.');
  });
});

describe('narrationWordCount', () => {
  it('counts words across hook and scene narrations', () => {
    // 'Hook here' (2) + 'First scene line.' (3) + 'Second scene line.' (3)
    expect(narrationWordCount(scenesArtifact())).toBe(8);
  });
});
```

- [ ] **Step 6: Run the test, expect failure.** `pnpm vitest run src/stages/narration-text.test.ts` → 3 failures, 1 pass. The scenes-based tests (`joins hook + scene narrations...`, `handles a scenes artifact round-tripped...`, `counts words across hook and scene narrations`) each fail with `TypeError: Cannot read properties of undefined (reading 'map')` — the current `narrationText` unconditionally reads `script.segments`, which is `undefined` on a scenes artifact. The story regression test passes (current behavior).

- [ ] **Step 7: Implement scenes-aware narration text.** Replace the entire contents of `src/stages/narration-text.ts` with:

```ts
import { isScenesOutput, type ScriptArtifact } from './script.js';

/**
 * Narration text fed to TTS and to caption alignment: the hook followed by the
 * spoken text of each segment (story) or scene (scenes). Shared by the voice
 * and captions stages so both produce byte-identical transcripts.
 *
 * Scenes composition is EXACTLY hook + scenes[].narration joined with single
 * spaces: src/stages/scene-windows.ts (Task 12) re-derives per-scene token
 * boundaries from this composition, so changing the joiner or the order breaks
 * premium visuals. Story composition is unchanged from Plan 1.
 */
export function narrationText(script: ScriptArtifact): string {
  if (isScenesOutput(script)) {
    return [script.hook, ...script.scenes.map((s) => s.narration)].join(' ');
  }
  return [script.hook, ...script.segments.map((s) => s.text)].join('\n\n');
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function narrationWordCount(script: ScriptArtifact): number {
  return countWords(narrationText(script));
}

// Natural narration runs 2.5-3 words/sec. 5 w/s is a generous ceiling that no real
// synthesis exceeds, so falling under it means audio was lost.
export const MAX_PLAUSIBLE_WORDS_PER_SEC = 5;

/**
 * Shortest narration duration that is plausible for `words` of speech. The voice
 * stage rejects synthesis below this floor and the qc gate re-checks the finished
 * artifacts against it; both derive the rule here so they cannot drift apart.
 */
export function minPlausibleNarrationMs(words: number): number {
  return Math.round(words * (1000 / MAX_PLAUSIBLE_WORDS_PER_SEC));
}
```

No caller changes are needed: `voice.ts`, `captions.ts`, and `qc.ts` pass values typed `ScriptOutput`, which widens cleanly into the `ScriptArtifact` parameter. At runtime a premium job's `script.json` carries `format: 'scenes'`, so `narrationText` picks the scenes branch regardless of the caller's compile-time cast — which is what lets Task 11's voice stage and the dual-mode captions work over scenes artifacts without touching this module again.

- [ ] **Step 8: Run the tests, expect pass; full gates; commit.** `pnpm vitest run src/stages/narration-text.test.ts` → 4 passing. Then `pnpm test` → whole suite green (story composition unchanged, so voice/captions/qc tests are unaffected) and `pnpm build` → both `tsc` programs clean. Commit:
  `git add src/stages/narration-text.ts src/stages/narration-text.test.ts && git commit -m "feat: extend narration text to premium scenes artifacts"`

---

### Task 11: Premium voice (ElevenLabs + fallback) and dual-mode captions

**Files:**
- Create: (none)
- Modify: `src/stages/voice.ts`, `src/stages/captions.ts`
- Test: `src/stages/voice.test.ts`, `src/stages/captions.test.ts`

**Interfaces:**

Consumes:

```ts
// src/providers/elevenlabs.ts (Task 9)
export function estimateTtsCostMicros(text: string): number
export async function synthWithTimestamps(opts: {
  voiceId: string; modelId: string; text: string; apiKey?: string; fetchImpl?: typeof fetch
}): Promise<{ wavBytes: Buffer; durationMs: number; words: WordTiming[]; costUsdMicros: number }>

// src/jobs/costs.ts (Task 6 signature — tier is REQUIRED)
export function assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void
export class BudgetExceededError extends Error
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void

// src/config/channel.ts (Task 5)
export interface PremiumVoiceConfig { provider: 'elevenlabs'; voiceId: string; modelId: string }
// ChannelConfig.voice is { volume: string; premium?: PremiumVoiceConfig }

// src/stages/script.ts + src/stages/narration-text.ts (Task 10)
export type ScriptArtifact = ScriptOutput | ScenesOutput
export function narrationText(script: ScriptArtifact): string
// story: hook + segments joined with '\n\n' (unchanged);
// scenes: hook + scenes[].narration joined with single spaces (binding contract)

// src/providers/whisperx.ts (existing, unchanged)
export interface WordTiming { word: string; startMs: number; endMs: number }
export async function alignTranscript(opts: { baseUrl: string; wavPath: string; transcript: string; timeoutMs?: number }): Promise<WordTiming[]>

// src/media/wav.ts (existing, unchanged)
export function parseWavDurationMs(buf: Buffer): number

// src/stages/_testkit.ts (post-Task 5 state)
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
// Task 5's testChannel() DOES set voice.premium by default (ElevenLabs "Sarah");
// budget.premiumPerVideoUsdMicros = 7_000_000. Tests exercising the
// missing-config path must override it away: testChannel({ voice: { volume: 'af_heart' } })
export function makeCtx(channel?: ChannelConfig, topic?: string): JobContext
// always tier 'volume' — premium tests spread-override: { ...makeCtx(ch), tier: 'premium' }
```

Produces (later tasks rely on these exact behaviors):

```ts
// src/stages/voice.ts
export interface VoiceMeta { provider: 'kokoro' | 'edge-tts' | 'elevenlabs'; voiceId: string; durationMs: number }
// runs/<jobId>/voice/voice.json is VoiceMeta — provider records what actually ran,
// so a downgraded premium video is visible (design §4.2).
// Premium ElevenLabs success ALSO writes runs/<jobId>/voice/timings.json:
// { words: WordTiming[] } — identical shape to captions/words.json.
// Every other outcome guarantees timings.json is ABSENT: it is removed at stage
// start (stale prior attempt), re-removed inside the fallback path, and only
// (re)created AFTER the shared duration guard has accepted the audio — so a
// truncation failure never leaves timings behind for captions to trust.
// A BudgetExceededError from the pre-synth checkpoint PROPAGATES out of the stage
// (the runner parks the job 'blocked'); it is never swallowed into a fallback.
// The implausibly-short truncation guard applies to all three providers.

// src/stages/captions.ts
export interface CaptionsArtifact { words: WordTiming[] }   // shape unchanged
// Dual mode: if voice/timings.json exists AND its words array is non-empty, its
// words are written verbatim to captions/words.json and WhisperX is never called.
// Otherwise (volume jobs, premium fallback runs, empty words array) the existing
// WhisperX path runs byte-identically.
```

Task 12 (`computeSceneWindows`) and Task 13 (visuals) consume `captions/words.json` and `voice/voice.json` by these unchanged names; Task 16's premium golden path relies on the dual-mode rule to run without the sidecar.

**Context for the engineer:** `src/stages/voice.ts` currently knows two providers (kokoro → edge-tts fallback chain) and always ignores `ctx.tier`. `src/stages/captions.ts` always calls the WhisperX sidecar. This task makes the voice stage tier-aware — premium jobs synthesize via the Task 9 ElevenLabs adapter, which returns provider word timings, so captions can skip WhisperX entirely — while keeping the volume path byte-identical (the only volume-visible change is a no-op `fs.rm` of a file volume jobs never create). Both files parse `script.json`; retype that cast from `ScriptOutput` to Task 10's `ScriptArtifact` since a premium job's script is a `ScenesOutput` (`narrationText` accepts the union). Note vitest module state: `vi.clearAllMocks()` in the existing `beforeEach` clears calls but NOT `mockResolvedValue`s, so every new test sets the mock behavior it depends on explicitly — never rely on a mock being "unset".

- [ ] **Step 1: Write the failing premium happy-path voice test**

  Open `src/stages/voice.test.ts`. Add the ElevenLabs module mock next to the two existing `vi.mock` calls at the top of the file (vi.mock calls are hoisted; keep them together above the imports they affect):

  ```ts
  vi.mock('../providers/elevenlabs.js', () => ({
    estimateTtsCostMicros: vi.fn(() => 40_000),
    synthWithTimestamps: vi.fn(),
  }));
  ```

  Extend the existing `_testkit.js` import line to also pull `testChannel`, and add the two new imports below the existing ones:

  ```ts
  import { makeCtx, testChannel, testScript } from './_testkit.js';
  ```

  ```ts
  import { estimateTtsCostMicros, synthWithTimestamps } from '../providers/elevenlabs.js';
  import { BudgetExceededError } from '../jobs/costs.js';
  ```

  Then add the premium fixtures and helpers after the existing `KOKORO_RATE`/`chunkAudio` block (before `ctxWithScript`):

  ```ts
  // ---- premium (elevenlabs) fixtures ----

  const PREMIUM_VOICE = {
    provider: 'elevenlabs',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    modelId: 'eleven_multilingual_v2',
  } as const;

  function premiumChannel() {
    return testChannel({ voice: { volume: 'af_heart', premium: { ...PREMIUM_VOICE } } });
  }

  // Premium script artifact (Task 10 scenes format). narrationText composes
  // scenes narration as hook + scenes[].narration joined with single spaces —
  // that composition is a binding contract, asserted below.
  const SCENES_SCRIPT = {
    format: 'scenes',
    hook: 'Hook here',
    styleBlock: 'Muted watercolor palette, soft dawn light, gentle grain.',
    scenes: [
      { narration: 'One.', visualPrompt: 'a red planet', motionPrompt: 'slow push-in' },
      { narration: 'Two.', visualPrompt: 'a blue comet', motionPrompt: 'drift left' },
    ],
    platformMeta: testScript().platformMeta,
  };
  const SCENES_NARRATION = 'Hook here One. Two.';

  const ELEVEN_WAV = buildWav(16000); // 1000 ms — plausible for the 4-word narration
  const ELEVEN_WORDS = [
    { word: 'Hook', startMs: 0, endMs: 180 },
    { word: 'here', startMs: 190, endMs: 350 },
    { word: 'One.', startMs: 400, endMs: 620 },
    { word: 'Two.', startMs: 700, endMs: 950 },
  ];
  function elevenSynthResult() {
    return { wavBytes: ELEVEN_WAV, durationMs: 1000, words: ELEVEN_WORDS, costUsdMicros: 42_000 };
  }

  // makeCtx creates volume jobs; premium stage behavior keys off ctx.tier, so a
  // spread-override is all a stage unit test needs (the DB job row's tier is not
  // read by the voice stage; budget queries join on channel, not tier).
  async function premiumCtx(script: unknown = SCENES_SCRIPT, channel = premiumChannel()): Promise<JobContext> {
    const ctx: JobContext = { ...makeCtx(channel), tier: 'premium' };
    await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script));
    return ctx;
  }
  ```

  Finally add a new describe block after the closing `})` of the existing `describe('voiceStage', ...)`:

  ```ts
  describe('voiceStage premium (elevenlabs)', () => {
    it('synthesizes via elevenlabs: wav + timings + meta written, cost recorded, volume chain untouched', async () => {
      const ctx = await premiumCtx();
      vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult());
      // Kokoro is armed so that, if the implementation wrongly falls through to
      // the volume chain, this test fails on assertions instead of crashing.
      const generate = vi.fn(async (t: string) => chunkAudio(t));
      vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

      await voiceStage.run(ctx);

      expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledWith({
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        modelId: 'eleven_multilingual_v2',
        text: SCENES_NARRATION,
      });
      expect(vi.mocked(KokoroTTS.from_pretrained)).not.toHaveBeenCalled();

      const wav = await fs.readFile(ctx.artifactPath('voice', 'narration.wav'));
      expect(wav.equals(ELEVEN_WAV)).toBe(true);
      const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
      expect(meta).toEqual({ provider: 'elevenlabs', voiceId: 'EXAVITQu4vr4xnSDxMaL', durationMs: 1000 });
      const timings = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8'));
      expect(timings).toEqual({ words: ELEVEN_WORDS });

      // Ledger: the estimate is reserved pre-call, the ACTUAL cost is recorded.
      expect(vi.mocked(estimateTtsCostMicros)).toHaveBeenCalledWith(SCENES_NARRATION);
      const costs = ctx.db
        .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
        .all(ctx.jobId);
      expect(costs).toEqual([{ provider: 'elevenlabs', operation: 'tts', usd_micros: 42_000 }]);
    });
  });
  ```

- [ ] **Step 2: Run the voice tests — expect exactly the new test to FAIL**

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: every pre-existing test passes; the new test fails on its first assertion with
  `AssertionError: expected "spy" to be called 1 times, but got 0 times` — the current stage ignores `ctx.tier` and goes straight to kokoro. (If it fails differently — e.g. a module-resolution error on `../providers/elevenlabs.js` — stop: Task 9 is not in place.)

- [ ] **Step 3: Implement the premium synthesis path in `src/stages/voice.ts`**

  Three edits. First, replace the script-type import line

  ```ts
  import type { ScriptOutput } from './script.js';
  ```

  with

  ```ts
  import type { ScriptArtifact } from './script.js';
  import { assertBudget, recordCost } from '../jobs/costs.js';
  import { estimateTtsCostMicros, synthWithTimestamps } from '../providers/elevenlabs.js';
  import type { WordTiming } from '../providers/whisperx.js';
  ```

  (`WordTiming` types the held-back provider timings: they are carried in a local until the duration guard has accepted the audio, and only then written to `timings.json`.)

  Second, widen `VoiceMeta` (the `interface VoiceMeta` block near the top):

  ```ts
  export interface VoiceMeta {
    provider: 'kokoro' | 'edge-tts' | 'elevenlabs';
    voiceId: string;
    durationMs: number;
  }
  ```

  Third, replace the entire `export const voiceStage: StageDef = { ... };` block (the last export in the file; do not touch `splitForTts`/`synthChunked`/`synthKokoro`/`synthEdge` above it) with:

  ```ts
  export const voiceStage: StageDef = {
    name: 'voice',
    async run(ctx: JobContext): Promise<void> {
      const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptArtifact;
      const narration = narrationText(script);
      const wavPath = ctx.artifactPath('voice', 'narration.wav');
      const timingsPath = ctx.artifactPath('voice', 'timings.json');

      // Captions trusts voice/timings.json over WhisperX, so a stale file from a
      // previous failed attempt would caption audio it was never measured against.
      // Remove it before any synthesis; only a VALIDATED ElevenLabs success
      // recreates it (below, after the duration guard).
      await fs.rm(timingsPath, { force: true });

      let provider: VoiceMeta['provider'] | undefined;
      let voiceId = '';
      let premiumWords: WordTiming[] | undefined;

      const premiumVoice = ctx.channel.voice.premium;
      if (ctx.tier === 'premium' && premiumVoice) {
        // Paid call: reserve the character-based estimate against the premium
        // per-video cap before dialing out; record the actual cost after.
        assertBudget(ctx.db, ctx.channel, ctx.jobId, estimateTtsCostMicros(narration), ctx.tier);
        const synth = await synthWithTimestamps({
          voiceId: premiumVoice.voiceId,
          modelId: premiumVoice.modelId,
          text: narration,
        });
        await fs.writeFile(wavPath, synth.wavBytes);
        recordCost(ctx.db, ctx.jobId, 'elevenlabs', 'tts', synth.costUsdMicros);
        provider = 'elevenlabs';
        voiceId = premiumVoice.voiceId;
        // timings.json is NOT written here: it becomes visible to captions only
        // after the shared duration guard below has accepted the audio.
        premiumWords = synth.words;
      }

      if (provider === undefined) {
        try {
          await synthKokoro(narration, ctx.channel.voice.volume, wavPath);
          provider = 'kokoro';
          voiceId = ctx.channel.voice.volume;
        } catch (kokoroErr) {
          ctx.log.warn({ err: kokoroErr }, 'kokoro TTS failed; falling back to edge-tts');
          try {
            await synthEdge(narration, wavPath);
            provider = 'edge-tts';
            voiceId = EDGE_VOICE;
          } catch (edgeErr) {
            throw new Error(`voice synthesis failed: kokoro=${String(kokoroErr)}; edge=${String(edgeErr)}`);
          }
        }
      }

      const durationMs = parseWavDurationMs(await fs.readFile(wavPath));

      // Defense in depth: a TTS backend that silently drops text still returns a
      // well-formed WAV, so the only signal is that it is too short for the
      // script. This guard covers every provider, ElevenLabs included.
      const words = countWords(narration);
      const minPlausibleMs = minPlausibleNarrationMs(words);
      if (durationMs < minPlausibleMs) {
        throw new Error(
          `voice synthesis produced implausibly short audio: ${durationMs}ms for ${words} words ` +
            `(minimum ${minPlausibleMs}ms at ${MAX_PLAUSIBLE_WORDS_PER_SEC} words/sec); ` +
            `narration was likely truncated by provider "${provider}"`,
        );
      }

      // Only now — with the audio validated — may the provider timings land on
      // disk. Writing timings.json any earlier would break the ABSENT guarantee:
      // a truncation throw above must leave nothing for captions to trust.
      if (premiumWords !== undefined) {
        await fs.writeFile(timingsPath, JSON.stringify({ words: premiumWords }, null, 2));
      }

      const meta: VoiceMeta = { provider, voiceId, durationMs };
      await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2));
    },
  };
  ```

  (No fallback around the premium branch yet — an ElevenLabs error still propagates. That is the next red test.)

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: ALL tests pass, including the new premium happy path and every pre-existing volume test (the volume path only gained the no-op `fs.rm`).

- [ ] **Step 4: Write the failing fallback tests (provider error, stale timings, missing config)**

  Append these three tests inside `describe('voiceStage premium (elevenlabs)', ...)`:

  ```ts
  it('falls back to kokoro when elevenlabs fails, leaving no timings.json and no cost row', async () => {
    const ctx = await premiumCtx();
    vi.mocked(synthWithTimestamps).mockRejectedValue(new Error('eleven down'));
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.provider).toBe('kokoro');
    expect(meta.voiceId).toBe('af_heart');
    // No timings artifact: captions must take the WhisperX path for this job.
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow();
    // Only elevenlabs SUCCESSES may reach the ledger.
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { n: number };
    expect(n).toBe(0);
  });

  it('removes a stale timings.json from a prior attempt when falling back', async () => {
    const ctx = await premiumCtx();
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words: ELEVEN_WORDS }));
    vi.mocked(synthWithTimestamps).mockRejectedValue(new Error('eleven down'));
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow();
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.provider).toBe('kokoro');
  });

  it('premium tier without [voice.premium] config warns once and uses the volume chain', async () => {
    // testChannel() includes voice.premium by default (Task 5); override the
    // voice table wholesale to strip it and exercise the missing-config path.
    const ctx = await premiumCtx(SCENES_SCRIPT, testChannel({ voice: { volume: 'af_heart' } }));
    const warn = vi.spyOn(ctx.log, 'warn');
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.provider).toBe('kokoro');
  });
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: 3 failures, everything else green —
  - the first two reject with `Error: eleven down` (the premium branch has no fallback yet, so the provider error escapes `voiceStage.run`);
  - the third fails with `AssertionError: expected "warn" to be called 1 times, but got 0 times` — with the premium voice overridden away, the Step 3 guard (`ctx.tier === 'premium' && premiumVoice`) is false, so the stage silently takes the volume chain without the missing-config warn (the `not.toHaveBeenCalled()` assertion on `synthWithTimestamps` passes).

- [ ] **Step 5: Implement the fallback (catch + timings cleanup + missing-config warn)**

  In `src/stages/voice.ts`, replace the block from `const premiumVoice = ctx.channel.voice.premium;` through the closing `}` of `if (ctx.tier === 'premium' && premiumVoice) { ... }` with:

  ```ts
    const premiumVoice = ctx.channel.voice.premium;
    if (ctx.tier === 'premium') {
      if (!premiumVoice) {
        ctx.log.warn('premium tier requested but channel has no [voice.premium] config; using volume voice chain');
      } else {
        try {
          // Paid call: reserve the character-based estimate against the premium
          // per-video cap before dialing out; record the actual cost after.
          assertBudget(ctx.db, ctx.channel, ctx.jobId, estimateTtsCostMicros(narration), ctx.tier);
          const synth = await synthWithTimestamps({
            voiceId: premiumVoice.voiceId,
            modelId: premiumVoice.modelId,
            text: narration,
          });
          await fs.writeFile(wavPath, synth.wavBytes);
          recordCost(ctx.db, ctx.jobId, 'elevenlabs', 'tts', synth.costUsdMicros);
          provider = 'elevenlabs';
          voiceId = premiumVoice.voiceId;
          // timings.json is NOT written here: it becomes visible to captions
          // only after the shared duration guard below has accepted the audio.
          premiumWords = synth.words;
        } catch (err) {
          // The timings write is deferred past the duration guard, so this
          // attempt cannot have created timings.json — the rm is defense in
          // depth against the write ever drifting back into the try.
          await fs.rm(timingsPath, { force: true });
          ctx.log.warn({ err }, 'elevenlabs TTS failed; falling back to volume voice chain');
        }
      }
    }
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 6: Write the failing budget-propagation test**

  A budget breach is enforcement, not a provider fault (design §5: "either breach parks the job `blocked` with a reason"; the runner maps `BudgetExceededError` to `'blocked'`). Swallowing it into the free-voice fallback would hide the breach and let the job keep spending in visuals. Append inside the premium describe block:

  ```ts
  it('rethrows BudgetExceededError instead of downgrading to the free chain', async () => {
    const channel = premiumChannel();
    // estimateTtsCostMicros mock returns 40_000; cap it below that.
    channel.budget = { ...channel.budget, premiumPerVideoUsdMicros: 10_000 };
    const ctx = await premiumCtx(SCENES_SCRIPT, channel);
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await expect(voiceStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);

    // Aborted before any synthesis: no provider dialed, no artifacts written.
    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow();
  });
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: only this test fails, with `AssertionError: promise resolved "undefined" instead of rejecting` — the Step 5 catch swallows the `BudgetExceededError` and the stage completes on kokoro.

- [ ] **Step 7: Rethrow BudgetExceededError from the premium catch**

  In `src/stages/voice.ts`, extend the costs import:

  ```ts
  import { assertBudget, BudgetExceededError, recordCost } from '../jobs/costs.js';
  ```

  and insert two lines at the very top of the premium `catch (err) {` block, before the `fs.rm`:

  ```ts
        } catch (err) {
          // A budget breach is enforcement, not a provider fault: rethrow so the
          // runner parks the job 'blocked' instead of silently downgrading the
          // voice and continuing to spend on visuals.
          if (err instanceof BudgetExceededError) throw err;
          // The timings write is deferred past the duration guard, so this
          // attempt cannot have created timings.json — the rm is defense in
          // depth against the write ever drifting back into the try.
          await fs.rm(timingsPath, { force: true });
          ctx.log.warn({ err }, 'elevenlabs TTS failed; falling back to volume voice chain');
        }
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 8: Add the two characterization tests (expected to pass immediately)**

  These pin behavior the implementation already has, so later tasks cannot regress it silently. Append inside the premium describe block:

  ```ts
  it('volume tier ignores [voice.premium] entirely', async () => {
    // Channel HAS premium voice configured, but the job is volume tier.
    const ctx = makeCtx(premiumChannel());
    await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(SCRIPT));
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled();
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 2000 });
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow();
  });

  it('applies the implausibly-short truncation guard to elevenlabs audio too', async () => {
    // 15 scenes x 19-word sentence + 2-word hook = 287 words -> >= 57400ms
    // plausibility floor, but the mock returns 1000ms of audio.
    const longScenes = {
      ...SCENES_SCRIPT,
      scenes: Array.from({ length: 15 }, () => ({ narration: SENTENCE, visualPrompt: 'v', motionPrompt: 'm' })),
    };
    const ctx = await premiumCtx(longScenes);
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult());

    await expect(voiceStage.run(ctx)).rejects.toThrow(/truncated by provider "elevenlabs"/);
    // The ABSENT guarantee holds on this failure path too: the timings write is
    // deferred until after the duration guard, so the rejected synthesis leaves
    // no timings.json for captions to trust (and no voice.json either).
    await expect(fs.access(ctx.artifactPath('voice', 'timings.json'))).rejects.toThrow();
    await expect(fs.access(ctx.artifactPath('voice', 'voice.json'))).rejects.toThrow();
  });
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/voice.test.ts
  ```

  Expected: all tests pass on the first run — the tier check already gates on `ctx.tier`, and the truncation guard already sits on the shared path after provider selection (the guard error escapes the stage: the premium `try` only wraps the synth-and-record, and because the timings write sits AFTER the guard, the rejected run leaves no `timings.json` — the two absence assertions pin exactly that ordering). If either FAILS, the implementation from Steps 3–7 deviated — fix it, do not adjust the test.

- [ ] **Step 9: Write the failing dual-mode captions tests**

  Open `src/stages/captions.test.ts`. No import changes needed. Append these two tests inside `describe('captionsStage', ...)`, after the existing `'throws when the aligner returns no words'` test:

  ```ts
  it('copies provider timings from voice/timings.json and never calls whisperx', async () => {
    const ctx = await ctxWithScript();
    const words = [
      { word: 'Hook', startMs: 0, endMs: 180 },
      { word: 'here', startMs: 190, endMs: 350 },
    ];
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words }));
    // Armed to prove it is NOT used.
    vi.mocked(alignTranscript).mockResolvedValue([{ word: 'whisper', startMs: 0, endMs: 100 }]);

    await captionsStage.run(ctx);

    const artifact = JSON.parse(await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'));
    expect(artifact).toEqual({ words });
    expect(vi.mocked(alignTranscript)).not.toHaveBeenCalled();
  });

  it('falls through to whisperx when timings.json exists but has no words', async () => {
    const ctx = await ctxWithScript();
    await fs.writeFile(ctx.artifactPath('voice', 'timings.json'), JSON.stringify({ words: [] }));
    vi.mocked(alignTranscript).mockResolvedValue([{ word: 'whisper', startMs: 0, endMs: 100 }]);

    await captionsStage.run(ctx);

    const artifact = JSON.parse(await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'));
    expect(artifact).toEqual({ words: [{ word: 'whisper', startMs: 0, endMs: 100 }] });
    expect(vi.mocked(alignTranscript)).toHaveBeenCalledTimes(1);
  });
  ```

  Run:

  ```sh
  pnpm vitest run src/stages/captions.test.ts
  ```

  Expected: the copy test fails —
  `AssertionError: expected { words: [ { word: 'whisper', … } ] } to deeply equal { words: [ { word: 'Hook', … }, …' ] }`
  (today's stage always aligns via WhisperX). The empty-words test passes already (today's stage always calls WhisperX anyway) — it is the guard that the upcoming early-return does not over-trigger. The two pre-existing tests pass.

- [ ] **Step 10: Implement dual-mode captions**

  Replace the entire contents of `src/stages/captions.ts` with:

  ```ts
  import { promises as fs } from 'node:fs';
  import type { StageDef, JobContext } from '../jobs/types.js';
  import type { ScriptArtifact } from './script.js';
  import { narrationText } from './narration-text.js';
  import { alignTranscript, type WordTiming } from '../providers/whisperx.js';

  export interface CaptionsArtifact {
    words: WordTiming[];
  }

  // Dual mode: provider-supplied word timings (voice/timings.json, written only
  // by a successful ElevenLabs premium synth) win over the WhisperX sidecar — a
  // premium run whose synth succeeded has no sidecar dependency. Volume runs and
  // premium runs that fell back to kokoro/edge-tts have no timings.json (the
  // voice stage guarantees that) and take the WhisperX path unchanged.
  export const captionsStage: StageDef = {
    name: 'captions',
    async run(ctx: JobContext): Promise<void> {
      const timingsRaw = await fs
        .readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8')
        .catch(() => undefined); // absent file -> WhisperX path
      if (timingsRaw !== undefined) {
        // Deliberately NOT try/caught: an unparseable timings.json is a corrupt
        // voice artifact and should fail the stage loudly, not silently realign.
        const timings = JSON.parse(timingsRaw) as Partial<CaptionsArtifact>;
        if (Array.isArray(timings.words) && timings.words.length > 0) {
          const artifact: CaptionsArtifact = { words: timings.words };
          await fs.writeFile(ctx.artifactPath('captions', 'words.json'), JSON.stringify(artifact, null, 2));
          return;
        }
      }

      const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptArtifact;
      const transcript = narrationText(script);

      const words = await alignTranscript({
        baseUrl: process.env.WHISPERX_URL ?? 'http://localhost:8585',
        wavPath: ctx.artifactPath('voice', 'narration.wav'),
        transcript,
      });
      if (words.length === 0) throw new Error('captions: whisperx returned no word timings');

      const artifact: CaptionsArtifact = { words };
      await fs.writeFile(ctx.artifactPath('captions', 'words.json'), JSON.stringify(artifact, null, 2));
    },
  };
  ```

  (Diff from today: the timings-first early return, and the `script.json` cast retyped `ScriptOutput` → `ScriptArtifact` — the WhisperX branch also serves premium fallback jobs, whose script is a `ScenesOutput`; `narrationText` accepts the union.)

  Run:

  ```sh
  pnpm vitest run src/stages/captions.test.ts
  ```

  Expected: all 4 tests pass.

- [ ] **Step 11: Full suite and build gate**

  ```sh
  pnpm test
  pnpm build
  ```

  Expected: the whole suite passes with zero failures (the pre-existing files plus the 9 new tests from this task (7 in voice.test.ts, 2 in captions.test.ts); `golden-path.test.ts` does a real Remotion render, allow it a minute). Contract tests stay skipped (no `CONTRACT=1`). `pnpm build` (`tsc --noEmit && tsc -p remotion --noEmit`) exits 0 — the `VoiceMeta` union widening is additive, and its consumers (`qc.ts`, `assemble.ts`, `visuals-volume.ts`) only read `durationMs`.

- [ ] **Step 12: Commit**

  ```sh
  git add src/stages/voice.ts src/stages/voice.test.ts src/stages/captions.ts src/stages/captions.test.ts
  git commit -m "feat: elevenlabs premium voice with fallback chain and dual-mode captions"
  ```

---

### Task 12: Scene-window computation

**Files:**
- Create: `src/stages/scene-windows.ts`
- Modify: (none)
- Test: `src/stages/scene-windows.test.ts`

**Interfaces:**

Consumes (from earlier tasks / existing code — all unchanged by this task):

```ts
// src/stages/script.ts (Task 10)
export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' }
// Shape: { hook: string; styleBlock: string;
//          scenes: { narration: string; visualPrompt: string; motionPrompt: string }[];
//          platformMeta: { youtube: {...}; tiktok: {...}; instagram: {...} };
//          format: 'scenes' }

// src/providers/whisperx.ts (existing, Plan 1)
export interface WordTiming { word: string; startMs: number; endMs: number }
```

Produces (Task 13 `visuals-premium.ts` imports these from `'./scene-windows.js'`; Task 15's scene-coverage check relies on the tiling guarantee via the manifest):

```ts
// src/stages/scene-windows.ts
export interface SceneWindow { startMs: number; endMs: number }
export interface SceneWindowsResult { windows: SceneWindow[]; method: 'aligned' | 'proportional' }
export function computeSceneWindows(script: ScenesOutput, words: WordTiming[], totalDurationMs: number): SceneWindowsResult
```

Guarantees (binding, from the plan's Interface Contract):
1. Pure and deterministic; **never throws**.
2. `windows.length === script.scenes.length`.
3. The windows tile `[0, totalDurationMs]` exactly: `windows[0].startMs === 0`, `windows[k].endMs === windows[k+1].startMs`, last `endMs === totalDurationMs`. All values integer ms.
4. Scene 1's window starts at 0 — it covers the spoken hook.
5. `method: 'aligned'` when every scene's first narration token was anchored to a real word timing; `method: 'proportional'` (allocation by per-scene word count, hook words counted into scene 1) on any irrecoverable mismatch, including empty `words[]`.

**Context for the engineer:** the premium visuals stage (Task 13) needs a time window per scene so each generated clip covers exactly the span where its narration is spoken. `captions/words.json` (written by Task 11's captions stage — either copied ElevenLabs timings or WhisperX alignment) gives word-level timings for the whole narration. The spoken narration for a scenes script is `hook + scenes[].narration` in order (Task 10's `narrationText` composition rule), so the expected token sequence here mirrors exactly that composition. Alignment is fuzzy in practice — the aligner drops, merges, or inserts words, and punctuation/case never match the script text — so matching is done on normalized tokens with bounded tolerance, and any irrecoverable mismatch degrades to a deterministic proportional split rather than failing the job. No LLM, no I/O, no network: this is a pure function with adversarial unit tests.

- [ ] **Step 1: Write the failing proportional-method tests**

  Create `src/stages/scene-windows.test.ts` with the following content. The helpers at the top (`makeScenes`, `timeline`, `assertTiling`) are used by every later step; `assertTiling` asserts the contract invariants (one window per scene, integer ms, start at 0, contiguous, exact end) on **every** test case.

  ```ts
  import { describe, it, expect } from 'vitest';
  import { computeSceneWindows } from './scene-windows.js';
  import type { SceneWindowsResult } from './scene-windows.js';
  import type { ScenesOutput } from './script.js';
  import type { WordTiming } from '../providers/whisperx.js';

  const PLATFORM_META = {
    youtube: { title: 't', description: 'd', hashtags: [] },
    tiktok: { title: 't', description: 'd', hashtags: [] },
    instagram: { title: 't', description: 'd', hashtags: [] },
  };

  /** Schema-valid ScenesOutput; only hook and scenes[].narration matter here. */
  function makeScenes(hook: string, narrations: string[]): ScenesOutput {
    return {
      format: 'scenes',
      hook,
      styleBlock: 'Muted watercolor, soft dawn light, consistent pastel palette.',
      scenes: narrations.map((narration, i) => ({
        narration,
        visualPrompt: `visual ${i}`,
        motionPrompt: `motion ${i}`,
      })),
      platformMeta: PLATFORM_META,
    };
  }

  /** One WordTiming per whitespace token: word i starts at i*300ms, 250ms spoken. */
  function timeline(text: string): WordTiming[] {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
  }

  /**
   * Contract invariants that must hold for EVERY result: one window per scene,
   * integer ms, window 0 starts at 0, contiguous (end k === start k+1), last end
   * === totalDurationMs, no negative-length windows.
   */
  function assertTiling(result: SceneWindowsResult, sceneCount: number, totalDurationMs: number): void {
    expect(result.windows).toHaveLength(sceneCount);
    if (sceneCount === 0) return;
    expect(result.windows[0].startMs).toBe(0);
    expect(result.windows[sceneCount - 1].endMs).toBe(totalDurationMs);
    for (const w of result.windows) {
      expect(Number.isInteger(w.startMs)).toBe(true);
      expect(Number.isInteger(w.endMs)).toBe(true);
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
    }
    for (let k = 0; k + 1 < result.windows.length; k++) {
      expect(result.windows[k].endMs).toBe(result.windows[k + 1].startMs);
    }
  }

  describe('computeSceneWindows — proportional', () => {
    it('empty words[] → proportional split by word count, hook weighting scene 1', () => {
      const script = makeScenes('One two', ['a b c', 'd e', 'f']);
      const result = computeSceneWindows(script, [], 8000);
      expect(result.method).toBe('proportional');
      // weights: scene1 = 2 hook + 3 = 5, scene2 = 2, scene3 = 1 (of 8) over 8000ms
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 5000 },
        { startMs: 5000, endMs: 7000 },
        { startMs: 7000, endMs: 8000 },
      ]);
      assertTiling(result, 3, 8000);
    });

    it('rounding never breaks the tiling: 3 equal scenes over 1000ms', () => {
      const script = makeScenes('', ['a', 'b', 'c']);
      const result = computeSceneWindows(script, [], 1000);
      expect(result.method).toBe('proportional');
      // cumulative-then-round: boundaries at round(1000/3)=333 and round(2000/3)=667;
      // the last window absorbs the remainder so the sum is exactly 1000.
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 333 },
        { startMs: 333, endMs: 667 },
        { startMs: 667, endMs: 1000 },
      ]);
      assertTiling(result, 3, 1000);
    });

    it('all-punctuation narration (zero total weight) splits evenly, never throws', () => {
      const script = makeScenes('—', ['...', '!!!']);
      const result = computeSceneWindows(script, [], 1000);
      expect(result.method).toBe('proportional');
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 500 },
        { startMs: 500, endMs: 1000 },
      ]);
      assertTiling(result, 2, 1000);
    });

    it('single scene spans the whole narration', () => {
      const script = makeScenes('Hi', ['Just one scene here.']);
      const result = computeSceneWindows(script, [], 2000);
      expect(result.method).toBe('proportional');
      expect(result.windows).toEqual([{ startMs: 0, endMs: 2000 }]);
      assertTiling(result, 1, 2000);
    });

    it('zero scenes yields zero windows without throwing', () => {
      const script = makeScenes('Hi', []);
      const result = computeSceneWindows(script, timeline('Hi'), 1000);
      expect(result.windows).toEqual([]);
      assertTiling(result, 0, 1000);
    });
  });
  ```

- [ ] **Step 2: Run the test file — expect it to fail to load**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: the whole file errors at collection with a module-resolution failure naming `./scene-windows.js` — e.g. `Error: Failed to resolve import "./scene-windows.js" from "src/stages/scene-windows.test.ts". Does the file exist?` (exact wording varies by vitest version). No tests run — the module does not exist yet.

- [ ] **Step 3: Implement the proportional core**

  Create `src/stages/scene-windows.ts` with the following content. This is the minimal implementation for the tests so far: `computeSceneWindows` always answers proportionally (the aligned walk comes in Step 7). `tokenize`, `tile`, and `proportionalStarts` are final — later steps only add to this file.

  ```ts
  import type { WordTiming } from '../providers/whisperx.js';
  import type { ScenesOutput } from './script.js';

  export interface SceneWindow {
    startMs: number;
    endMs: number;
  }

  export interface SceneWindowsResult {
    windows: SceneWindow[];
    method: 'aligned' | 'proportional';
  }

  /**
   * Lowercase and strip every non-alphanumeric character: "Don't," → 'dont'.
   * A token that normalizes to nothing (pure punctuation like '—') is dropped by
   * tokenize(), matching aligner output, which never emits standalone punctuation.
   */
  function normalizeToken(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function tokenize(text: string): string[] {
    return text
      .split(/\s+/)
      .map(normalizeToken)
      .filter((token) => token.length > 0);
  }

  /**
   * Turn per-scene start boundaries into windows that tile [0, totalDurationMs]
   * exactly: clamp each start into [previous start, totalDurationMs] so the
   * invariant holds even against a pathological word timeline, force the first
   * start to 0 (scene 1 covers the hook), and let the last window absorb the
   * remainder.
   */
  function tile(rawStarts: number[], totalDurationMs: number): SceneWindow[] {
    const starts: number[] = [];
    let prev = 0;
    for (const raw of rawStarts) {
      const clamped = Math.min(Math.max(Math.round(raw), prev), totalDurationMs);
      starts.push(clamped);
      prev = clamped;
    }
    if (starts.length > 0) starts[0] = 0;
    return starts.map((startMs, k) => ({
      startMs,
      endMs: k + 1 < starts.length ? starts[k + 1] : totalDurationMs,
    }));
  }

  /**
   * Split [0, totalDurationMs] proportionally to per-scene token counts. Hook
   * words are spoken inside scene 1's window, so they weight the first scene.
   * Boundaries accumulate exact fractions and round once each, so rounding error
   * never compounds across scenes.
   */
  function proportionalStarts(
    hookTokens: string[],
    sceneTokens: string[][],
    totalDurationMs: number,
  ): number[] {
    let weights = sceneTokens.map((tokens, k) =>
      k === 0 ? hookTokens.length + tokens.length : tokens.length,
    );
    let totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      // Every narration normalized to nothing (pure punctuation). Split evenly
      // rather than divide by zero — this module must never throw.
      weights = weights.map(() => 1);
      totalWeight = weights.length;
    }
    const starts: number[] = [];
    let cumulative = 0;
    for (const weight of weights) {
      starts.push(Math.round((cumulative / totalWeight) * totalDurationMs));
      cumulative += weight;
    }
    return starts;
  }

  /**
   * Compute one time window per scene over the narration span. Pure and
   * deterministic; never throws. windows.length === script.scenes.length and the
   * windows tile [0, totalDurationMs] exactly (window k's end === window k+1's
   * start). Scene 1's window always starts at 0 so it covers the spoken hook.
   */
  export function computeSceneWindows(
    script: ScenesOutput,
    words: WordTiming[],
    totalDurationMs: number,
  ): SceneWindowsResult {
    const hookTokens = tokenize(script.hook);
    const sceneTokens = script.scenes.map((scene) => tokenize(scene.narration));
    if (sceneTokens.length === 0) return { windows: [], method: 'proportional' };
    return {
      windows: tile(proportionalStarts(hookTokens, sceneTokens, totalDurationMs), totalDurationMs),
      method: 'proportional',
    };
  }
  ```

  (`words` is intentionally unused in this step; the aligned walk in Step 7 consumes it. `noUnusedParameters` is not enabled, so this compiles.)

- [ ] **Step 4: Run the test file — expect 5 passing**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: `Test Files  1 passed`, `Tests  5 passed`.

- [ ] **Step 5: Write the failing aligned-method tests**

  Append this describe block at the end of `src/stages/scene-windows.test.ts` (after the closing `});` of the proportional describe):

  ```ts
  describe('computeSceneWindows — aligned', () => {
    it('anchors each scene at the start of its first word; scene 1 covers the hook', () => {
      const script = makeScenes('Space is weird', [
        'The moon drifts away.',
        'Every single year.',
        'Nobody can stop it.',
      ]);
      const words = timeline(
        'Space is weird The moon drifts away Every single year Nobody can stop it',
      );
      const result = computeSceneWindows(script, words, 4500);
      expect(result.method).toBe('aligned');
      // 'Every' is word 7 (startMs 2100), 'Nobody' is word 10 (startMs 3000)
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 2100 },
        { startMs: 2100, endMs: 3000 },
        { startMs: 3000, endMs: 4500 },
      ]);
      assertTiling(result, 3, 4500);
    });

    it('normalizes punctuation and case on both sides; standalone punctuation is skipped', () => {
      const script = makeScenes("Don't panic!", [
        "It's fine — really.",
        '"Ninety percent" is empty...',
      ]);
      const words = timeline("Don't panic It's fine really Ninety percent is empty");
      const result = computeSceneWindows(script, words, 2700);
      expect(result.method).toBe('aligned');
      // the narration's standalone '—' has no aligner counterpart and is skipped;
      // 'Ninety' is word 5 → startMs 1500
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 1500 },
        { startMs: 1500, endMs: 2700 },
      ]);
      assertTiling(result, 2, 2700);
    });

    it('a word duplicated across a boundary anchors on the SECOND occurrence', () => {
      const script = makeScenes('Look up', ['You see the moon.', 'Moon dust is deadly.']);
      const words = timeline('Look up You see the moon Moon dust is deadly');
      const result = computeSceneWindows(script, words, 3300);
      expect(result.method).toBe('aligned');
      // scene 2's 'Moon' is word 6 (startMs 1800) — NOT scene 1's 'moon' at 1500.
      // A naive indexOf search would anchor at 1500; the sequential pointer walk
      // must consume scene 1's 'moon' first.
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 1800 },
        { startMs: 1800, endMs: 3300 },
      ]);
      assertTiling(result, 2, 3300);
    });

    it('single scene with a matching timeline is aligned and spans everything', () => {
      const script = makeScenes('Hi', ['Just one scene here.']);
      const result = computeSceneWindows(script, timeline('Hi Just one scene here'), 2000);
      expect(result.method).toBe('aligned');
      expect(result.windows).toEqual([{ startMs: 0, endMs: 2000 }]);
      assertTiling(result, 1, 2000);
    });
  });
  ```

- [ ] **Step 6: Run the test file — expect the 4 new tests to FAIL**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: 5 pass, 4 fail. Every new test fails on its first assertion:
  `AssertionError: expected 'proportional' to be 'aligned'` — the implementation never aligns yet.

- [ ] **Step 7: Implement the aligned token walk (strict version)**

  In `src/stages/scene-windows.ts`, insert this function between `proportionalStarts` and `computeSceneWindows`:

  ```ts
  /**
   * Walk the expected token sequence (hook, then each scene's narration — the
   * same composition narrationText() speaks) against the aligner's word
   * timeline. Returns per-scene start boundaries (scene k's boundary = startMs
   * of the word matched to its first token), or null when a scene's first token
   * cannot be anchored — the caller then falls back to proportional allocation.
   */
  function tryAlignedStarts(
    hookTokens: string[],
    sceneTokens: string[][],
    words: WordTiming[],
  ): number[] | null {
    // A scene whose narration normalized to nothing has no first token to
    // anchor a boundary on; alignment cannot place it.
    if (sceneTokens.some((tokens) => tokens.length === 0)) return null;

    const actual = words
      .map((w) => ({ token: normalizeToken(w.word), startMs: w.startMs }))
      .filter((w) => w.token.length > 0);

    interface ExpectedToken {
      token: string;
      sceneIndex: number | null; // set on each scene's FIRST token only
    }
    const expected: ExpectedToken[] = hookTokens.map((token) => ({ token, sceneIndex: null }));
    sceneTokens.forEach((tokens, k) => {
      tokens.forEach((token, i) => expected.push({ token, sceneIndex: i === 0 ? k : null }));
    });

    const starts = new Array<number>(sceneTokens.length).fill(0);
    let p = 0;
    for (const e of expected) {
      if (p >= actual.length || actual[p].token !== e.token) return null;
      if (e.sceneIndex !== null) starts[e.sceneIndex] = actual[p].startMs;
      p += 1;
    }
    starts[0] = 0; // scene 1 covers the hook from t=0
    return starts;
  }
  ```

  Then replace the body of `computeSceneWindows` so it tries alignment first:

  ```ts
  export function computeSceneWindows(
    script: ScenesOutput,
    words: WordTiming[],
    totalDurationMs: number,
  ): SceneWindowsResult {
    const hookTokens = tokenize(script.hook);
    const sceneTokens = script.scenes.map((scene) => tokenize(scene.narration));
    if (sceneTokens.length === 0) return { windows: [], method: 'proportional' };

    const alignedStarts = tryAlignedStarts(hookTokens, sceneTokens, words);
    if (alignedStarts !== null) {
      return { windows: tile(alignedStarts, totalDurationMs), method: 'aligned' };
    }
    return {
      windows: tile(proportionalStarts(hookTokens, sceneTokens, totalDurationMs), totalDurationMs),
      method: 'proportional',
    };
  }
  ```

  `words` is now consumed, resolving Step 3's unused parameter. This walk is still strict (every expected token must match consecutively); Step 11 adds the drop/insert tolerance.

- [ ] **Step 8: Run the test file — expect 9 passing**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: `Tests  9 passed`. The 5 proportional tests must still pass: zero scenes short-circuits before the walk; the all-punctuation case hits the empty-scene-tokens guard; and every empty-`words[]` case fails the walk on its first expected token (`p >= actual.length`) — all landing in the proportional branch.

- [ ] **Step 9: Write the failing alignment-tolerance tests**

  Append this describe block at the end of `src/stages/scene-windows.test.ts`:

  ```ts
  describe('computeSceneWindows — alignment tolerance', () => {
    it('stays aligned when the aligner dropped a mid-scene word', () => {
      const script = makeScenes('Space is weird', ['The moon drifts away.', 'Every single year.']);
      const words = timeline('Space is weird The moon away Every single year'); // 'drifts' dropped
      const result = computeSceneWindows(script, words, 3000);
      expect(result.method).toBe('aligned');
      // 'Every' is word 6 → startMs 1800
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 1800 },
        { startMs: 1800, endMs: 3000 },
      ]);
      assertTiling(result, 2, 3000);
    });

    it('skips an inserted spurious word and anchors the boundary on the real word', () => {
      const script = makeScenes('Space is weird', ['The moon drifts away.', 'Every single year.']);
      const words = timeline('Space is weird The moon drifts away uh Every single year'); // 'uh' inserted
      const result = computeSceneWindows(script, words, 3300);
      expect(result.method).toBe('aligned');
      // 'Every' is word 8 → startMs 2400; the walk skipped 'uh'
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 2400 },
        { startMs: 2400, endMs: 3300 },
      ]);
      assertTiling(result, 2, 3300);
    });

    it("falls back to proportional when a scene's first token cannot be matched", () => {
      const script = makeScenes('Hi there', ['Alpha beta gamma.', 'Delta epsilon zeta.']);
      const words = timeline('Hi there alpha beta gamma deltoid epsilon zeta'); // boundary word garbled
      const result = computeSceneWindows(script, words, 8000);
      expect(result.method).toBe('proportional');
      // weights: scene1 = 2 hook + 3 = 5 (of 8) → boundary at 5000
      expect(result.windows).toEqual([
        { startMs: 0, endMs: 5000 },
        { startMs: 5000, endMs: 8000 },
      ]);
      assertTiling(result, 2, 8000);
    });
  });
  ```

- [ ] **Step 10: Run the test file — expect exactly 2 new failures**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: 10 pass, 2 fail. The dropped-word and inserted-word tests fail with
  `AssertionError: expected 'proportional' to be 'aligned'` — the strict walk bails on the first mismatch. The garbled-boundary fallback test passes already (the strict walk also returns null there); it is included now because it pins the behavior the tolerance upgrade must NOT change: a scene's first token failing to match within the skip budget still means proportional. If either of the other two tests passes here, stop — re-read the Step 7 loop, it should have no tolerance yet.

- [ ] **Step 11: Upgrade the walk with a bounded skip budget and drop tolerance**

  In `src/stages/scene-windows.ts`, add this constant directly above `tryAlignedStarts`:

  ```ts
  // The aligner (WhisperX or grouped ElevenLabs timings) sometimes inserts or
  // splits words. When hunting for the next expected token we look at most this
  // many actual words past the pointer before treating the expected token as
  // dropped. Small on purpose: an unbounded search could leap across scenes and
  // anchor a boundary at a coincidental later occurrence of the same word.
  const MAX_SKIP_AHEAD = 2;
  ```

  Then replace the matching loop inside `tryAlignedStarts` — everything from `let p = 0;` through the end of the `for (const e of expected)` block — with:

  ```ts
    let p = 0;
    for (const e of expected) {
      // Hunt for the expected token at the pointer, skipping up to
      // MAX_SKIP_AHEAD non-matching actual words.
      let matchedAt = -1;
      for (let j = 0; j <= MAX_SKIP_AHEAD && p + j < actual.length; j++) {
        if (actual[p + j].token === e.token) {
          matchedAt = p + j;
          break;
        }
      }
      if (matchedAt === -1) {
        // Not found. A scene's first token must anchor a boundary — give up and
        // let the caller fall back to proportional. Any other token was likely
        // dropped or merged by the aligner: move on without consuming actual
        // words, so the pointer still sits on the next real word.
        if (e.sceneIndex !== null) return null;
        continue;
      }
      if (e.sceneIndex !== null) starts[e.sceneIndex] = actual[matchedAt].startMs;
      p = matchedAt + 1;
    }
  ```

  The surrounding code (`actual`, `expected`, `starts` construction, the trailing `starts[0] = 0; return starts;`) is unchanged. When every token matches at offset 0 this behaves identically to the strict walk, so the Step 5 tests stay green.

- [ ] **Step 12: Run the test file — expect all 12 passing**

  ```sh
  pnpm vitest run src/stages/scene-windows.test.ts
  ```

  Expected: `Test Files  1 passed`, `Tests  12 passed`. Walkthrough of the dropped-word case if it fails: expected `drifts` is absent from `actual[p..p+2]` (`away`, `Every`, `single`) → treated as dropped, pointer unmoved; next expected `away` matches at offset 0; boundary `every` then matches at startMs 1800.

- [ ] **Step 13: Full suite and build gate**

  ```sh
  pnpm test
  pnpm build
  ```

  Expected: every test file passes — the whole suite as of Task 11 plus this file's 12 tests, zero failures (`golden-path.test.ts` does a real Remotion render; allow it a minute) — and `pnpm build` (`tsc --noEmit && tsc -p remotion --noEmit`) exits 0 with no output. This module touches no existing file, so any other failure is pre-existing — do not proceed past it without investigating.

- [ ] **Step 14: Commit**

  ```sh
  git add src/stages/scene-windows.ts src/stages/scene-windows.test.ts
  git commit -m "feat: add deterministic scene-window computation for premium visuals"
  ```

---

### Task 13: Premium visuals stage

**Files:**
- Create: `src/stages/visuals-premium.ts`
- Test: `src/stages/visuals-premium.test.ts` (create)

**Interfaces:**
- Consumes (all exist when this task starts):
  - `src/jobs/types.ts` (existing): `interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }`; `interface JobContext { jobId; db; channel; tier; topic; runDir; artifactPath(stage, file): string; log }` — `artifactPath` mkdirs the stage dir and returns the joined path.
  - `src/jobs/costs.ts` (existing + Task 6): `class BudgetExceededError extends Error`; `recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void`; **Task 6 signature** `assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void` — with `tier === 'premium'` the per-video cap is `channel.budget.premiumPerVideoUsdMicros`.
  - `src/providers/anthropic.ts` (Task 7): `visionJudgment<T>(opts: { model: string; system: string; prompt: string; imagePaths: string[]; schema: z.ZodType<T>; maxTokens?: number; client?: Anthropic }): Promise<{ data: T; cost: LlmUsageCost }>` where `LlmUsageCost = { usdMicros: number }`.
  - `src/providers/fal.ts` (Task 8): `estimateImageCostMicros(model: string): number`; `estimateVideoCostMicros(model: string, durationSec: number): number`; `generateImage(opts: { model: string; prompt: string; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>`; `animateImage(opts: { model: string; imagePath: string; motionPrompt: string; durationSec: 5 | 10; outPath: string; client?: FalClientLike }): Promise<{ costUsdMicros: number }>`.
  - `src/stages/script.ts` (Task 10): `type ScriptArtifact = ScriptOutput | ScenesOutput`; `type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' }` (fields `hook`, `styleBlock`, `scenes: { narration; visualPrompt; motionPrompt }[]`, `platformMeta`); `isScenesOutput(s: ScriptArtifact): s is ScenesOutput`.
  - `src/stages/scene-windows.ts` (Task 12): `computeSceneWindows(script: ScenesOutput, words: WordTiming[], totalDurationMs: number): SceneWindowsResult` — pure, never throws; `windows.length === script.scenes.length`; windows tile `[0, totalDurationMs]` exactly; empty `words[]` → `method: 'proportional'`.
  - `src/providers/whisperx.ts` (existing): `interface WordTiming { word: string; startMs: number; endMs: number }`.
  - `src/config/channel.ts` (Task 5): `channel.premium: PremiumConfig` (`{ imageModel: string; videoModel: string; stylePrefix?: string; sceneConcurrency: number }`), `channel.budget.premiumPerVideoUsdMicros: number`, `channel.scriptModel: string`.
  - `src/stages/_testkit.ts` (existing + Task 5): `testChannel(overrides?)` (post-Task-5 it carries `premium` defaults and `budget.premiumPerVideoUsdMicros: 7_000_000`; `scriptModel: 'claude-sonnet-5'`), `makeCtx(channel?, topic?)` (returns a volume-tier ctx with an in-memory db and tmp runDir), `testScript()` (a story-format `ScriptOutput` with no `format` field).
  - Artifacts read (written by Tasks 10/11): `runs/<jobId>/script/script.json` (`ScenesOutput`), `runs/<jobId>/captions/words.json` (`{ words: WordTiming[] }`), `runs/<jobId>/voice/voice.json` (`VoiceMeta`; only `durationMs: number` is read here, so the stage parses the narrow shape like `visuals-volume.ts` does).
- Produces (consumed by Task 14 assemble, Task 15 qc, Task 16 CLI):

```ts
// src/stages/visuals-premium.ts
export const ESTIMATED_VISION_COST_MICROS = 15_000
export interface SceneManifestEntry {
  index: number            // 1-based, matching the scene-NN file names
  startMs: number
  endMs: number
  keyframe: string         // file name relative to the visuals artifact dir, e.g. 'scene-01.png'
  clip: string             // e.g. 'scene-01.mp4'
  clipDurationSec: 5 | 10  // rule: windowMs <= 5000 ? 5 : 10
  imageAttempts: number    // 0 when the scene was reused from a previous attempt
  videoAttempts: number    // 0 when reused
  costUsdMicros: number    // total per-scene spend this run; 0 when reused
}
export interface ScenesManifest { method: 'aligned' | 'proportional'; scenes: SceneManifestEntry[] }
export const visualsPremiumStage: StageDef   // name: 'visuals'
export function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]>
```

  Binding semantics for consumers:
  - Artifacts on success: `runs/<jobId>/visuals/scene-NN.png` + `scene-NN.mp4` (NN 01-based zero-padded) and `runs/<jobId>/visuals/scenes.json` (a `ScenesManifest`, entries in scene order). `scenes.json` is written **only when every scene succeeded** — a failed run leaves the per-scene files of the scenes that did succeed (that is the resume checkpoint) but no manifest.
  - Failure semantics: every scene settles before the stage raises (max resume progress). If any scene's error is a `BudgetExceededError`, **that error object** is rethrown so the runner parks the job `blocked`; otherwise an aggregate `Error` naming the failed scene numbers. Resume rule: a scene whose `scene-NN.mp4` already exists is skipped at zero cost.
  - `mapWithConcurrency`: ordered results (result `[i]` corresponds to item `[i]`), at most `limit` callbacks in flight, and every item runs to settlement even after an earlier item's callback rejects; only after all settle does it reject with the first error. Task 16 imports `visualsPremiumStage` from `./stages/visuals-premium.js` for the premium stage list.

- [ ] **Step 1: Write the failing `mapWithConcurrency` tests.** Create `src/stages/visuals-premium.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './visuals-premium.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('maps every item, preserving input order in the results', async () => {
    // Completion order is 1, 2, 3 (shortest sleep first); result order must be input order.
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await sleep(n * 10);
      return n * 100;
    });
    expect(out).toEqual([300, 100, 200]);
  });

  it('never runs more than `limit` callbacks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // it is a cap, not serialization
  });

  it('lets every item settle before rejecting with the first error', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
        started.push(i);
        await sleep(5);
        if (i === 1) throw new Error(`boom ${i}`);
        return i;
      }),
    ).rejects.toThrow('boom 1');
    // Items queued after the failing one still ran: failures must not starve
    // later scenes of their chance to land artifacts (max resume progress).
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/stages/visuals-premium.test.ts`. Expected failure: the suite errors at load with `Failed to resolve import "./visuals-premium.js" from "src/stages/visuals-premium.test.ts". Does the file exist?` — 0 tests run.

- [ ] **Step 3: Implement `mapWithConcurrency`.** Create `src/stages/visuals-premium.ts` with only the utility (the stage arrives in Step 7):

```ts
/**
 * Ordered concurrency-limited map. Every item runs to settlement even after an
 * earlier item's callback rejects (maximum resume progress: later scenes still
 * land their artifacts); only once all items have settled does the first error
 * propagate. Results are index-aligned with `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(Math.floor(limit), items.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  );
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}
```

- [ ] **Step 4: Run the test expecting pass.** Command: `pnpm vitest run src/stages/visuals-premium.test.ts`. Expected: `Tests  3 passed (3)`.

- [ ] **Step 5: Write the failing stage tests.** Replace `src/stages/visuals-premium.test.ts` in full (the `mapWithConcurrency` describe block from Step 1 is carried over unchanged at the end; new: the module mocks, fixtures, and the `visualsPremiumStage` describe block). `providers/fal.js` and `providers/anthropic.js` are module-mocked, so no test here can touch the network; `assertBudget`/`recordCost` and `computeSceneWindows` are deliberately real (empty `words[]` pins the deterministic proportional path per the Task 12 contract). The reservation test additionally pins the stage's in-process reservation counter: with real `assertBudget`, scene B's gate must trip on scene A's un-ledgered in-flight estimate BEFORE B's provider is ever dialed — a plain read-the-ledger gate would let both scenes through the same headroom.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';

// Module mocks are hoisted above the imports below. The anthropic factory also
// stubs structuredCompletion: script.ts (imported for isScenesOutput) pulls it
// from the same module, and vitest 4 fails the import graph when a mocked
// module lacks an export that anything in the graph imports.
vi.mock('../providers/fal.js', () => ({
  estimateImageCostMicros: vi.fn(() => 30_000),
  estimateVideoCostMicros: vi.fn((_model: string, durationSec: number) => durationSec * 70_000),
  generateImage: vi.fn(),
  animateImage: vi.fn(),
}));
vi.mock('../providers/anthropic.js', () => ({
  visionJudgment: vi.fn(),
  structuredCompletion: vi.fn(),
}));

import { animateImage, estimateImageCostMicros, estimateVideoCostMicros, generateImage } from '../providers/fal.js';
import { visionJudgment } from '../providers/anthropic.js';
import { BudgetExceededError } from '../jobs/costs.js';
import {
  ESTIMATED_VISION_COST_MICROS,
  mapWithConcurrency,
  visualsPremiumStage,
  type ScenesManifest,
} from './visuals-premium.js';
import { makeCtx, testChannel, testScript } from './_testkit.js';
import type { ScenesOutput } from './script.js';
import type { ChannelConfig } from '../config/channel.js';
import type { JobContext } from '../jobs/types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The mocks never decode files, so magic-number-only bytes are enough.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const IMAGE_COST = 30_000; // what the mocked generateImage/estimateImageCostMicros report
const VISION_COST = 4_000; // what the mocked visionJudgment reports as actual cost
const VIDEO_COST = 350_000; // what the mocked animateImage reports

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
};

function scenesScript(sceneCount: number): ScenesOutput {
  return {
    format: 'scenes',
    hook: 'Three impossible deep sea facts',
    styleBlock: 'Dark teal documentary style, volumetric god rays, 35mm film grain.',
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      narration: `Scene ${i + 1} narration sentence here.`,
      visualPrompt: `Visual for scene ${i + 1}`,
      motionPrompt: `Slow push-in ${i + 1}`,
    })),
    platformMeta: PLATFORM_META,
  };
}

// Test-local model ids prove the stage passes channel.premium through rather
// than hard-coding fal endpoint ids.
function premiumChannel(sceneConcurrency = 3): ChannelConfig {
  return testChannel({
    premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency },
  });
}

function premiumCtx(channel: ChannelConfig = premiumChannel()): JobContext {
  // makeCtx builds a volume-tier context; the stage never reads the jobs row,
  // so overriding ctx.tier in place is sufficient and keeps _testkit untouched.
  return { ...makeCtx(channel), tier: 'premium' };
}

async function seedArtifacts(ctx: JobContext, script: object, durationMs: number): Promise<void> {
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(script));
  // Empty words[] forces computeSceneWindows down its deterministic
  // proportional path (Task 12 contract), decoupling these tests from
  // aligned-matching internals.
  await fs.writeFile(ctx.artifactPath('captions', 'words.json'), JSON.stringify({ words: [] }));
  await fs.writeFile(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs }),
  );
}

async function readManifest(ctx: JobContext): Promise<ScenesManifest> {
  return JSON.parse(await fs.readFile(ctx.artifactPath('visuals', 'scenes.json'), 'utf8')) as ScenesManifest;
}

beforeEach(() => {
  // Clears calls but keeps factory implementations (estimate* stay priced).
  vi.clearAllMocks();
  vi.mocked(generateImage).mockImplementation(async ({ outPath }) => {
    await fs.writeFile(outPath, PNG_BYTES);
    return { costUsdMicros: IMAGE_COST };
  });
  vi.mocked(animateImage).mockImplementation(async ({ outPath }) => {
    await fs.writeFile(outPath, MP4_BYTES);
    return { costUsdMicros: VIDEO_COST };
  });
  vi.mocked(visionJudgment).mockResolvedValue({
    data: { pass: true, critique: '' },
    cost: { usdMicros: VISION_COST },
  });
});

describe('visualsPremiumStage', () => {
  it('generates keyframe -> vision check -> clip per scene and writes the manifest', async () => {
    const ctx = premiumCtx();
    const script = scenesScript(3);
    await seedArtifacts(ctx, script, 24_000);

    await visualsPremiumStage.run(ctx);

    const manifest = await readManifest(ctx);
    expect(manifest.method).toBe('proportional'); // empty words[] (Task 12 contract)
    expect(manifest.scenes).toHaveLength(3);
    expect(manifest.scenes[0].startMs).toBe(0);
    expect(manifest.scenes[2].endMs).toBe(24_000);
    manifest.scenes.forEach((entry, k) => {
      expect(entry.index).toBe(k + 1);
      expect(entry.keyframe).toBe(`scene-0${k + 1}.png`);
      expect(entry.clip).toBe(`scene-0${k + 1}.mp4`);
      expect(existsSync(ctx.artifactPath('visuals', entry.keyframe))).toBe(true);
      expect(existsSync(ctx.artifactPath('visuals', entry.clip))).toBe(true);
      expect(entry.clipDurationSec).toBe(entry.endMs - entry.startMs <= 5000 ? 5 : 10);
      expect(entry.imageAttempts).toBe(1);
      expect(entry.videoAttempts).toBe(1);
      expect(entry.costUsdMicros).toBe(IMAGE_COST + VISION_COST + VIDEO_COST);
      if (k > 0) expect(entry.startMs).toBe(manifest.scenes[k - 1].endMs); // exact tiling
    });

    // Keyframe prompt = styleBlock + visualPrompt; model ids come from channel.premium.
    const imageCalls = vi.mocked(generateImage).mock.calls.map((c) => c[0]);
    expect(imageCalls.map((c) => c.model)).toEqual(Array.from({ length: 3 }, () => 'test-image-model'));
    expect(imageCalls.map((c) => c.prompt)).toContain(`${script.styleBlock}\n\nVisual for scene 1`);
    expect(vi.mocked(estimateImageCostMicros)).toHaveBeenCalledWith('test-image-model');

    // Vision check: channel's script model, exactly the one keyframe attached.
    const visionCall = vi.mocked(visionJudgment).mock.calls[0][0];
    expect(visionCall.model).toBe('claude-sonnet-5');
    expect(visionCall.imagePaths).toHaveLength(1);
    expect(visionCall.imagePaths[0].endsWith('.png')).toBe(true);

    // Animate: keyframe in, window-derived native duration (6s window -> 10s clip).
    const scene2 = vi.mocked(animateImage).mock.calls.map((c) => c[0]).find((c) => c.outPath.endsWith('scene-02.mp4'));
    expect(scene2).toBeDefined();
    expect(scene2?.model).toBe('test-video-model');
    expect(scene2?.motionPrompt).toBe('Slow push-in 2');
    expect(scene2?.durationSec).toBe(10);
    expect(scene2?.imagePath.endsWith('scene-02.png')).toBe(true);
    expect(vi.mocked(estimateVideoCostMicros)).toHaveBeenCalledWith('test-video-model', 10);

    // Every paid call landed in the ledger under its provider/operation.
    const rows = ctx.db
      .prepare(
        'SELECT provider, operation, COUNT(*) AS n, SUM(usd_micros) AS total FROM costs WHERE job_id = ? GROUP BY provider, operation ORDER BY provider, operation',
      )
      .all(ctx.jobId) as { provider: string; operation: string; n: number; total: number }[];
    expect(rows).toEqual([
      { provider: 'anthropic', operation: 'keyframe-check', n: 3, total: 3 * VISION_COST },
      { provider: 'fal', operation: 'image', n: 3, total: 3 * IMAGE_COST },
      { provider: 'fal', operation: 'video', n: 3, total: 3 * VIDEO_COST },
    ]);
    expect(ESTIMATED_VISION_COST_MICROS).toBe(15_000);
  });

  it('regenerates a rejected keyframe with the critique appended, then passes', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(1), 4_000); // 4s window -> 5s clip
    vi.mocked(visionJudgment)
      .mockResolvedValueOnce({
        data: { pass: false, critique: 'subject is missing from frame' },
        cost: { usdMicros: VISION_COST },
      })
      .mockResolvedValueOnce({ data: { pass: true, critique: '' }, cost: { usdMicros: VISION_COST } });

    await visualsPremiumStage.run(ctx);

    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(2);
    const retryPrompt = vi.mocked(generateImage).mock.calls[1][0].prompt;
    expect(retryPrompt).toContain('Visual for scene 1');
    expect(retryPrompt).toContain('subject is missing from frame');

    const manifest = await readManifest(ctx);
    expect(manifest.scenes[0].imageAttempts).toBe(2);
    expect(manifest.scenes[0].videoAttempts).toBe(1);
    expect(manifest.scenes[0].clipDurationSec).toBe(5);
    expect(manifest.scenes[0].costUsdMicros).toBe(2 * IMAGE_COST + 2 * VISION_COST + VIDEO_COST);
    expect(vi.mocked(animateImage).mock.calls[0][0].durationSec).toBe(5);
  });

  it('fails the stage after 3 rejected keyframes but still settles the other scene', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(2), 16_000);
    vi.mocked(visionJudgment).mockImplementation(async ({ prompt }) =>
      prompt.includes('Visual for scene 1')
        ? { data: { pass: false, critique: 'wrong subject entirely' }, cost: { usdMicros: VISION_COST } }
        : { data: { pass: true, critique: '' }, cost: { usdMicros: VISION_COST } },
    );

    await expect(visualsPremiumStage.run(ctx)).rejects.toThrow(
      /scene 01: keyframe rejected after 3 attempts: wrong subject entirely/,
    );

    const scene1Calls = vi.mocked(generateImage).mock.calls.filter((c) => c[0].prompt.includes('Visual for scene 1'));
    expect(scene1Calls).toHaveLength(3);
    // Scene 2 settled: its clip landed even though the stage failed (resume checkpoint).
    expect(existsSync(ctx.artifactPath('visuals', 'scene-02.mp4'))).toBe(true);
    // No manifest on failure: a resume re-runs the stage and rebuilds it.
    expect(existsSync(ctx.artifactPath('visuals', 'scenes.json'))).toBe(false);
  });

  it('reuses a scene whose clip already exists (resume) without provider calls for it', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, scenesScript(2), 16_000);
    await fs.writeFile(ctx.artifactPath('visuals', 'scene-01.mp4'), MP4_BYTES); // prior attempt's checkpoint

    await visualsPremiumStage.run(ctx);

    const outPaths = [
      ...vi.mocked(generateImage).mock.calls.map((c) => c[0].outPath),
      ...vi.mocked(animateImage).mock.calls.map((c) => c[0].outPath),
    ];
    expect(outPaths).toHaveLength(2); // one image + one video, both for scene 2
    for (const p of outPaths) expect(p).toMatch(/scene-02/);
    expect(vi.mocked(visionJudgment)).toHaveBeenCalledTimes(1);

    const manifest = await readManifest(ctx);
    expect(manifest.scenes[0]).toMatchObject({
      clip: 'scene-01.mp4',
      imageAttempts: 0,
      videoAttempts: 0,
      costUsdMicros: 0,
    });
    expect(manifest.scenes[1]).toMatchObject({ imageAttempts: 1, videoAttempts: 1 });

    const spend = ctx.db
      .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { total: number };
    expect(spend.total).toBe(IMAGE_COST + VISION_COST + VIDEO_COST); // scene 2 only
  });

  it('propagates BudgetExceededError before any paid call when the premium cap is too low', async () => {
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 3 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 10, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(3), 24_000);

    // Real assertBudget (not mocked): tier 'premium' selects premiumPerVideoUsdMicros,
    // and the 30_000-micro image estimate exceeds the 10-micro cap immediately. If the
    // stage passed 'volume' by mistake, the 8_000_000 volume cap would let this through.
    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();
  });

  it('propagates BudgetExceededError at the animate gate after image+vision spend', async () => {
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 3 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 100_000, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(1), 4_000); // 4s window -> 5s clip

    // Real assertBudget again, but the cap trips one gate later: the image gate
    // reserves the 30_000-micro estimate against 0 spent (passes), the vision
    // gate reserves ESTIMATED_VISION_COST_MICROS 15_000 against the 30_000
    // already ledgered (45_000, passes), then the video gate reserves
    // 5 * 70_000 = 350_000 against the 34_000 spent so far — 384_000 blows
    // the 100_000-micro premium cap before animateImage is ever dialed.
    // (One sequential scene: each gate runs after the prior call's reservation
    // was released in `finally`, so the in-flight term is 0 at every gate here.)
    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(visionJudgment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();

    // The image and vision spend that preceded the breach is ledgered.
    const spend = ctx.db
      .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
      .get(ctx.jobId) as { total: number };
    expect(spend.total).toBe(IMAGE_COST + VISION_COST);
  });

  it('reserves in-flight estimates so concurrent scenes cannot jointly overshoot the cap', async () => {
    // Cap sized so ONE 30_000-micro image gate fits but two cannot both fit.
    // Scene A's gate passes (0 spent + 30_000 <= 45_000) and reserves 30_000
    // while its generateImage is in flight; scene B's gate then projects
    // 30_000 (estimate) + 30_000 (in-flight reservation) = 60_000 > 45_000 and
    // trips BEFORE generateImage is ever dialed for B. Without the reservation
    // both gates would read the same 0-spend ledger and both scenes would pay.
    // Scene A then continues alone: its vision gate projects exactly 45_000
    // (equal-to-cap passes, Task 6) and its 700_000-micro video gate trips —
    // either scene's error is a BudgetExceededError, so the stage rethrows it
    // and the runner parks the job 'blocked'.
    const channel = testChannel({
      premium: { imageModel: 'test-image-model', videoModel: 'test-video-model', sceneConcurrency: 2 },
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 45_000, perDayUsdMicros: 20_000_000 },
    });
    const ctx = premiumCtx(channel);
    await seedArtifacts(ctx, scenesScript(2), 16_000);

    await expect(visualsPremiumStage.run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);

    // Exactly one image was generated (scene A's); scene B was gated pre-call,
    // so at most one image cost row can exist in the ledger.
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(animateImage)).not.toHaveBeenCalled();
    const imageRows = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM costs WHERE job_id = ? AND provider = 'fal' AND operation = 'image'")
      .get(ctx.jobId) as { n: number };
    expect(imageRows.n).toBe(1);
  });

  it('caps concurrent scene work at channel.premium.sceneConcurrency', async () => {
    const ctx = premiumCtx(premiumChannel(2));
    await seedArtifacts(ctx, scenesScript(6), 60_000);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(generateImage).mockImplementation(async ({ outPath }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight -= 1;
      await fs.writeFile(outPath, PNG_BYTES);
      return { costUsdMicros: IMAGE_COST };
    });

    await visualsPremiumStage.run(ctx);

    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // a cap, not full serialization
  });

  it('hard-fails on a story-format script before any provider call', async () => {
    const ctx = premiumCtx();
    await seedArtifacts(ctx, testScript(), 10_000); // volume-format script: no `format` field

    await expect(visualsPremiumStage.run(ctx)).rejects.toThrow(/scenes-format script/);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });
});

describe('mapWithConcurrency', () => {
  it('maps every item, preserving input order in the results', async () => {
    // Completion order is 1, 2, 3 (shortest sleep first); result order must be input order.
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await sleep(n * 10);
      return n * 100;
    });
    expect(out).toEqual([300, 100, 200]);
  });

  it('never runs more than `limit` callbacks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(10);
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // it is a cap, not serialization
  });

  it('lets every item settle before rejecting with the first error', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
        started.push(i);
        await sleep(5);
        if (i === 1) throw new Error(`boom ${i}`);
        return i;
      }),
    ).rejects.toThrow('boom 1');
    // Items queued after the failing one still ran: failures must not starve
    // later scenes of their chance to land artifacts (max resume progress).
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
```

- [ ] **Step 6: Run the test expecting failure.** Command: `pnpm vitest run src/stages/visuals-premium.test.ts`. Expected failure: module link error `SyntaxError: The requested module './visuals-premium.js' does not provide an export named 'ESTIMATED_VISION_COST_MICROS'` (the runtime names whichever missing binding it checks first — `visualsPremiumStage` is equally possible). All 12 tests in the file are reported failed/unrun, including the 3 passing `mapWithConcurrency` ones; they come back in Step 8.

- [ ] **Step 7: Implement the stage.** Replace `src/stages/visuals-premium.ts` in full (the `mapWithConcurrency` from Step 3 is carried over unchanged):

```ts
import { existsSync, promises as fs } from 'node:fs';
import { z } from 'zod';
import { assertBudget, recordCost, BudgetExceededError } from '../jobs/costs.js';
import type { JobContext, StageDef } from '../jobs/types.js';
import { visionJudgment } from '../providers/anthropic.js';
import { animateImage, estimateImageCostMicros, estimateVideoCostMicros, generateImage } from '../providers/fal.js';
import type { WordTiming } from '../providers/whisperx.js';
import { computeSceneWindows } from './scene-windows.js';
import { isScenesOutput, type ScenesOutput, type ScriptArtifact } from './script.js';

// Pre-flight budget reservation for one keyframe vision check (~$0.015 of
// Sonnet 5 with a single image attached); the ledger records the actual
// token-priced cost afterwards. Same estimate the qc vision spot check uses.
export const ESTIMATED_VISION_COST_MICROS = 15_000;

// Keyframe loop: attempt counts include the first try, so 3 = one generation
// plus up to two critique-driven regenerations (spec 4.4). Animate: one retry
// on provider error.
const MAX_IMAGE_ATTEMPTS = 3;
const MAX_VIDEO_ATTEMPTS = 2;

export interface SceneManifestEntry {
  index: number; // 1-based, matching the scene-NN file names
  startMs: number;
  endMs: number;
  keyframe: string; // file name relative to the visuals artifact dir
  clip: string; // file name relative to the visuals artifact dir
  clipDurationSec: 5 | 10; // smallest native clip length covering the window
  imageAttempts: number; // 0 when the scene was reused from a previous attempt
  videoAttempts: number; // 0 when reused
  costUsdMicros: number; // per-scene spend this run; 0 when reused
}

export interface ScenesManifest {
  method: 'aligned' | 'proportional';
  scenes: SceneManifestEntry[];
}

/**
 * Ordered concurrency-limited map. Every item runs to settlement even after an
 * earlier item's callback rejects (maximum resume progress: later scenes still
 * land their artifacts); only once all items have settled does the first error
 * propagate. Results are index-aligned with `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(Math.floor(limit), items.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  );
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}

const KeyframeJudgmentSchema = z.object({ pass: z.boolean(), critique: z.string() });

const KEYFRAME_JUDGE_SYSTEM =
  'You are a strict art director reviewing AI-generated keyframes for a short-form vertical video. ' +
  'Judge only what is actually visible in the image.';

function buildJudgePrompt(styleBlock: string, visualPrompt: string): string {
  return [
    'Review the attached keyframe candidate against its brief.',
    `Intended style: ${styleBlock}`,
    `Intended content: ${visualPrompt}`,
    'Pass it only if the image clearly depicts the intended content, roughly matches the intended style, ' +
      'and shows no mangled anatomy, garbled text, or incoherent composition.',
    'If it fails, set pass=false with one concrete, actionable critique for the next generation attempt; ' +
      'otherwise set pass=true with an empty critique.',
  ].join('\n\n');
}

type SceneOutcome =
  | { ok: true; entry: SceneManifestEntry }
  | { ok: false; sceneLabel: string; error: unknown };

export const visualsPremiumStage: StageDef = {
  name: 'visuals',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptArtifact;
    if (!isScenesOutput(script)) {
      // A premium visuals run over a story script means the job was scripted
      // for the wrong tier; nothing downstream can repair that, so fail hard.
      throw new Error(
        "visuals: premium visuals require a scenes-format script, but script.json is story-format (no format: 'scenes')",
      );
    }
    const { words } = JSON.parse(
      await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    ) as { words: WordTiming[] };
    const voice = JSON.parse(
      await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as { durationMs: number };

    const { windows, method } = computeSceneWindows(script, words, voice.durationMs);
    const { imageModel, videoModel, sceneConcurrency } = ctx.channel.premium;

    // In-process budget reservation. assertBudget alone races under scene
    // concurrency: every worker reads the same ledger, so with sceneConcurrency
    // > 1 several gates can pass on the same headroom before any actual cost
    // lands, jointly overshooting the cap. Single-process JS interleaves only
    // at awaits, so the synchronous check-then-reserve below (no await between
    // assertBudget and the increment) is atomic: an in-flight estimate counts
    // against the cap until fn() has ledgered the actual cost, and the
    // reservation is released in `finally`. This bounds spend for one produce
    // run — cross-process concurrency is out of scope until the Plan 3 daemon.
    let reservedMicros = 0;
    async function withBudget<T>(estimate: number, fn: () => Promise<T>): Promise<T> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, estimate + reservedMicros, 'premium');
      reservedMicros += estimate;
      try {
        return await fn();
      } finally {
        reservedMicros -= estimate;
      }
    }

    const perScene = async (scene: ScenesOutput['scenes'][number], i: number): Promise<SceneManifestEntry> => {
      const nn = String(i + 1).padStart(2, '0');
      const keyframeName = `scene-${nn}.png`;
      const clipName = `scene-${nn}.mp4`;
      const keyframePath = ctx.artifactPath('visuals', keyframeName);
      const clipPath = ctx.artifactPath('visuals', clipName);
      const { startMs, endMs } = windows[i];
      const clipDurationSec: 5 | 10 = endMs - startMs <= 5000 ? 5 : 10;

      // Per-scene resume checkpoint, one level below stage idempotency: a clip
      // on disk is a finished scene, so a re-run only pays for what is missing.
      if (existsSync(clipPath)) {
        ctx.log.info({ scene: nn }, 'visuals: clip exists, reusing');
        return {
          index: i + 1,
          startMs,
          endMs,
          keyframe: keyframeName,
          clip: clipName,
          clipDurationSec,
          imageAttempts: 0,
          videoAttempts: 0,
          costUsdMicros: 0,
        };
      }

      let costUsdMicros = 0;
      let imageAttempts = 0;
      let critique = '';
      let approved = false;
      while (!approved) {
        const prompt =
          `${script.styleBlock}\n\n${scene.visualPrompt}` +
          (critique === ''
            ? ''
            : `\n\nA previous attempt at this image was rejected for this reason; fix it: ${critique}`);
        // Gate + reserve, then generate + ledger inside the reservation window.
        const image = await withBudget(estimateImageCostMicros(imageModel), async () => {
          const result = await generateImage({ model: imageModel, prompt, outPath: keyframePath });
          recordCost(ctx.db, ctx.jobId, 'fal', 'image', result.costUsdMicros);
          return result;
        });
        imageAttempts += 1;
        costUsdMicros += image.costUsdMicros;

        const judgment = await withBudget(ESTIMATED_VISION_COST_MICROS, async () => {
          const result = await visionJudgment({
            model: ctx.channel.scriptModel,
            system: KEYFRAME_JUDGE_SYSTEM,
            prompt: buildJudgePrompt(script.styleBlock, scene.visualPrompt),
            imagePaths: [keyframePath],
            schema: KeyframeJudgmentSchema,
          });
          recordCost(ctx.db, ctx.jobId, 'anthropic', 'keyframe-check', result.cost.usdMicros);
          return result;
        });
        costUsdMicros += judgment.cost.usdMicros;

        if (judgment.data.pass) {
          approved = true;
        } else {
          critique = judgment.data.critique;
          if (imageAttempts >= MAX_IMAGE_ATTEMPTS) {
            throw new Error(`keyframe rejected after ${imageAttempts} attempts: ${critique}`);
          }
          ctx.log.warn({ scene: nn, critique }, 'visuals: keyframe rejected, regenerating');
        }
      }

      let videoAttempts = 0;
      let animated = false;
      while (!animated) {
        try {
          const video = await withBudget(estimateVideoCostMicros(videoModel, clipDurationSec), async () => {
            const result = await animateImage({
              model: videoModel,
              imagePath: keyframePath,
              motionPrompt: scene.motionPrompt,
              durationSec: clipDurationSec,
              outPath: clipPath,
            });
            recordCost(ctx.db, ctx.jobId, 'fal', 'video', result.costUsdMicros);
            return result;
          });
          videoAttempts += 1;
          costUsdMicros += video.costUsdMicros;
          animated = true;
        } catch (err) {
          // A budget breach is an enforcement outcome, not a retryable provider
          // error: withBudget's gate throws it before the provider is dialed,
          // and the retry loop must not swallow it.
          if (err instanceof BudgetExceededError) throw err;
          videoAttempts += 1;
          if (videoAttempts >= MAX_VIDEO_ATTEMPTS) {
            throw new Error(
              `animate failed after ${videoAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          ctx.log.warn({ scene: nn, err }, 'visuals: animate failed, retrying');
        }
      }

      return {
        index: i + 1,
        startMs,
        endMs,
        keyframe: keyframeName,
        clip: clipName,
        clipDurationSec,
        imageAttempts,
        videoAttempts,
        costUsdMicros,
      };
    };

    // perScene never rejects through mapWithConcurrency: each scene's error is
    // captured as a SceneOutcome so every scene settles and the stage decides
    // what to raise afterwards.
    const outcomes = await mapWithConcurrency(
      script.scenes,
      sceneConcurrency,
      async (scene, i): Promise<SceneOutcome> => {
        try {
          return { ok: true, entry: await perScene(scene, i) };
        } catch (error) {
          return { ok: false, sceneLabel: String(i + 1).padStart(2, '0'), error };
        }
      },
    );

    const failures = outcomes.filter((o): o is Extract<SceneOutcome, { ok: false }> => !o.ok);
    if (failures.length > 0) {
      // A budget breach must surface as itself so the runner parks the job
      // 'blocked' instead of 'failed'.
      const budget = failures
        .map((f) => f.error)
        .find((e): e is BudgetExceededError => e instanceof BudgetExceededError);
      if (budget) throw budget;
      const details = failures
        .map((f) => `scene ${f.sceneLabel}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join('; ');
      throw new Error(`visuals: ${failures.length}/${script.scenes.length} scene(s) failed: ${details}`);
    }

    const manifest: ScenesManifest = {
      method,
      scenes: outcomes.filter((o): o is Extract<SceneOutcome, { ok: true }> => o.ok).map((o) => o.entry),
    };
    await fs.writeFile(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest, null, 2));
    ctx.log.info({ scenes: manifest.scenes.length, method }, 'visuals: premium scenes complete');
  },
};
```

- [ ] **Step 8: Run the test expecting pass.** Command: `pnpm vitest run src/stages/visuals-premium.test.ts`. Expected: `Tests  12 passed (12)` — 9 stage tests (happy path with manifest/ledger/prompt assertions, critique-driven regeneration, 3-strikes scene failure with the sibling scene still settling, per-scene resume, `BudgetExceededError` propagation at zero provider calls, `BudgetExceededError` propagation at the animate gate after image+vision spend, in-flight reservation blocking the second concurrent image gate, concurrency cap, story-script hard fail) plus the 3 `mapWithConcurrency` tests. The reservation test only goes green because `withBudget` reserves synchronously — if it fails with `generateImage` called twice, the check and the increment got separated by an await; fix the implementation, not the test.

- [ ] **Step 9: Full suite and build.** Commands: `pnpm test` then `pnpm build`. Expected: the whole unit suite green (this file mocks `providers/fal.js` and `providers/anthropic.js` at the module level, so nothing touches the network; no repo file outside the two new ones changed), and both `tsc --noEmit` and `tsc -p remotion --noEmit` clean.

- [ ] **Step 10: Commit.** Command: `git add src/stages/visuals-premium.ts src/stages/visuals-premium.test.ts && git commit -m "feat: add premium visuals stage (keyframe, vision check, animate, manifest)"`.

---

---

### Task 14: Multi-clip assembly

**Files:**
- Modify: `src/remotion-types.ts`
- Modify: `remotion/ShortVideo.tsx`
- Modify: `src/stages/assemble.ts`
- Test: `src/stages/assemble.test.ts`
- Test: `remotion/remotion.test.ts` (the one existing `remotion/*.test.*` file — extended, not created)

**Interfaces:**
- Consumes:
  - `src/stages/visuals-premium.ts` (Task 13): `export interface SceneManifestEntry { index: number; startMs: number; endMs: number; keyframe: string; clip: string; clipDurationSec: 5 | 10; imageAttempts: number; videoAttempts: number; costUsdMicros: number }` and `export interface ScenesManifest { method: 'aligned' | 'proportional'; scenes: SceneManifestEntry[] }` — read from `runs/<jobId>/visuals/scenes.json`.
  - `src/media/ffmpeg.ts` (existing): `export async function probe(file: string): Promise<MediaProbe>` where `MediaProbe = { durationMs: number; width: number; height: number; hasAudio: boolean; fps: number }`.
  - `src/providers/whisperx.ts` (existing): `export interface WordTiming { word: string; startMs: number; endMs: number }`.
  - `src/config/channel.ts` (existing + Task 5): `CaptionStyle`, `ChannelConfig` (premium fields already present after Task 5).
  - `src/stages/_testkit.ts` (Task 5 state): `export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig`.
  - `src/jobs/types.ts` (existing): `JobContext`, `StageDef`.
  - Task 2's committed state of `src/stages/assemble.ts` (module-relative `REMOTION_ENTRY` via `fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))`, self-healing `bundlePromise` memo) and of `src/stages/assemble.test.ts` (`vi`/`afterEach`/`fileURLToPath` imports, `tmp`/`makeChannel`/`makeCtx`/`codecs`/`seedRenderInputs`/`mockRenderer` helpers, `assembleStage bundle robustness` describe). Both behaviors are preserved verbatim in the full file below.
- Produces (binding, per Interface Contract):
  - `src/remotion-types.ts`: `export type SceneClip = { src: string; durationMs: number; playbackRate: number }` and `export type ShortVideoProps = { audioSrc: string; backgroundSrc?: string; sceneClips?: SceneClip[]; bgmSrc?: string; bgmVolume?: number; words: WordTiming[]; style: CaptionStyle; durationMs: number }`. `trimStartMs` is intentionally omitted from `SceneClip` (an earlier spec draft sketched it): clips always play from t=0 and the `<Series>` window end trims them; the design spec has been corrected to match.
  - `src/stages/assemble.ts`: `export function fitClipToWindow(clipMs: number, windowMs: number): { playbackRate: number; durationMs: number }` — `windowMs <= clipMs → { playbackRate: 1, durationMs: windowMs }`; else `playbackRate = clipMs / windowMs` clamped to `>= 0.75`, `durationMs = windowMs`.
  - `assembleStage` (name `'assemble'`, signature unchanged) gains a premium branch that reads `visuals/scenes.json` and renders `sceneClips` props. Task 16's `golden-path-premium.test.ts` runs this stage with a premium `JobContext`; Task 15's QC probes the same `final.mp4`.

Background: today `assembleStage` always copies `visuals/background.mp4` into the bundle's `public/<jobId>/` and renders the single-background `ShortVideo` variant. Premium jobs have no `background.mp4` — they have `visuals/scene-NN.mp4` clips plus a `visuals/scenes.json` manifest with per-scene time windows. This task adds the tier branch: probe each clip's real duration (fal can deliver 5.04s for a "5s" clip), fit it to its window with `fitClipToWindow`, copy clips into `public/<jobId>/`, and render a `<Series>` of muted `<OffthreadVideo>` sequences. Narration always owns the audio track; captions and auto-ducked BGM are unchanged. The volume branch stays byte-identical in behavior.

One Remotion subtlety drives the component guard: Remotion shallow-merges `defaultProps` into `inputProps`, and `remotion/Root.tsx` declares `backgroundSrc: ''` in its `defaultProps`. A premium render passing only `sceneClips` therefore arrives at the component with `backgroundSrc: ''` also present. The "exactly one variant" guard must be truthiness-based (non-empty string / non-empty array), not `!== undefined`. Do not edit `Root.tsx` — its `defaultProps` stay valid because `backgroundSrc` is now optional.

- [ ] **Step 1: Write the failing `fitClipToWindow` tests.** In `src/stages/assemble.test.ts`, change the import of the module under test (currently `import { assembleStage } from './assemble.js'`) to:

```ts
import { assembleStage, fitClipToWindow } from './assemble.js'
```

Then append at the very end of the file:

```ts
// ── fitClipToWindow (pure duration-fitting rule) ─────────────────────────────

describe('fitClipToWindow', () => {
  it('trims at 1x when the window is shorter than the clip', () => {
    expect(fitClipToWindow(5000, 3000)).toEqual({ playbackRate: 1, durationMs: 3000 })
  })

  it('plays at 1x when the window exactly equals the clip', () => {
    expect(fitClipToWindow(5000, 5000)).toEqual({ playbackRate: 1, durationMs: 5000 })
  })

  it('slows playback proportionally when the window slightly exceeds the clip', () => {
    const fit = fitClipToWindow(5000, 5500)
    expect(fit.durationMs).toBe(5500)
    expect(fit.playbackRate).toBeCloseTo(5000 / 5500, 10)
  })

  it('clamps the slowdown at 0.75x (clip freezes on its last frame beyond that)', () => {
    expect(fitClipToWindow(5000, 10000)).toEqual({ playbackRate: 0.75, durationMs: 10000 })
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t fitClipToWindow
```

Expected: the whole file errors at load (so every test in it reports failed), with:

```
SyntaxError: The requested module './assemble.js' does not provide an export named 'fitClipToWindow'
```

- [ ] **Step 3: Minimal implementation.** In `src/stages/assemble.ts`, insert between the `getBundle()` function and `export const assembleStage`:

```ts
/**
 * Fit a probed clip into its scene window (both integer ms).
 * - Window shorter than (or equal to) the clip: play at 1x and trim — the
 *   Series.Sequence simply ends at windowMs.
 * - Window longer than the clip: slow playback to cover it, but never below
 *   0.75x. A clip exhausted at 0.75x freezes on its last frame for the
 *   remainder of the window; QC's freeze check bounds how bad that can get.
 *   Windows needing < 0.75x violate script-stage pacing constraints and are
 *   caught by QC's duration/coverage checks, not silently stretched further.
 */
export function fitClipToWindow(
  clipMs: number,
  windowMs: number,
): { playbackRate: number; durationMs: number } {
  if (windowMs <= clipMs) return { playbackRate: 1, durationMs: windowMs }
  return { playbackRate: Math.max(0.75, clipMs / windowMs), durationMs: windowMs }
}
```

- [ ] **Step 4: Run it — expect PASS, then full gates.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t fitClipToWindow
```

Expected: `4 passed` (all other tests in the file filtered out by `-t`). Then:

```bash
pnpm test
pnpm build
```

Expected: whole suite green (the real-render assemble test and `remotion.test.ts` take ~3 min each), both `tsc` passes clean.

- [ ] **Step 5: Commit.**

```bash
git add src/stages/assemble.ts src/stages/assemble.test.ts
git commit -m "feat: add fitClipToWindow scene-window fitting helper"
```

- [ ] **Step 6: Write the failing premium-assembly tests.** In `src/stages/assemble.test.ts`, add three imports (the vitest import already carries `vi` and `afterEach` since Task 2):

```ts
import { testChannel } from './_testkit.js'
import type { ScenesManifest } from './visuals-premium.js'
import type { ShortVideoProps } from '../remotion-types.js'
```

Then append at the very end of the file:

```ts
// ── Premium multi-clip assembly ──────────────────────────────────────────────
// Two layers: a fast test that mocks @remotion/{bundler,renderer} (same
// vi.doMock + vi.resetModules + dynamic-import pattern as the bundle-robustness
// block above — the static `assembleStage` import stays bound to the REAL
// modules) and asserts the exact props handed to renderMedia; and a real-render
// integration test that produces an actual final.mp4 from lavfi fixture clips.

function makePremiumCtx(runDir: string, channel: ChannelConfig): JobContext {
  return {
    jobId: 'job-assemble-premium',
    db: openDb(':memory:'),
    channel,
    tier: 'premium',
    topic: 'test topic',
    runDir,
    artifactPath(stage, file) {
      const p = path.join(runDir, stage, file)
      mkdirSync(path.dirname(p), { recursive: true })
      return p
    },
    log: pino({ level: 'silent' }),
  }
}

async function lavfiClip(outPath: string, durationSec: number): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${durationSec}:size=1080x1920:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    outPath, '-y',
  ])
}

describe('assembleStage premium (mocked renderer)', () => {
  afterEach(() => {
    vi.doUnmock('@remotion/bundler')
    vi.doUnmock('@remotion/renderer')
    vi.resetModules()
  })

  it('derives sceneClips props from scenes.json and passes them to renderMedia', async () => {
    const bundleDir = tmp('brainrot-fake-bundle-')
    const captured: { select?: ShortVideoProps; render?: ShortVideoProps } = {}
    vi.doMock('@remotion/bundler', () => ({
      bundle: async () => bundleDir,
    }))
    vi.doMock('@remotion/renderer', () => ({
      selectComposition: async (opts: { inputProps: ShortVideoProps }) => {
        captured.select = opts.inputProps
        return { id: 'ShortVideo', width: 1080, height: 1920, fps: 30, durationInFrames: 105 }
      },
      renderMedia: async (opts: { inputProps: ShortVideoProps; outputLocation: string }) => {
        captured.render = opts.inputProps
        writeFileSync(opts.outputLocation, 'stub-video')
      },
    }))
    vi.resetModules()
    const { assembleStage: mockedStage } = await import('./assemble.js')

    const channel = testChannel({ bgmDir: tmp('brainrot-bgm-') }) // empty bgm dir -> no bgm
    const ctx = makePremiumCtx(tmp('brainrot-run-'), channel)

    // Clips must be REAL video files: the premium branch ffprobes each one.
    await lavfiClip(ctx.artifactPath('visuals', 'scene-01.mp4'), 2)
    await lavfiClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1)
    // narration.wav is only copied (never decoded) on the mocked path.
    writeFileSync(ctx.artifactPath('voice', 'narration.wav'), 'junk-wav-bytes')
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs: 3500 }),
    )
    writeFileSync(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify({ words: [{ word: 'hello', startMs: 0, endMs: 400 }] }),
    )
    const manifest: ScenesManifest = {
      method: 'aligned',
      scenes: [
        // Scene 1: 1500ms window vs ~2000ms clip -> trim at 1x.
        // Scene 2: 2000ms window vs ~1000ms clip -> raw rate ~0.5 clamps to
        // exactly 0.75 regardless of ffprobe's container rounding (+-25ms).
        { index: 1, startMs: 0, endMs: 1500, keyframe: 'scene-01.png', clip: 'scene-01.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
        { index: 2, startMs: 1500, endMs: 3500, keyframe: 'scene-02.png', clip: 'scene-02.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
      ],
    }
    writeFileSync(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest))

    await mockedStage.run(ctx)

    expect(captured.render).toBeDefined()
    expect(captured.render).toEqual(captured.select) // same props to select + render
    expect(captured.render?.backgroundSrc).toBeUndefined()
    expect(captured.render?.audioSrc).toBe('job-assemble-premium/narration.wav')
    expect(captured.render?.bgmSrc).toBeUndefined()
    expect(captured.render?.durationMs).toBe(3500)
    expect(captured.render?.sceneClips).toEqual([
      { src: 'job-assemble-premium/scene-01.mp4', durationMs: 1500, playbackRate: 1 },
      { src: 'job-assemble-premium/scene-02.mp4', durationMs: 2000, playbackRate: 0.75 },
    ])
    // final.mp4 landed and the per-job public assets were cleaned up after.
    expect(existsSync(ctx.artifactPath('assemble', 'final.mp4'))).toBe(true)
    expect(existsSync(path.join(bundleDir, 'public', ctx.jobId))).toBe(false)
  }, 60000)
})

describe('assembleStage premium (real render)', () => {
  it('renders sequenced scene clips into a final.mp4 matching narration duration', async () => {
    const channel = testChannel({ bgmDir: tmp('brainrot-bgm-') }) // empty bgm dir -> no bgm
    const ctx = makePremiumCtx(tmp('brainrot-run-'), channel)

    await lavfiClip(ctx.artifactPath('visuals', 'scene-01.mp4'), 2)
    await lavfiClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1)
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4',
      ctx.artifactPath('voice', 'narration.wav'), '-y',
    ])
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'elevenlabs', voiceId: 'test-voice', durationMs: 2400 }),
    )
    writeFileSync(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify({
        words: [
          { word: 'scene', startMs: 0, endMs: 500 },
          { word: 'one', startMs: 500, endMs: 1100 },
          { word: 'two', startMs: 1300, endMs: 2200 },
        ],
      }),
    )
    const manifest: ScenesManifest = {
      method: 'aligned',
      scenes: [
        // Scene 2's 1200ms window against a ~1000ms clip exercises the real
        // slow-down path (rate ~0.83) inside an actual Remotion render.
        { index: 1, startMs: 0, endMs: 1200, keyframe: 'scene-01.png', clip: 'scene-01.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
        { index: 2, startMs: 1200, endMs: 2400, keyframe: 'scene-02.png', clip: 'scene-02.mp4', clipDurationSec: 5, imageAttempts: 1, videoAttempts: 1, costUsdMicros: 100_000 },
      ],
    }
    writeFileSync(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest))

    await assembleStage.run(ctx)

    const out = ctx.artifactPath('assemble', 'final.mp4')
    expect(existsSync(out)).toBe(true)
    const p = await probe(out)
    expect(p.width).toBe(1080)
    expect(p.height).toBe(1920)
    expect(p.fps).toBeGreaterThanOrEqual(29)
    expect(p.fps).toBeLessThanOrEqual(31)
    expect(p.hasAudio).toBe(true)
    // Composition length derives from voice.durationMs (2400ms), +-200ms slack.
    expect(p.durationMs).toBeGreaterThanOrEqual(2200)
    expect(p.durationMs).toBeLessThanOrEqual(2600)
    const c = await codecs(out)
    expect(c.video).toBe('h264')
    expect(c.audio).toBe('aac')
  }, 240000)
})
```

- [ ] **Step 7: Run them — expect FAIL.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t "assembleStage premium"
```

Expected: `2 failed` (everything else filtered out). Both fail identically — the premium branch does not exist yet, so the volume branch runs and tries to copy a background that premium jobs never produced:

```
Error: ENOENT: no such file or directory, copyfile '…/visuals/background.mp4' -> '…/public/job-assemble-premium/background.mp4'
```

(The real-render test spends ~60-90s creating an actual webpack bundle before hitting the ENOENT; that is expected.)

- [ ] **Step 8: Implement the shared prop types.** Replace `src/remotion-types.ts` entirely with:

```ts
import type { CaptionStyle } from './config/channel.js'
import type { WordTiming } from './providers/whisperx.js'

// One premium scene clip on the assembled timeline. src is a public-relative
// path (resolved via staticFile in the composition), durationMs the scene
// window length on the timeline, playbackRate the fitClipToWindow result
// (1 = play-and-trim, < 1 = slowed to cover a window longer than the clip).
export type SceneClip = { src: string; durationMs: number; playbackRate: number }

export type ShortVideoProps = {
  audioSrc: string
  backgroundSrc?: string // volume: single looped background (exactly one of these two is set)
  sceneClips?: SceneClip[] // premium: sequenced clips
  bgmSrc?: string
  bgmVolume?: number // default 0.12
  words: WordTiming[]
  style: CaptionStyle
  durationMs: number
}
```

- [ ] **Step 9: Implement the two-variant composition.** Replace `remotion/ShortVideo.tsx` entirely with:

```tsx
import React from 'react'
import { AbsoluteFill, Audio, OffthreadVideo, Series, staticFile } from 'remotion'
import type { ShortVideoProps } from '../src/remotion-types'
import { Captions } from './Captions'

// Single source of truth is src/remotion-types.ts; re-exported here so Root.tsx and
// the composition test can keep importing ShortVideoProps from './ShortVideo'.
export type { ShortVideoProps }

const FPS = 30

// audioSrc/backgroundSrc/bgmSrc/sceneClips[].src are public-relative paths (files
// copied into the bundle's public/ folder by the assemble stage) resolved here via
// staticFile().
//
// Exactly one visual variant must be provided: backgroundSrc (volume tier: one
// looped background) or sceneClips (premium tier: Series-sequenced clips, each
// durationInFrames = round(durationMs / 1000 * 30), muted — narration owns the
// audio track). The guard is truthiness-based (non-empty string / non-empty
// array) because Remotion shallow-merges defaultProps into inputProps: Root.tsx's
// defaultProps carry backgroundSrc '', which must not count as "set" when a
// premium render passes only sceneClips.
export const ShortVideo: React.FC<ShortVideoProps> = ({
  audioSrc,
  backgroundSrc,
  sceneClips,
  bgmSrc,
  bgmVolume,
  words,
  style,
}) => {
  const background = backgroundSrc || undefined
  const scenes = sceneClips && sceneClips.length > 0 ? sceneClips : undefined
  if ((background === undefined) === (scenes === undefined)) {
    throw new Error('ShortVideo: exactly one of backgroundSrc or sceneClips must be set')
  }
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {scenes ? (
        <Series>
          {scenes.map((clip) => (
            <Series.Sequence
              key={clip.src}
              durationInFrames={Math.round((clip.durationMs / 1000) * FPS)}
            >
              <OffthreadVideo
                src={staticFile(clip.src)}
                playbackRate={clip.playbackRate}
                muted
              />
            </Series.Sequence>
          ))}
        </Series>
      ) : background ? (
        <OffthreadVideo src={staticFile(background)} muted />
      ) : null}
      <Audio src={staticFile(audioSrc)} />
      {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={bgmVolume ?? 0.12} /> : null}
      <Captions words={words} style={style} />
    </AbsoluteFill>
  )
}
```

(`remotion/Root.tsx` is deliberately untouched: its `defaultProps` with `backgroundSrc: ''` remain type-valid now that the field is optional, and `calculateMetadata` already derives `durationInFrames` from `props.durationMs` for both variants.)

- [ ] **Step 10: Implement the assemble tier branch.** Replace `src/stages/assemble.ts` entirely with the file below. The imports-through-`getBundle()` section is Task 2's committed code verbatim (module-relative entry, self-healing memo) — if your working tree's version differs cosmetically there, keep the committed lines and apply only the additions (the `probe`/type imports, `fitClipToWindow` from Step 3, and the premium branch inside `run`):

```ts
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import { probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { WordTiming } from '../providers/whisperx.js'
import type { SceneClip, ShortVideoProps } from '../remotion-types.js'
import type { ScenesManifest } from './visuals-premium.js'

// Resolved relative to THIS module, not process.cwd(): the CLI may be invoked
// from any directory (pnpm -C, cron, a wrapper script), and a cwd-relative
// path.resolve('remotion/index.ts') would point bundling at a nonexistent tree.
const REMOTION_ENTRY = fileURLToPath(new URL('../../remotion/index.ts', import.meta.url))

let bundlePromise: Promise<string> | undefined
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    const inFlight = bundle({ entryPoint: REMOTION_ENTRY })
    // A rejected bundle() must not poison the memo for the process lifetime:
    // clear it so the next caller retries. Callers still observe the original
    // rejection through the returned promise — this .catch only manages the
    // memo (and marks the rejection handled on this side branch). The identity
    // guard keeps a newer in-flight bundle from being wiped by an older failure.
    inFlight.catch(() => {
      if (bundlePromise === inFlight) bundlePromise = undefined
    })
    bundlePromise = inFlight
  }
  return bundlePromise
}

/**
 * Fit a probed clip into its scene window (both integer ms).
 * - Window shorter than (or equal to) the clip: play at 1x and trim — the
 *   Series.Sequence simply ends at windowMs.
 * - Window longer than the clip: slow playback to cover it, but never below
 *   0.75x. A clip exhausted at 0.75x freezes on its last frame for the
 *   remainder of the window; QC's freeze check bounds how bad that can get.
 *   Windows needing < 0.75x violate script-stage pacing constraints and are
 *   caught by QC's duration/coverage checks, not silently stretched further.
 */
export function fitClipToWindow(
  clipMs: number,
  windowMs: number,
): { playbackRate: number; durationMs: number } {
  if (windowMs <= clipMs) return { playbackRate: 1, durationMs: windowMs }
  return { playbackRate: Math.max(0.75, clipMs / windowMs), durationMs: windowMs }
}

export const assembleStage: StageDef = {
  name: 'assemble',
  async run(ctx: JobContext): Promise<void> {
    const voice = JSON.parse(
      readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as { durationMs: number }
    const captions = JSON.parse(
      readFileSync(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    ) as { words: WordTiming[] }

    // Optional BGM: first *.mp3 in channel.bgmDir (deterministic: sorted).
    let bgmFile: string | undefined
    try {
      bgmFile = readdirSync(ctx.channel.bgmDir)
        .filter((f) => f.toLowerCase().endsWith('.mp3'))
        .sort()[0]
    } catch {
      bgmFile = undefined
    }

    const serveUrl = await getBundle()

    // Remotion SSR dynamic-asset mechanism (verified against remotion.dev):
    // absolute paths are NOT allowed in <OffthreadVideo>/<Audio>. Copy the
    // per-job files into the bundle's public/ folder, then reference them with
    // staticFile(). Namespace by jobId so a reused bundle never collides.
    const publicJobDir = path.join(serveUrl, 'public', ctx.jobId)
    mkdirSync(publicJobDir, { recursive: true })
    const outPath = ctx.artifactPath('assemble', 'final.mp4')
    try {
      copyFileSync(
        ctx.artifactPath('voice', 'narration.wav'),
        path.join(publicJobDir, 'narration.wav'),
      )
      if (bgmFile) {
        copyFileSync(path.join(ctx.channel.bgmDir, bgmFile), path.join(publicJobDir, 'bgm.mp3'))
      }

      const base = {
        audioSrc: `${ctx.jobId}/narration.wav`,
        bgmSrc: bgmFile ? `${ctx.jobId}/bgm.mp3` : undefined,
        words: captions.words,
        style: ctx.channel.captionStyle,
        durationMs: voice.durationMs,
      }

      let props: ShortVideoProps
      if (ctx.tier === 'premium') {
        // Premium: sequence the per-scene clips from the visuals manifest.
        // Each clip is probed for its REAL duration (fal can deliver 5.04s for
        // a "5s" clip; never trust clipDurationSec for timeline math) and
        // fitted to its scene window via fitClipToWindow.
        const manifest = JSON.parse(
          readFileSync(ctx.artifactPath('visuals', 'scenes.json'), 'utf8'),
        ) as ScenesManifest
        const sceneClips: SceneClip[] = []
        for (const entry of manifest.scenes) {
          const clipPath = ctx.artifactPath('visuals', entry.clip)
          const probed = await probe(clipPath)
          const fit = fitClipToWindow(probed.durationMs, entry.endMs - entry.startMs)
          copyFileSync(clipPath, path.join(publicJobDir, entry.clip))
          sceneClips.push({
            src: `${ctx.jobId}/${entry.clip}`,
            durationMs: fit.durationMs,
            playbackRate: fit.playbackRate,
          })
        }
        props = { ...base, sceneClips }
      } else {
        copyFileSync(
          ctx.artifactPath('visuals', 'background.mp4'),
          path.join(publicJobDir, 'background.mp4'),
        )
        props = { ...base, backgroundSrc: `${ctx.jobId}/background.mp4` }
      }

      const composition = await selectComposition({
        serveUrl,
        id: 'ShortVideo',
        inputProps: props,
      })
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outPath,
        inputProps: props,
      })
    } finally {
      // The bundle is memoized for the whole process, so per-job assets would
      // otherwise accumulate under public/ for the process lifetime. Distinct
      // jobId subdirs keep concurrent jobs isolated; removing only ours is safe.
      rmSync(publicJobDir, { recursive: true, force: true })
    }
    ctx.log.info({ outPath }, 'assemble: rendered final.mp4')
  },
}
```

- [ ] **Step 11: Run the premium tests — expect PASS.**

```bash
pnpm vitest run src/stages/assemble.test.ts -t "assembleStage premium"
```

Expected: `2 passed`. The mocked test is quick; the real-render test takes ~2-4 min (fresh bundle + 72-frame render).

- [ ] **Step 12: Extend the composition test to cover both prop variants.** Replace `remotion/remotion.test.ts` entirely with the file below, then run it. No red phase exists for this step: `selectComposition` evaluates `calculateMetadata` without rendering the component tree, so the premium variant resolves metadata even before Step 9 — this test locks the composition contract (both variants type-check against `ShortVideoProps` and derive duration from `durationMs`, never from the clip list) as regression coverage.

```ts
import { describe, expect, it } from 'vitest'
import { bundle } from '@remotion/bundler'
import { selectComposition } from '@remotion/renderer'
import path from 'node:path'
import type { ShortVideoProps } from './ShortVideo'

const style = {
  font: 'Inter',
  fontSizePx: 72,
  activeColor: '#FFD700',
  inactiveColor: '#FFFFFF',
  strokePx: 8,
}

describe('ShortVideo composition', () => {
  it('bundles once and resolves 1080x1920@30 metadata for both prop variants', async () => {
    const serveUrl = await bundle({ entryPoint: path.resolve('remotion/index.ts') })

    // Volume variant: single looped background.
    const volumeProps: ShortVideoProps = {
      audioSrc: 'sample/narration.wav',
      backgroundSrc: 'sample/background.mp4',
      words: [{ word: 'hello', startMs: 0, endMs: 500 }],
      style,
      durationMs: 4000,
    }
    const volumeComp = await selectComposition({
      serveUrl,
      id: 'ShortVideo',
      inputProps: volumeProps,
    })
    expect(volumeComp.width).toBe(1080)
    expect(volumeComp.height).toBe(1920)
    expect(volumeComp.fps).toBe(30)
    expect(volumeComp.durationInFrames).toBe(Math.ceil((4000 / 1000) * 30)) // 120

    // Premium variant: sequenced scene clips; composition duration still
    // derives from durationMs (the narration length), never the clip list.
    const premiumProps: ShortVideoProps = {
      audioSrc: 'sample/narration.wav',
      sceneClips: [
        { src: 'sample/scene-01.mp4', durationMs: 2500, playbackRate: 1 },
        { src: 'sample/scene-02.mp4', durationMs: 2500, playbackRate: 0.8 },
      ],
      words: [{ word: 'hello', startMs: 0, endMs: 500 }],
      style,
      durationMs: 5000,
    }
    const premiumComp = await selectComposition({
      serveUrl,
      id: 'ShortVideo',
      inputProps: premiumProps,
    })
    expect(premiumComp.width).toBe(1080)
    expect(premiumComp.height).toBe(1920)
    expect(premiumComp.fps).toBe(30)
    expect(premiumComp.durationInFrames).toBe(Math.ceil((5000 / 1000) * 30)) // 150
  }, 180000)
})
```

```bash
pnpm vitest run remotion/remotion.test.ts
```

Expected: `1 passed` (~2-3 min, dominated by the single bundle).

- [ ] **Step 13: Full gates.**

```bash
pnpm test
pnpm build
```

Expected: every suite green — including the untouched volume real-render test and Task 2's bundle-robustness block (the premium branch changed nothing they assert). `pnpm build` = `tsc --noEmit && tsc -p remotion --noEmit`, both clean (this is where the new `sceneClips` field and optional `backgroundSrc` are actually type-checked across `src/` and `remotion/`, including `Root.tsx`'s untouched `defaultProps`).

- [ ] **Step 14: Commit.**

```bash
git add src/remotion-types.ts remotion/ShortVideo.tsx remotion/remotion.test.ts src/stages/assemble.ts src/stages/assemble.test.ts
git commit -m "feat: premium multi-clip assembly with Series-sequenced scene clips"
```

---

### Task 15: Premium QC additions

**Files:**
- Create: (none)
- Modify: `src/stages/qc.ts`
- Test: `src/stages/qc.test.ts` (rewritten in full — the six Plan 1 tests are carried over unchanged in behavior; the local channel fixture moves onto `testChannel()`)

**Interfaces:**

Consumes:

```ts
// src/jobs/types.ts (existing, unchanged)
export type Tier = 'volume' | 'premium'
export interface JobContext {
  jobId: string; db: Database; channel: ChannelConfig; tier: Tier; topic: string; runDir: string
  artifactPath(stage: StageName, file: string): string; log: Logger
}
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }

// src/media/ffmpeg.ts (existing, unchanged)
export async function probe(file: string): Promise<{ durationMs: number; width: number; height: number; hasAudio: boolean; fps: number }>
// throws (execa non-zero / "no video stream") on a missing or undecodable file

// src/jobs/costs.ts (Task 6 signature; recordCost unchanged from Plan 1)
export function assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number, tier: Tier): void
// tier 'premium' -> the per-video cap is channel.budget.premiumPerVideoUsdMicros; throws BudgetExceededError
// whose message names the tripped cap (premium per-video cap message contains "premium")
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void

// src/providers/anthropic.ts (Task 7)
export async function visionJudgment<T>(opts: {
  model: string; system: string; prompt: string; imagePaths: string[];
  schema: z.ZodType<T>; maxTokens?: number; client?: Anthropic
}): Promise<{ data: T; cost: LlmUsageCost }>
// Binding semantics: one base64 image block per imagePaths entry (media_type by extension,
// .png -> image/png), in order, all BEFORE the trailing text block carrying `prompt`;
// PRICE_TABLE lookup before the call; forced 'emit' tool; cost from response.usage.

// src/stages/script.ts (Task 10)
export type ScenesOutput = z.infer<typeof ScenesOutputSchema> & { format: 'scenes' }
// { format: 'scenes', hook, styleBlock, scenes: { narration, visualPrompt, motionPrompt }[], platformMeta }
export type ScriptArtifact = ScriptOutput | ScenesOutput
export function isScenesOutput(s: ScriptArtifact): s is ScenesOutput

// src/stages/narration-text.ts (signatures widened by Task 10 to ScriptArtifact)
export function narrationWordCount(script: ScriptArtifact): number
export function minPlausibleNarrationMs(words: number): number

// src/stages/visuals-premium.ts (Task 13; type-only import here)
export interface SceneManifestEntry {
  index: number; startMs: number; endMs: number
  keyframe: string; clip: string           // file names relative to the visuals artifact dir
  clipDurationSec: 5 | 10
  imageAttempts: number; videoAttempts: number; costUsdMicros: number
}
export interface ScenesManifest { method: 'aligned' | 'proportional'; scenes: SceneManifestEntry[] }

// src/stages/_testkit.ts (Task 5)
export function testChannel(overrides?: Partial<ChannelConfig>): ChannelConfig
// carries the premium defaults: channel.premium present, budget.premiumPerVideoUsdMicros 7_000_000
export function testScript(opts?: { hook?: string; segments?: string[] }): ScriptOutput
```

Produces (consumed by Task 16's premium golden-path test and CLI wiring):

```ts
// src/stages/qc.ts
export function qcStage(opts?: { minMs?: number; maxMs?: number; client?: Anthropic }): StageDef  // name: 'qc'
export interface QcResult { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] }  // shape unchanged
```

Behavioral contract:
1. `ctx.tier === 'volume'` → byte-identical behavior to Plan 1: exactly these checks, in order: `duration-bounds`, `resolution`, `has-audio`, `audio-level`, `fps`, `captions-present`, `narration-complete`, `black-frames`, `frozen-frames`, `file-size`. (The design spec's "existing 9 checks" undercounts — `narration-complete` was added by late Plan 1 hardening; there are ten. The regression test pins the real list.)
2. `ctx.tier === 'premium'` → the same ten checks, then `scene-coverage`, then `vision-spot-check`, appended in that order. `QcResult.passed` is still `checks.every(passed)`.
3. `vision-spot-check` is a paid call: `assertBudget(..., 15_000, 'premium')` before, `recordCost(db, jobId, 'anthropic', 'qc-vision', cost.usdMicros)` after. ANY thrown error inside either premium check (provider 5xx, `BudgetExceededError`, ffmpeg failure, unreadable script) degrades to `{ passed: false, detail: <message> }` — the qc stage itself never throws for these, so the job lands `needs-review`, not `failed`.
4. Task 16's premium golden path passes `qcStage({ client: <fake pass client> })` — the injected client must reach `visionJudgment` unchanged.

**Context for the engineer:** `src/stages/qc.ts` currently builds a flat `checks` array inside `run()` and writes `qc/qc.json`; every helper is module-private. This task appends two premium-only checks behind a `ctx.tier === 'premium'` guard. One incidental typing fix rides along: the `narration-complete` block reads `script.json` as `ScriptOutput`, but a premium job's script is a `ScenesOutput` — the read becomes `readJson<ScriptArtifact>` (zero runtime change; `narrationWordCount` already accepts the union since Task 10) and the same value is reused for the vision prompt. Note: this task rewrites `src/stages/qc.test.ts` wholesale — if Task 5 patched the old inline `ChannelConfig` literal in that file to keep the build green, that literal disappears here in favor of `testChannel()`.

- [ ] **Step 1: Rewrite the test file — Plan 1 tests carried over + volume regression pin + scene-coverage tests (failing).** Replace `src/stages/qc.test.ts` in full with:

```ts
import { afterAll, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pino from 'pino'
import type Anthropic from '@anthropic-ai/sdk'
import { openDb } from '../db/index.js'
import { qcStage } from './qc.js'
import { testChannel, testScript } from './_testkit.js'
import type { ChannelConfig } from '../config/channel.js'
import type { JobContext, Tier } from '../jobs/types.js'
import type { QcResult } from './qc.js'

const cleanup: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(d)
  return d
}

// Local ctx builder (not _testkit's makeCtx): qc tests control the tier, the
// runDir, and budget overrides, and seed artifacts directly instead of running
// earlier stages. The channel comes from testChannel() so new required
// ChannelConfig fields stay centralized in the testkit.
function makeCtx(
  runDir: string,
  tier: Tier = 'volume',
  channelOverrides: Partial<ChannelConfig> = {},
): JobContext {
  return {
    jobId: 'job-qc',
    db: openDb(':memory:'),
    channel: testChannel(channelOverrides),
    tier,
    topic: 'test topic',
    runDir,
    artifactPath(stage, file) {
      const p = path.join(runDir, stage, file)
      mkdirSync(path.dirname(p), { recursive: true })
      return p
    },
    log: pino({ level: 'silent' }),
  }
}

function seedVoice(ctx: JobContext, durationMs = 1000): void {
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs }),
  )
}
function seedWords(ctx: JobContext): void {
  writeFileSync(
    ctx.artifactPath('captions', 'words.json'),
    JSON.stringify({
      words: [
        { word: 'a', startMs: 0, endMs: 300 },
        { word: 'b', startMs: 300, endMs: 650 },
        { word: 'c', startMs: 650, endMs: 1000 },
      ],
    }),
  )
}
const SENTENCE =
  'Venus spins backwards compared to every other planet orbiting our star and nobody really knows why.'
// `sentences` counts the hook plus the segments, matching how narrationText joins them.
function seedScript(ctx: JobContext, sentences: number, text = SENTENCE): void {
  writeFileSync(
    ctx.artifactPath('script', 'script.json'),
    JSON.stringify(testScript({ hook: text, segments: Array.from({ length: sentences - 1 }, () => text) })),
  )
}

async function goodClip(file: string, seconds = 2): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=1080x1920:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file, '-y',
  ])
}
async function blackClip(file: string): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=black:size=1080x1920:duration=2:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    file, '-y',
  ])
}
async function silentFrozenClip(file: string): Promise<void> {
  // Static black video (frozen) + digital silence (anullsrc): trips both
  // frozen-frames (>= 2s freeze) and audio-level (mean_volume well below -50 dB).
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=black:size=1080x1920:duration=3:rate=30',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file, '-y',
  ])
}

// Premium fixtures -----------------------------------------------------------

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
}

// 12 narration words total (hook 3 + 5 + 4) -> narration-complete floor 2400ms.
function seedScenesScript(ctx: JobContext): void {
  writeFileSync(
    ctx.artifactPath('script', 'script.json'),
    JSON.stringify({
      format: 'scenes',
      hook: 'Venus spins backwards',
      styleBlock: 'Muted retro-futurist palette, soft film grain, warm dusk lighting.',
      scenes: [
        {
          narration: 'Venus rotates the wrong way.',
          visualPrompt: 'Venus rotating against a dense starfield',
          motionPrompt: 'slow orbital drift',
        },
        {
          narration: 'Nobody knows exactly why.',
          visualPrompt: 'A glowing question mark nebula over a planet silhouette',
          motionPrompt: 'gentle zoom in',
        },
      ],
      platformMeta: PLATFORM_META,
    }),
  )
}

function seedManifest(ctx: JobContext, windows: [number, number][]): void {
  writeFileSync(
    ctx.artifactPath('visuals', 'scenes.json'),
    JSON.stringify({
      method: 'aligned',
      scenes: windows.map(([startMs, endMs], i) => ({
        index: i + 1,
        startMs,
        endMs,
        keyframe: `scene-${String(i + 1).padStart(2, '0')}.png`,
        clip: `scene-${String(i + 1).padStart(2, '0')}.mp4`,
        clipDurationSec: 5,
        imageAttempts: 1,
        videoAttempts: 1,
        costUsdMicros: 100_000,
      })),
    }),
  )
}

// Scene clip fixture: scene-coverage only probes duration ([3000,15000]ms), so a
// small, fast-encoding frame size keeps the fixture cheap. Video-only is fine —
// the check does not require clip audio (narration owns the audio track).
async function sceneClip(file: string, seconds = 5): Promise<void> {
  await execa('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=180x320:rate=30`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    file, '-y',
  ])
}

// A full premium artifact set that passes every check: 4s final.mp4, 3900ms
// voice (safely under the probed video duration so duration-bounds holds), two
// windows tiling [0, 3900] exactly, and two 5s clips on disk.
async function seedPremiumHappyPath(ctx: JobContext): Promise<void> {
  await goodClip(ctx.artifactPath('assemble', 'final.mp4'), 4)
  seedVoice(ctx, 3900)
  seedWords(ctx)
  seedScenesScript(ctx)
  seedManifest(ctx, [[0, 2000], [2000, 3900]])
  await sceneClip(ctx.artifactPath('visuals', 'scene-01.mp4'))
  await sceneClip(ctx.artifactPath('visuals', 'scene-02.mp4'))
}

// Same shape as anthropic.test.ts's fakeClient: visionJudgment is real, only the
// SDK client underneath it is faked.
function fakeVisionClient(emitInput: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: 'emit', id: 't1', input: emitInput }],
    usage: { input_tokens: 3000, output_tokens: 50 },
  })
  return { client: { messages: { create } } as unknown as Anthropic, create }
}

const VOLUME_CHECKS = [
  'duration-bounds',
  'resolution',
  'has-audio',
  'audio-level',
  'fps',
  'captions-present',
  'narration-complete',
  'black-frames',
  'frozen-frames',
  'file-size',
]

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true })
})

describe('qcStage', () => {
  it('passes a good clip (injectable minMs keeps the fixture short)', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(true)
    for (const c of result.checks) expect(c.passed).toBe(true)
  }, 120000)

  it('fails black-frames on an all-black clip', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await blackClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'black-frames')?.passed).toBe(false)
  }, 120000)

  it('fails captions-present when words.json is missing', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    // no words.json

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'captions-present')?.passed).toBe(false)
  }, 120000)

  it('fails narration-complete when the voice track is too short for the script', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx) // 1000ms
    seedWords(ctx)
    seedScript(ctx, 10) // 160 narration words -> needs >= 32000ms

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'narration-complete')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/160 words/)
    expect(check?.detail).toMatch(/1000/)
    expect(check?.detail).toMatch(/32000/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('passes narration-complete when the voice track is long enough', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx) // 1000ms
    seedWords(ctx)
    seedScript(ctx, 1, 'Venus spins backwards.') // 3 words -> needs >= 600ms

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.find((c) => c.name === 'narration-complete')?.passed).toBe(true)
    expect(result.passed).toBe(true)
  }, 120000)

  it('fails audio-level and frozen-frames on a silent, static clip', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await silentFrozenClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'audio-level')?.passed).toBe(false)
    expect(result.checks.find((c) => c.name === 'frozen-frames')?.passed).toBe(false)
  }, 120000)

  it('volume tier: runs exactly the Plan 1 checks, in order — no premium checks', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'))
    await goodClip(ctx.artifactPath('assemble', 'final.mp4'))
    seedVoice(ctx)
    seedWords(ctx)

    await qcStage({ minMs: 1000 }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual(VOLUME_CHECKS)
  }, 120000)
})

describe('qcStage premium: scene-coverage', () => {
  it('passes when windows tile [0, voice.durationMs] and all clips probe sane', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(true)
    expect(check?.detail).toMatch(/2 scenes/)
  }, 120000)

  it('fails and names the gap when windows do not tile', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    seedManifest(ctx, [[0, 2000], [2500, 3900]]) // 500ms hole between the scenes

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/ends at 2000ms/)
    expect(check?.detail).toMatch(/starts at 2500ms/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails when the manifest is missing', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    rmSync(ctx.artifactPath('visuals', 'scenes.json'))

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/scenes\.json/)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails and names the missing clip file', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    rmSync(ctx.artifactPath('visuals', 'scene-02.mp4'))

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/clip missing: scene-02\.mp4/)
  }, 120000)

  it('fails when a clip probes outside the sane duration bounds', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    await sceneClip(ctx.artifactPath('visuals', 'scene-02.mp4'), 1) // 1s clip, under the 3000ms floor

    const { client } = fakeVisionClient({ pass: true, issues: [] })
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'scene-coverage')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/scene-02\.mp4 probes \d+ms, outside/)
  }, 120000)
})
```

- [ ] **Step 2: Run the tests expecting failure.** Command: `pnpm vitest run src/stages/qc.test.ts`. Expected: `5 failed | 7 passed (12)`. The six carried-over Plan 1 tests and the volume regression pin pass against the unmodified stage; all five `scene-coverage` tests fail with `expected undefined to be true` / `expected undefined to be false` — `result.checks.find((c) => c.name === 'scene-coverage')` is `undefined` because the stage does not emit the check yet. (The extra `client` key in the `qcStage` options object is ignored at runtime; vitest does not type-check.)

- [ ] **Step 3: Implement scene-coverage (implementation slice 1).** Replace `src/stages/qc.ts` in full with the code below. Diff vs Plan 1: the fs import gains `existsSync`; new type-only imports (`Anthropic`, `ScriptArtifact` replacing `ScriptOutput`, `ScenesManifest`); new `QcCheck` alias and clip-bound constants; new `sceneCoverageCheck` helper; `qcStage` opts gain `client?: Anthropic` (used by slice 2); the `narration-complete` read becomes `readJson<ScriptArtifact>`; a `ctx.tier === 'premium'` block appends the check. Everything else is byte-identical.

```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execa } from 'execa'
import type Anthropic from '@anthropic-ai/sdk'
import { probe } from '../media/ffmpeg.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import type { ScriptArtifact } from './script.js'
import type { ScenesManifest } from './visuals-premium.js'
import { narrationWordCount, minPlausibleNarrationMs } from './narration-text.js'

export interface QcResult {
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
}

type QcCheck = QcResult['checks'][number]

const MB = 1024 * 1024
const MAX_SIZE_BYTES = 256 * MB

// Scene-coverage sanity bounds: fal clips are generated at native 5s or 10s, so
// anything under 3s or over 15s is a truncated or corrupt encode. The 50ms end
// tolerance absorbs word-timing rounding; window starts/joins are exact by the
// scene-windows contract (integer ms, exact tiling).
const MIN_CLIP_MS = 3000
const MAX_CLIP_MS = 15000
const COVERAGE_TOLERANCE_MS = 50

// Optional artifacts: a missing or unreadable one is a failed check, not a crash.
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function longestBlackRunSeconds(stderr: string): number {
  // blackdetect logs: [blackdetect @ 0x..] black_start:1.0 black_end:2.5 black_duration:1.5
  let max = 0
  const re = /black_duration:([0-9.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    const d = parseFloat(m[1])
    if (d > max) max = d
  }
  return max
}

function parseMeanVolumeDb(stderr: string): number {
  // volumedetect logs: [Parsed_volumedetect_0 @ 0x..] mean_volume: -21.4 dB
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr)
  return m ? parseFloat(m[1]) : NaN
}

function longestFreezeMs(stderr: string, videoDurationMs: number): number {
  // freezedetect logs lavfi.freezedetect.freeze_start / .freeze_duration / .freeze_end
  let max = 0
  const durRe = /freeze_duration[^0-9-]*([0-9.]+)/g
  let m: RegExpExecArray | null
  while ((m = durRe.exec(stderr)) !== null) {
    const ms = Math.round(parseFloat(m[1]) * 1000)
    if (ms > max) max = ms
  }
  if (max > 0) return max
  // A freeze that runs to EOF is reported by freeze_start only (no duration/end);
  // measure it to the end of the clip so an open-ended freeze is not ignored.
  const startRe = /freeze_start[^0-9-]*([0-9.]+)/g
  while ((m = startRe.exec(stderr)) !== null) {
    const ms = videoDurationMs - Math.round(parseFloat(m[1]) * 1000)
    if (ms > max) max = ms
  }
  return max
}

// Premium check (a): the scenes manifest must tile [0, voice.durationMs] with no
// gaps or overlaps, and every referenced clip must exist and probe sane. Free
// and deterministic; returns on the FIRST violation so the detail names it.
async function sceneCoverageCheck(ctx: JobContext, voiceDurationMs: number): Promise<QcCheck> {
  const name = 'scene-coverage'
  const manifest = readJson<ScenesManifest>(ctx.artifactPath('visuals', 'scenes.json'))
  if (!manifest || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    return { name, passed: false, detail: 'visuals/scenes.json missing, unreadable, or has no scenes' }
  }
  const scenes = manifest.scenes
  if (scenes[0].startMs !== 0) {
    return { name, passed: false, detail: `scene 1 starts at ${scenes[0].startMs}ms; expected 0` }
  }
  for (let i = 0; i < scenes.length - 1; i++) {
    if (scenes[i].endMs !== scenes[i + 1].startMs) {
      return {
        name,
        passed: false,
        detail: `gap/overlap: scene ${i + 1} ends at ${scenes[i].endMs}ms but scene ${i + 2} starts at ${scenes[i + 1].startMs}ms`,
      }
    }
  }
  const lastEnd = scenes[scenes.length - 1].endMs
  if (Math.abs(lastEnd - voiceDurationMs) > COVERAGE_TOLERANCE_MS) {
    return {
      name,
      passed: false,
      detail: `last scene ends at ${lastEnd}ms but voice runs ${voiceDurationMs}ms (tolerance ${COVERAGE_TOLERANCE_MS}ms)`,
    }
  }
  for (const scene of scenes) {
    const clipPath = ctx.artifactPath('visuals', scene.clip)
    if (!existsSync(clipPath)) {
      return { name, passed: false, detail: `clip missing: ${scene.clip}` }
    }
    let clipMs: number
    try {
      clipMs = (await probe(clipPath)).durationMs
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { name, passed: false, detail: `clip unreadable: ${scene.clip} (${message})` }
    }
    if (clipMs < MIN_CLIP_MS || clipMs > MAX_CLIP_MS) {
      return {
        name,
        passed: false,
        detail: `clip ${scene.clip} probes ${clipMs}ms, outside [${MIN_CLIP_MS}, ${MAX_CLIP_MS}]ms`,
      }
    }
  }
  return {
    name,
    passed: true,
    detail: `${scenes.length} scenes tile [0, ${voiceDurationMs}ms]; all clips present and probe within [${MIN_CLIP_MS}, ${MAX_CLIP_MS}]ms`,
  }
}

export function qcStage(opts?: { minMs?: number; maxMs?: number; client?: Anthropic }): StageDef {
  const minMs = opts?.minMs ?? 15000
  const maxMs = opts?.maxMs ?? 180000
  return {
    name: 'qc',
    async run(ctx: JobContext): Promise<void> {
      const finalPath = ctx.artifactPath('assemble', 'final.mp4')
      const voice = JSON.parse(
        readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
      ) as { durationMs: number }
      const p = await probe(finalPath)
      const checks: QcResult['checks'] = []

      checks.push({
        name: 'duration-bounds',
        passed: p.durationMs >= minMs && p.durationMs <= maxMs && p.durationMs >= voice.durationMs,
        detail: `duration ${p.durationMs}ms; bounds [${minMs},${maxMs}]; voice ${voice.durationMs}ms`,
      })
      checks.push({
        name: 'resolution',
        passed: p.width === 1080 && p.height === 1920,
        detail: `${p.width}x${p.height}`,
      })
      checks.push({
        name: 'has-audio',
        passed: p.hasAudio,
        detail: p.hasAudio ? 'audio stream present' : 'no audio stream',
      })

      const { stderr: volStderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-af', 'volumedetect', '-vn', '-f', 'null', '-'],
        { reject: false },
      )
      const meanDb = parseMeanVolumeDb(volStderr)
      checks.push({
        name: 'audio-level',
        passed: Number.isFinite(meanDb) && meanDb >= -50,
        detail: Number.isFinite(meanDb) ? `mean_volume ${meanDb} dB` : 'mean_volume unparsable',
      })

      checks.push({
        name: 'fps',
        passed: p.fps >= 29 && p.fps <= 31,
        detail: `fps ${p.fps}`,
      })

      const captions = readJson<{ words: unknown[] }>(ctx.artifactPath('captions', 'words.json'))
      const wordCount = Array.isArray(captions?.words) ? captions.words.length : 0
      checks.push({
        name: 'captions-present',
        passed: wordCount > 0,
        detail: `${wordCount} words`,
      })

      // A TTS backend that silently truncates still emits a valid WAV, so the gate
      // re-checks the voice track against the script it was meant to narrate. Same
      // rule as the voice-stage guard, applied here so an old or partially
      // regenerated artifact set cannot slip through. Read as the ScriptArtifact
      // union: a premium job's script.json is a ScenesOutput, and
      // narrationWordCount handles both formats.
      const script = readJson<ScriptArtifact>(ctx.artifactPath('script', 'script.json'))
      const narrationWords = script ? narrationWordCount(script) : 0
      const minNarrationMs = minPlausibleNarrationMs(narrationWords)
      checks.push({
        name: 'narration-complete',
        passed: voice.durationMs >= minNarrationMs,
        detail: `${narrationWords} words; voice ${voice.durationMs}ms; minimum ${minNarrationMs}ms`,
      })

      const { stderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-vf', 'blackdetect=d=1.0:pix_th=0.10', '-an', '-f', 'null', '-'],
        { reject: false },
      )
      const maxBlack = longestBlackRunSeconds(stderr)
      checks.push({
        name: 'black-frames',
        passed: maxBlack < 1.0,
        detail: `longest black run ${maxBlack.toFixed(2)}s`,
      })

      const { stderr: freezeStderr } = await execa(
        'ffmpeg',
        ['-i', finalPath, '-vf', 'freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'],
        { reject: false },
      )
      const maxFreezeMs = longestFreezeMs(freezeStderr, p.durationMs)
      checks.push({
        name: 'frozen-frames',
        passed: maxFreezeMs < 2000,
        detail: `longest freeze ${maxFreezeMs}ms`,
      })

      const bytes = statSync(finalPath).size
      checks.push({
        name: 'file-size',
        passed: bytes < MAX_SIZE_BYTES,
        detail: `${(bytes / MB).toFixed(2)} MB`,
      })

      if (ctx.tier === 'premium') {
        checks.push(await sceneCoverageCheck(ctx, voice.durationMs))
      }

      const result: QcResult = { passed: checks.every((c) => c.passed), checks }
      writeFileSync(ctx.artifactPath('qc', 'qc.json'), JSON.stringify(result, null, 2))
      ctx.log.info({ passed: result.passed }, 'qc: complete')
    },
  }
}
```

- [ ] **Step 4: Run the tests expecting pass.** Command: `pnpm vitest run src/stages/qc.test.ts`. Expected: `12 passed (12)`.

- [ ] **Step 5: Add the vision-spot-check tests (failing).** Append the following describe block at the end of `src/stages/qc.test.ts` (after the closing `})` of `describe('qcStage premium: scene-coverage', ...)`; no import changes — everything it uses is already in scope):

```ts
describe('qcStage premium: vision-spot-check', () => {
  it('extracts three frames, calls visionJudgment with scene intents, records cost, passes', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client, create } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    expect(result.checks.map((c) => c.name)).toEqual([...VOLUME_CHECKS, 'scene-coverage', 'vision-spot-check'])
    expect(result.checks.find((c) => c.name === 'vision-spot-check')?.passed).toBe(true)
    expect(result.passed).toBe(true)

    // One vision call: three PNG frame blocks, then a text prompt listing every
    // scene's visualPrompt (visionJudgment's binding block layout).
    expect(create).toHaveBeenCalledTimes(1)
    const request = create.mock.calls[0][0]
    expect(request.model).toBe('claude-sonnet-5') // channel.scriptModel from testChannel()
    const content = request.messages[0].content as { type: string; text?: string }[]
    expect(content.filter((b) => b.type === 'image')).toHaveLength(3)
    const last = content[content.length - 1]
    expect(last.type).toBe('text')
    expect(last.text).toContain('Scene 1: Venus rotating against a dense starfield')
    expect(last.text).toContain('Scene 2: A glowing question mark nebula over a planet silhouette')

    // The paid call is ledgered: 3000 in x $3/MTok + 50 out x $15/MTok = 9750 usd-micros.
    const costs = ctx.db
      .prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?')
      .all(ctx.jobId) as { provider: string; operation: string; usd_micros: number }[]
    expect(costs).toEqual([{ provider: 'anthropic', operation: 'qc-vision', usd_micros: 9750 }])
  }, 120000)

  it('fails with the model issues in detail when the model rejects the frames', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const { client } = fakeVisionClient({
      pass: false,
      issues: ['scenes appear out of order', 'captions obscure the subject'],
    })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toBe('scenes appear out of order; captions obscure the subject')
    // The premium checks are independent: coverage still passed on the same run.
    expect(result.checks.find((c) => c.name === 'scene-coverage')?.passed).toBe(true)
    expect(result.passed).toBe(false)
  }, 120000)

  it('degrades a provider error to a failed check instead of crashing the stage', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium')
    await seedPremiumHappyPath(ctx)
    const create = vi.fn().mockRejectedValue(new Error('anthropic 529 overloaded'))
    const client = { messages: { create } } as unknown as Anthropic

    // Must resolve — a flaky provider parks the job needs-review, never failed.
    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toContain('anthropic 529 overloaded')
    expect(result.checks.find((c) => c.name === 'scene-coverage')?.passed).toBe(true)
    expect(result.passed).toBe(false)
  }, 120000)

  it('fails closed at zero spend when the premium per-video budget is exhausted', async () => {
    const ctx = makeCtx(tmp('brainrot-run-'), 'premium', {
      // Premium per-video cap (1000 micros) below the 15_000-micro vision estimate:
      // assertBudget(..., 'premium') must throw before the client is touched.
      budget: { perVideoUsdMicros: 8_000_000, premiumPerVideoUsdMicros: 1_000, perDayUsdMicros: 20_000_000 },
    })
    await seedPremiumHappyPath(ctx)
    const { client, create } = fakeVisionClient({ pass: true, issues: [] })

    await qcStage({ minMs: 1000, client }).run(ctx)

    const result = JSON.parse(readFileSync(ctx.artifactPath('qc', 'qc.json'), 'utf8')) as QcResult
    const check = result.checks.find((c) => c.name === 'vision-spot-check')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toMatch(/premium/) // Task 6: the message names the tripped cap
    expect(create).not.toHaveBeenCalled()
    // Nothing ledgered: the breach happened before the paid call.
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM costs').get()).toEqual({ n: 0 })
  }, 120000)
})
```

- [ ] **Step 6: Run the tests expecting failure.** Command: `pnpm vitest run src/stages/qc.test.ts`. Expected: `4 failed | 12 passed (16)`. All four new tests fail because the stage emits no `vision-spot-check` check: the first with an array mismatch (`expected [...VOLUME_CHECKS, 'scene-coverage'] to deeply equal [..., 'vision-spot-check']`), the other three with `expected undefined to be false` from the `find(...)` returning `undefined`.

- [ ] **Step 7: Implement vision-spot-check (implementation slice 2).** Three edits to `src/stages/qc.ts`:

  **(7a)** Replace the import block (the first eight lines of the file, through the `narration-text.js` import) with:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { probe } from '../media/ffmpeg.js'
import { assertBudget, recordCost } from '../jobs/costs.js'
import { visionJudgment } from '../providers/anthropic.js'
import type { JobContext, StageDef } from '../jobs/types.js'
import { isScenesOutput, type ScriptArtifact } from './script.js'
import type { ScenesManifest } from './visuals-premium.js'
import { narrationWordCount, minPlausibleNarrationMs } from './narration-text.js'
```

  **(7b)** Immediately after the `const COVERAGE_TOLERANCE_MS = 50` line, add:

```ts
// Pre-flight budget reservation for the qc vision call: three PNG frames plus a
// short prompt against claude-sonnet-5 lands well under $0.015 at list price.
const ESTIMATED_VISION_COST_MICROS = 15_000

const SpotCheckSchema = z.object({ pass: z.boolean(), issues: z.array(z.string()) })
```

  **(7c)** Immediately after the closing brace of `sceneCoverageCheck` (before `export function qcStage`), add:

```ts
// Premium check (b): sample three frames from the finished video and have the
// vision model judge them against the scene intents — catches assembly-level
// faults the per-keyframe check cannot (wrong ordering, corrupted encode,
// captions obscuring the subject). This is a paid call: budget gate before,
// ledger after. ANY thrown error (ffmpeg, budget breach, provider 5xx) degrades
// to a failed check so the job parks needs-review instead of crashing the stage.
async function visionSpotCheck(
  ctx: JobContext,
  script: ScriptArtifact | undefined,
  finalPath: string,
  finalDurationMs: number,
  client?: Anthropic,
): Promise<QcCheck> {
  const name = 'vision-spot-check'
  try {
    if (!script || !isScenesOutput(script)) {
      return { name, passed: false, detail: 'script.json missing, unreadable, or not scenes format' }
    }
    const frameDir = mkdtempSync(path.join(tmpdir(), 'brainrot-qc-frames-'))
    try {
      const framePaths: string[] = []
      for (const [i, fraction] of [0.1, 0.5, 0.9].entries()) {
        const seekSec = ((finalDurationMs * fraction) / 1000).toFixed(3)
        const framePath = path.join(frameDir, `frame-${i + 1}.png`)
        await execa('ffmpeg', ['-ss', seekSec, '-i', finalPath, '-frames:v', '1', '-y', framePath])
        framePaths.push(framePath)
      }
      const sceneList = script.scenes.map((s, i) => `Scene ${i + 1}: ${s.visualPrompt}`).join('\n')
      // Same discipline as every paid call: budget gate before, ledger after.
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_VISION_COST_MICROS, 'premium')
      const { data, cost } = await visionJudgment({
        model: ctx.channel.scriptModel,
        system:
          'You are a strict quality-control reviewer for AI-generated short-form vertical video. ' +
          'Judge only what is visible in the provided frames. ' +
          'Return your answer ONLY by calling the `emit` tool.',
        prompt: [
          'Three frames sampled at 10%, 50%, and 90% of the finished video, in order.',
          'The video was assembled from AI-generated scene clips with burned-in word captions; captions over the visuals are expected and fine.',
          '',
          'Scene intents, in narration order:',
          sceneList,
          '',
          'Set pass=false only for assembly-level faults: frames that match no scene intent at all, scenes clearly out of order, a corrupted or garbled encode, or captions fully obscuring the subject.',
          'Minor stylistic drift from the intents is acceptable. List each concrete issue in `issues`; return an empty issues array when passing.',
        ].join('\n'),
        imagePaths: framePaths,
        schema: SpotCheckSchema,
        client,
      })
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'qc-vision', cost.usdMicros)
      return {
        name,
        passed: data.pass,
        detail: data.pass
          ? 'sampled frames consistent with scene intents'
          : data.issues.join('; ') || 'model failed the frames without naming issues',
      }
    } finally {
      rmSync(frameDir, { recursive: true, force: true })
    }
  } catch (err) {
    return { name, passed: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
```

  **(7d)** Replace the premium block inside `run()`:

```ts
      if (ctx.tier === 'premium') {
        checks.push(await sceneCoverageCheck(ctx, voice.durationMs))
      }
```

  with:

```ts
      if (ctx.tier === 'premium') {
        checks.push(await sceneCoverageCheck(ctx, voice.durationMs))
        checks.push(await visionSpotCheck(ctx, script, finalPath, p.durationMs, opts?.client))
      }
```

- [ ] **Step 8: Run the tests expecting pass.** Command: `pnpm vitest run src/stages/qc.test.ts`. Expected: `16 passed (16)`.

- [ ] **Step 9: Full suite and build.** Commands: `pnpm test` then `pnpm build`. Expected: the entire suite green (no network — the vision calls only ever see the injected fake client; frame extraction and clip probing are local ffmpeg/ffprobe) and both `tsc --noEmit` and `tsc -p remotion --noEmit` clean. The volume golden-path and runner tests must be untouched by this task — if any of them fail, the volume path is no longer byte-identical and the premium guard leaked.

- [ ] **Step 10: Commit.** Command: `git add src/stages/qc.ts src/stages/qc.test.ts && git commit -m "feat: add premium qc checks (scene coverage + vision spot check)"`.

---

---

### Task 16: CLI premium enablement, env/docs, premium golden path

**Files:**
- Create: `src/jobs/golden-path-premium.test.ts`
- Modify: `src/cli.ts`, `.env.example`, `README.md`, `package.json`
- Test: `src/cli.test.ts` (modify), `src/jobs/golden-path-premium.test.ts` (create)

**Interfaces:**

Consumes (from earlier tasks / existing code — all must already exist when this task starts):

```ts
// src/stages/visuals-premium.ts (Task 13)
export const visualsPremiumStage: StageDef   // name: 'visuals'
// Artifact shape this task SEEDS as JSON (runs/<jobId>/visuals/scenes.json):
export interface SceneManifestEntry {
  index: number; startMs: number; endMs: number
  keyframe: string; clip: string             // file names relative to the visuals artifact dir
  clipDurationSec: 5 | 10
  imageAttempts: number; videoAttempts: number; costUsdMicros: number
}
export interface ScenesManifest { method: 'aligned' | 'proportional'; scenes: SceneManifestEntry[] }

// src/stages/qc.ts (Task 15)
export function qcStage(opts?: { minMs?: number; maxMs?: number; client?: Anthropic }): StageDef
export interface QcResult { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] }
// Premium adds checks named 'scene-coverage' and 'vision-spot-check'; the vision call
// is ledgered as recordCost(db, jobId, 'anthropic', 'qc-vision', ...).

// src/stages/script.ts (Task 10) — artifact shape this task SEEDS (format stamped by the stage):
// { format: 'scenes', hook, styleBlock,
//   scenes: [{ narration, visualPrompt, motionPrompt }], platformMeta }

// src/stages/voice.ts (Task 11) — artifact shape this task SEEDS:
export interface VoiceMeta { provider: 'kokoro' | 'edge-tts' | 'elevenlabs'; voiceId: string; durationMs: number }

// src/stages/visuals-volume.ts (existing)
export const visualsVolumeStage: StageDef

// src/jobs/runner.ts (existing; Task 1 final-gate semantics)
export function createJob(db: Database, channel: ChannelConfig, opts: { topic: string; tier: Tier }): string
export async function runJob(db: Database, channel: ChannelConfig, jobId: string, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>

// src/config/channel.ts (Task 5) — a Plan-1-era TOML (no [voice.premium], no [premium],
// no premium_per_video_usd) still parses; premium defaults are applied.
export function loadChannelConfig(path: string): ChannelConfig

// src/media/ffmpeg.ts (existing)
export async function probe(file: string): Promise<MediaProbe>
```

Produces (Task 16 is the final task; these exist for tests and operators, no later consumer):

```ts
// src/cli.ts
export function parseTier(raw: string): Tier          // throws listing BOTH valid tiers on anything else
export function stagesForTier(tier: Tier): StageDef[] // six stages; only the visuals slot branches by tier
```

Plus: `package.json` gains the script `"test:contract:premium": "CONTRACT=1 CONTRACT_PREMIUM=1 vitest run"`;
`.env.example` gains `FAL_KEY`, `ELEVENLABS_API_KEY`, `BRAINROT_GLOBAL_DAILY_USD=25`; `README.md` gains
the premium section.

**Context for the engineer:** `src/cli.ts` currently hard-rejects every tier except `'volume'` (a
deliberate Plan-1 gate with a "premium arrives in Plan 2" message) and hard-codes `visualsVolumeStage`
in its stage list. This task flips that gate: `--tier premium` becomes valid and swaps in
`visualsPremiumStage`. Everything else about the CLI (option names, exit codes, JSON result line,
`jobs`/`costs` subcommands) stays byte-identical in behavior. One structural change makes the wiring
testable: `cli.ts` gains a main-module guard (`argv[1]` vs `import.meta.url`) so the test file can
import `parseTier`/`stagesForTier` in-process without firing the argv parser — executing the file via
`tsx src/cli.ts` behaves exactly as before, which the existing subprocess tests prove. The second
deliverable is the premium golden-path integration test: seeded scenes-format artifacts + fixture
clips → real multi-clip Remotion render → premium QC with an injected always-pass vision client → a
`ready` library row. No network anywhere.

- [ ] **Step 1: Rewrite the two tier subprocess tests in `src/cli.test.ts` to the premium-enabled expectations**

  In `src/cli.test.ts`, replace the entire test
  `` it('`produce --tier premium` exits 1 with a Plan-2 message and creates no job', ...) `` (including
  its closing `}, 60000)`) with:

  ```ts
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
  ```

  and replace the entire test `` it('`produce --tier garbage` exits 1 and creates no job', ...) ``
  (including its closing `}, 60000)`) with:

  ```ts
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
  ```

  No import changes in this step. The other three tests (`jobs` table, `produce --help`, nonexistent
  channel with `--tier volume`) stay untouched.

- [ ] **Step 2: Run the CLI tests — expect exactly the two rewritten tests to FAIL**

  ```sh
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `2 failed | 3 passed`. The failures, in order:
  - premium test: `AssertionError: expected 'unsupported --tier "premium": only "…' to match /ENOENT|no such file/` —
    the current CLI still rejects the tier itself, so stderr never reaches the channel-load error.
  - garbage test: `AssertionError: expected 'unsupported --tier "garbage": only "v…' to contain 'valid tiers are "volume", "premium"'` —
    the current message says `only "volume" is available; the premium tier arrives in Plan 2`.

  (If either rewritten test PASSES here, stop — `src/cli.ts` has already been changed; re-read it.)

- [ ] **Step 3: Rewrite `src/cli.ts` — tier validation, premium stage wiring, main-module guard**

  Replace the entire contents of `src/cli.ts` with:

  ```ts
  import 'dotenv/config'
  import path from 'node:path'
  import { fileURLToPath } from 'node:url'
  import { Command } from 'commander'
  import { createJob, runJob } from './jobs/runner.js'
  import { loadChannelConfig } from './config/channel.js'
  import { openDb } from './db/index.js'
  import { scriptStage } from './stages/script.js'
  import { voiceStage } from './stages/voice.js'
  import { captionsStage } from './stages/captions.js'
  import { visualsVolumeStage } from './stages/visuals-volume.js'
  import { visualsPremiumStage } from './stages/visuals-premium.js'
  import { assembleStage } from './stages/assemble.js'
  import { qcStage } from './stages/qc.js'
  import type { StageDef, Tier } from './jobs/types.js'

  const TIERS: readonly Tier[] = ['volume', 'premium']

  /**
   * Validate a --tier flag value. Throws (naming every valid tier) on anything
   * else, BEFORE any db handle or job row is created, so an unsupported tier
   * fails clean rather than deep in a run. The thrown message is surfaced by
   * the parseAsync .catch below (exit 1).
   */
  export function parseTier(raw: string): Tier {
    if (!(TIERS as readonly string[]).includes(raw)) {
      throw new Error(
        `unsupported --tier "${raw}": valid tiers are ${TIERS.map((t) => `"${t}"`).join(', ')}`,
      )
    }
    return raw as Tier
  }

  /**
   * The stage list for one produce run. Only the visuals slot branches by tier;
   * script/voice/captions/qc branch internally on ctx.tier. Exported so tests
   * can assert the premium wiring without spawning a subprocess.
   */
  export function stagesForTier(tier: Tier): StageDef[] {
    return [
      scriptStage,
      voiceStage,
      captionsStage,
      tier === 'premium' ? visualsPremiumStage : visualsVolumeStage,
      assembleStage,
      qcStage(),
    ]
  }

  function resolveDbPath(flagDb?: string): string {
    return flagDb ?? process.env.BRAINROT_DB ?? 'data/brainrot.db'
  }

  const program = new Command()
  program.name('brainrot').description('Brainrot Machine CLI')

  program
    .command('produce')
    .requiredOption('--channel <path>', 'path to channel TOML')
    .requiredOption('--topic <text>', 'topic text')
    .option('--tier <tier>', 'quality tier: volume | premium', 'volume')
    .option('--db <path>', 'sqlite db path')
    .option('--runs-root <path>', 'runs root directory', 'runs')
    .action(async (opts: { channel: string; topic: string; tier: string; db?: string; runsRoot: string }) => {
      const tier = parseTier(opts.tier)
      const channel = loadChannelConfig(opts.channel)
      const db = openDb(resolveDbPath(opts.db))
      const jobId = createJob(db, channel, { topic: opts.topic, tier })
      const result = await runJob(db, channel, jobId, stagesForTier(tier), { runsRoot: opts.runsRoot })
      // better-sqlite3 is synchronous, so close the handle now; nothing else keeps the
      // event loop alive, letting the process drain stdout and exit on its own.
      db.close()
      process.stdout.write(JSON.stringify(result) + '\n')
      // Set exitCode (not process.exit) so a piped stdout flushes fully before exit —
      // process.exit can truncate the JSON line mid-write. exit 0 for ready/needs-review;
      // exit 1 for failed AND blocked (the JSON line carries the finer distinction).
      process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
    })

  program
    .command('jobs')
    .option('--db <path>', 'sqlite db path')
    .action((opts: { db?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      const rows = db
        .prepare('SELECT id, channel, tier, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 20')
        .all()
      console.table(rows)
    })

  program
    .command('costs')
    .option('--db <path>', 'sqlite db path')
    .action((opts: { db?: string }) => {
      const db = openDb(resolveDbPath(opts.db))
      const rows = db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, SUM(usd_micros) AS micros
           FROM costs
           WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
           GROUP BY day
           ORDER BY day DESC`,
        )
        .all() as { day: string; micros: number }[]
      console.table(rows.map((r) => ({ day: r.day, usd: `$${(r.micros / 1e6).toFixed(2)}` })))
    })

  // cli.test.ts imports parseTier/stagesForTier in-process, which must not fire
  // the argv parser. Node (and tsx) set argv[1] to the executed script's resolved
  // path, so this comparison is true exactly when cli.ts IS the entry script.
  const isMain =
    process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

  if (isMain) {
    // A rejected action (bad --channel path, unsupported --tier, etc.) would otherwise
    // print a raw unhandled-rejection stack. Surface just the message and exit 1.
    program.parseAsync(process.argv).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    })
  }
  ```

  Changes vs the old file, for review: (a) the Plan-1 `if (opts.tier !== 'volume') throw` block is
  replaced by `parseTier`; (b) the inline `const stages = [...]` array is replaced by the exported
  `stagesForTier`, which imports and wires `visualsPremiumStage` for premium; (c) `parseAsync` moved
  behind the `isMain` guard; (d) `--tier` help text now names both tiers. The `jobs` and `costs`
  commands are verbatim copies of the old file.

- [ ] **Step 4: Run the CLI tests — expect all 5 to PASS**

  ```sh
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `Test Files  1 passed`, `Tests  5 passed`. In particular the untouched
  `` `produce --help` `` test still passes (the `isMain` guard resolves true under
  `pnpm exec tsx src/cli.ts`, so the parser still runs when executed as a script).

- [ ] **Step 5: Add the in-process wiring tests to `src/cli.test.ts`**

  These lock in the premium wiring by identity. They cannot be written red-first: importing the
  pre-Step-3 `cli.ts` in-process would have executed `program.parseAsync(process.argv)` against
  vitest's argv and process.exit'd the worker — the red for this step was Step 2's subprocess
  failures. Expected to pass immediately.

  In `src/cli.test.ts`, add three imports after the existing `import { openDb } from './db/index.js'`
  line:

  ```ts
  import { parseTier, stagesForTier } from './cli.js'
  import { visualsPremiumStage } from './stages/visuals-premium.js'
  import { visualsVolumeStage } from './stages/visuals-volume.js'
  ```

  Then append this describe block at the end of the file, after the closing `})` of
  `describe('brainrot CLI', ...)`:

  ```ts
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
  ```

  Run:

  ```sh
  pnpm vitest run src/cli.test.ts
  ```

  Expected: `Tests  7 passed`. (If the run instead dies with commander output or an unexpected
  process exit, the `isMain` guard in Step 3 is wrong — the in-process import fired the parser.)

- [ ] **Step 6: Write the premium golden-path integration test**

  Create `src/jobs/golden-path-premium.test.ts` with exactly:

  ```ts
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
  ```

- [ ] **Step 7: Run the premium golden path — expected PASS (it is the integration proof for Tasks 1–15)**

  ```sh
  pnpm vitest run src/jobs/golden-path-premium.test.ts
  ```

  Expected: `Tests  1 passed` in roughly 1–3 minutes (real Remotion multi-clip render; the first-ever
  render downloads a headless Chrome shell). This test adds no production code of its own — it
  verifies earlier tasks integrate. If it fails, the defect is in an earlier task's files; triage by
  the thrown triage message:

  | Symptom in the triage output | Look at |
  |---|---|
  | `assemble` stage row failed, error mentions `scenes.json` / clip paths | Task 14 premium branch in `src/stages/assemble.ts` |
  | `visuals` stage ran at all (its row left 'done' but a fal/vision error appears) | seeding block above — the `job_stages` upsert did not mark `visuals` done |
  | qc.json shows `scene-coverage` failed | window/clip math in `src/stages/qc.ts` (Task 15) vs the manifest seeded here — the windows tile [0,6000] exactly |
  | qc.json shows `vision-spot-check` failed with a provider message | Task 15's client injection — the injected client must reach `visionJudgment` |
  | qc.json shows `narration-complete` failed | Task 10's `narrationWordCount` over a scenes artifact (hook + scene narrations = 23 words) |
  | `duration-bounds` failed with duration ~3000ms | Task 14 rendered only one scene window — `<Series>` sequencing |

- [ ] **Step 8: Env template, README, and the premium contract-test script**

  (a) Replace the entire contents of `.env.example` with:

  ```
  ANTHROPIC_API_KEY=
  WHISPERX_URL=http://localhost:8585
  BRAINROT_DB=data/brainrot.db
  LOG_LEVEL=info
  # fal.ai API key — premium visuals (FLUX keyframes, Kling/MiniMax image-to-video)
  FAL_KEY=
  # ElevenLabs API key — premium voice; unset or failing falls back to kokoro/edge-tts
  ELEVENLABS_API_KEY=
  # Operator safety net: cross-channel daily spend cap in USD (default 25)
  BRAINROT_GLOBAL_DAILY_USD=25
  ```

  (b) In `package.json`, replace the `"scripts"` object with (only `test:contract:premium` is new):

  ```json
  "scripts": {
    "build": "tsc --noEmit && tsc -p remotion --noEmit",
    "test": "vitest run",
    "test:contract": "CONTRACT=1 vitest run",
    "test:contract:premium": "CONTRACT=1 CONTRACT_PREMIUM=1 vitest run",
    "brainrot": "tsx src/cli.ts"
  },
  ```

  (c) Replace the entire contents of `README.md` with:

  ````markdown
  # Brainrot Machine

  Automated short-form video pipeline. `brainrot produce` turns a topic into a
  finished, QC-checked, word-captioned 9:16 MP4 in the library.

  ## Prerequisites

  - Node >= 22 and [pnpm](https://pnpm.io)
  - [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
  - Docker (for the WhisperX caption-alignment sidecar — volume tier and premium
    voice-fallback runs; a premium run whose ElevenLabs synth succeeds never
    touches it)

  ## Setup

  ```bash
  pnpm install
  cp .env.example .env          # fill in provider keys (see below)
  docker compose up -d whisperx # caption alignment sidecar
  ```

  Keys in `.env`:

  - `ANTHROPIC_API_KEY` — scripts (both tiers), premium vision checks
  - `FAL_KEY` — premium visuals (FLUX keyframes, Kling/MiniMax image-to-video)
  - `ELEVENLABS_API_KEY` — premium voice (unset: premium falls back to kokoro/edge-tts)
  - `BRAINROT_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (default 25)

  ## Seed background footage

  Drop vertical-friendly clips into the channel's background folder (default
  `assets/bg/`) and royalty-free music into `assets/bgm/`. The volume tier picks
  a clip at random, avoiding the 5 most recently used per channel.

  ```bash
  cp ~/footage/*.mp4 assets/bg/
  cp ~/music/*.mp3  assets/bgm/
  ```

  ## Produce a video

  ```bash
  pnpm brainrot produce --channel channels/example.toml --topic "Why is Venus so hot?"
  # options: --tier volume|premium  --db data/brainrot.db  --runs-root runs
  ```

  Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
  `1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

  ## Premium tier

  `--tier premium` swaps library footage for AI-generated visuals: per scene, a
  FLUX keyframe is generated, vision-checked by Claude, then animated with Kling
  image-to-video (all via fal.ai). Narration comes from ElevenLabs with
  word-level timings (no WhisperX dependency on the happy path), and QC adds
  scene-coverage and vision spot checks.

  ```bash
  pnpm brainrot produce --channel channels/example.toml \
    --topic "Why is Venus so hot?" --tier premium
  ```

  Requires `ANTHROPIC_API_KEY`, `FAL_KEY`, and `ELEVENLABS_API_KEY` in `.env`.

  Cost envelope: a typical ~35s premium video lands at **$2.30–4.50** (keyframes
  + clips + TTS + vision checks). The hard cap is `premium_per_video_usd` in the
  channel TOML (default **$7.00**); a breach parks the job `blocked` before the
  overspending call fires. Per-channel (`per_day_usd`) and global
  (`BRAINROT_GLOBAL_DAILY_USD`, default $25/day) daily caps stack on top.

  ## Where outputs land

  - Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
    `words.json`, then `background.mp4` for volume or `scene-NN.png` /
    `scene-NN.mp4` + `scenes.json` for premium, `final.mp4`, `qc.json`)
  - Finished video: `runs/<jobId>/assemble/final.mp4`
  - State + library + cost ledger: SQLite at `data/brainrot.db` (override with
    `--db` or `BRAINROT_DB`)

  ## Inspect

  ```bash
  pnpm brainrot jobs    # last 20 jobs
  pnpm brainrot costs   # per-day USD totals, last 7 days
  ```

  ## Tests

  ```bash
  pnpm test                   # unit + integration (mocked providers; real ffmpeg/Remotion)
  pnpm test:contract          # real paid calls, ~$0.20 total (FLUX image $0.05, MiniMax clip ~$0.10, ElevenLabs synth ~$0.01, one LLM call)
  pnpm test:contract:premium  # additionally renders one real Kling clip (~ $0.40 total)
  ```

  Media/render tests shell out to ffmpeg and run a real Remotion render; the first
  render downloads a headless Chrome shell.
  ````

  Verify the three edits landed:

  ```sh
  grep -E -c 'FAL_KEY=|ELEVENLABS_API_KEY=|BRAINROT_GLOBAL_DAILY_USD=' .env.example  # -> 3
  grep -c 'test:contract:premium' package.json                                        # -> 1
  grep -c '## Premium tier' README.md                                                 # -> 1
  ```

- [ ] **Step 9: Full suite and build gate**

  ```sh
  pnpm test
  pnpm build
  ```

  Expected: every test file passes — the whole pre-existing suite (Tasks 1–15 included) plus this
  task's 3 changed/new CLI tests and the premium golden path, zero failures. The two golden-path
  files each do a real Remotion render, so allow a few minutes. `pnpm build`
  (`tsc --noEmit && tsc -p remotion --noEmit`) exits 0 with no output — the `package.json` edit is
  also implicitly validated here (`pnpm` refuses to run on malformed JSON).

- [ ] **Step 10: Commit**

  ```sh
  git add src/cli.ts src/cli.test.ts src/jobs/golden-path-premium.test.ts .env.example README.md package.json
  git commit -m "feat: enable premium tier end-to-end via CLI with premium golden-path proof"
  ```

- [ ] **Step 11: Branch-end proof — one fully real premium produce (requires keys; run at branch level, do not commit artifacts)**

  Design spec §7 requires one fully REAL premium produce as the branch-end proof. This step needs
  `FAL_KEY`, `ELEVENLABS_API_KEY`, and `ANTHROPIC_API_KEY` all present in `.env`; if any is
  missing, record the skip in the execution ledger — this step is the only network-touching
  validation in the plan and is deliberately last.

  ```sh
  pnpm brainrot produce --channel channels/example.toml --topic "Why octopuses have three hearts" --tier premium --db /tmp/brainrot-premium-proof.db --runs-root /tmp/brainrot-premium-proof-runs
  ```

  Expected: one JSON result line with status `ready` or `needs-review`.

  Then verify the run by hand:

  - Inspect `/tmp/brainrot-premium-proof-runs/<jobId>/visuals/scenes.json` — scenes carry 1-based
    `index`, `method` is `aligned` or `proportional`, and every listed `clip` file exists in the
    visuals dir.
  - `ffprobe /tmp/brainrot-premium-proof-runs/<jobId>/assemble/final.mp4` — 1080×1920, ~30fps,
    audio stream present.
  - `pnpm brainrot costs --db /tmp/brainrot-premium-proof.db` — total below
    `premium_per_video_usd` ($7.00). Note the observed total in the execution ledger.

  Nothing from this step is committed — the DB and runs root live under `/tmp`.
