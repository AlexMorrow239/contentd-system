# Walking Skeleton + Volume-Tier Pipeline — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Brainrot Machine's deterministic pipeline core end-to-end for the volume tier: `brainrot produce --channel channels/example.toml --topic "..."` yields a finished, QC-checked, word-captioned 9:16 mp4 in the library.

**Architecture:** A TypeScript pipeline where each stage is idempotent, writes artifacts to `runs/<jobId>/<stage>/`, and records status in SQLite so failed jobs resume from the last good stage. Creative stages call external providers behind narrow wrappers; assembly is a Remotion composition; caption timing comes from a WhisperX Python sidecar. Spec: `docs/superpowers/specs/2026-07-18-brainrot-machine-design.md` (§3–§5, §7–§9).

**Tech Stack:** Node ≥ 22, pnpm, TypeScript (strict, ESM), vitest, commander, better-sqlite3, zod, smol-toml, execa (+ system ffmpeg/ffprobe), @anthropic-ai/sdk, kokoro-js (local TTS), msedge-tts (fallback TTS), Remotion 4 (@remotion/bundler, @remotion/renderer), pino; Python 3.11 + FastAPI + whisperx (sidecar, Dockerized).

## Global Constraints

- Node ≥ 22; package manager is **pnpm**; `"type": "module"` (ESM throughout); TypeScript `strict: true`.
- Tests are colocated: `src/**/*.test.ts`, run with `pnpm vitest run <path>`. Tests must not hit the network — external providers are mocked; tests that make one real paid/network call are **contract tests**, live in `src/**/*.contract.test.ts`, and run only via `pnpm test:contract` (excluded from default `pnpm test`).
- All money values are **integer micro-USD** (`usdMicros`; $1.00 = 1_000_000). Never floats.
- All durations in artifacts and code are **integer milliseconds** (`durationMs`, `startMs`, `endMs`).
- All structured LLM output is validated with **zod** before use; validation failure is a stage failure (throw), never a silent default.
- SQLite access only through `src/db/index.ts` (better-sqlite3, WAL mode). No raw `new Database()` elsewhere.
- Video canvas is **1080×1920 @ 30fps**, H.264 + AAC. No MoviePy anywhere; media manipulation is ffmpeg (via execa) or Remotion.
- Secrets come from env (`.env` loaded by the CLI entry only; never committed). `.env.example` documents every var.
- Commits use conventional-commit prefixes (`feat:`, `test:`, `chore:`, `fix:`).
- Default LLM model: `claude-sonnet-5` (configurable per channel; see spec §4).

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
channels/example.toml            # sample channel config (committed)
assets/bg/.gitkeep               # user-seeded background footage library
assets/bgm/.gitkeep              # user-seeded royalty-free music
src/cli.ts                       # commander entry: produce, jobs, costs
src/config/channel.ts            # ChannelConfig zod schema + TOML loader
src/db/index.ts                  # openDb (migrations, WAL) — sole DB gateway
src/db/schema.sql                # DDL for topics, jobs, job_stages, library, publishes, costs
src/jobs/types.ts                # Tier, StageName, JobContext, StageDef, artifact conventions
src/jobs/runner.ts               # createJob, runJob (resume/skip, stage status, library row)
src/jobs/costs.ts                # recordCost, assertBudget (per-video & per-day caps)
src/providers/anthropic.ts       # thin Claude wrapper: structuredCompletion()
src/providers/whisperx.ts        # HTTP client for the alignment sidecar
src/stages/script.ts             # topic → script.json (hook, segments, platformMeta)
src/stages/voice.ts              # script → narration.wav (kokoro-js → msedge-tts fallback)
src/stages/captions.ts           # narration + script → words.json (provider timings else WhisperX)
src/stages/visuals-volume.ts     # BG library pick (recent-use aware) → background.mp4
src/stages/assemble.ts           # Remotion bundle+render → final.mp4
src/stages/qc.ts                 # ffprobe/blackdetect checks → qc.json, gate to library
src/media/ffmpeg.ts              # probe(), cropToVertical(), loopToDuration() helpers
src/remotion-types.ts            # ShortVideoProps (kept src-side; remotion/ imports it)
remotion/index.ts                # registerRoot
remotion/Root.tsx                # composition registry (ShortVideo)
remotion/ShortVideo.tsx          # 1080×1920 comp: bg video + captions + narration + bgm
remotion/Captions.tsx            # word-by-word active-word highlight captions
sidecar/whisperx/app.py          # FastAPI: POST /align (wav + transcript → word timings)
sidecar/whisperx/test_app.py     # pytest for /align contract
sidecar/whisperx/requirements.txt
sidecar/whisperx/Dockerfile
docker-compose.yml               # whisperx sidecar service (pipeline runs on host in Plan 1)
```

## Interface Contract

Every task MUST use these exact names, signatures, and artifact schemas. Later tasks consume them verbatim; do not rename or "improve" them.

```ts
// ── src/config/channel.ts ─────────────────────────────────────────────
export interface CaptionStyle { font: string; fontSizePx: number; activeColor: string; inactiveColor: string; strokePx: number }
export interface ChannelConfig {
  name: string; niche: string[];
  tierMix: { volume: number; premium: number };
  voice: { volume: string };                    // kokoro voice id, e.g. "af_heart"
  captionStyle: CaptionStyle;
  bgDir: string; bgmDir: string;                // paths relative to repo root
  budget: { perVideoUsdMicros: number; perDayUsdMicros: number };
  scriptModel: string;                          // default "claude-sonnet-5"
}
export function loadChannelConfig(path: string): ChannelConfig  // throws on invalid TOML/schema

// ── src/db/index.ts ───────────────────────────────────────────────────
import type { Database } from 'better-sqlite3'
export function openDb(dbPath: string): Database  // applies schema.sql idempotently, sets WAL

// ── src/jobs/types.ts ─────────────────────────────────────────────────
export type Tier = 'volume' | 'premium'
export type StageName = 'script' | 'voice' | 'captions' | 'visuals' | 'assemble' | 'qc'
export const STAGE_ORDER: StageName[] // ['script','voice','captions','visuals','assemble','qc']
export interface JobContext {
  jobId: string; db: Database; channel: ChannelConfig; tier: Tier; topic: string;
  runDir: string;                                // runs/<jobId>
  artifactPath(stage: StageName, file: string): string  // runs/<jobId>/<stage>/<file>, mkdir -p
  log: import('pino').Logger
}
export interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }

// ── src/jobs/runner.ts ────────────────────────────────────────────────
export function createJob(db: Database, channel: ChannelConfig, opts: { topic: string; tier: Tier }): string // jobId (nanoid)
export interface JobResult { jobId: string; status: 'ready' | 'needs-review' | 'failed' | 'blocked'; videoPath?: string }
export async function runJob(db: Database, channel: ChannelConfig, jobId: string, stages: StageDef[]): Promise<JobResult>
// runJob: skips stages already 'done' in job_stages; marks running/done/failed; on stage throw,
// marks job 'failed' and returns. After qc: qc.json passed=true → library row state 'ready',
// else 'needs-review'. JobResult.videoPath = runs/<jobId>/assemble/final.mp4 when it exists.
// runJob catches BudgetExceededError distinctly → job status 'blocked', the throwing stage marked
// failed with the budget reason; returns { status: 'blocked' } (no library row).

// ── src/jobs/costs.ts ─────────────────────────────────────────────────
export class BudgetExceededError extends Error { constructor(public reason: string) }
export function recordCost(db: Database, jobId: string, provider: string, operation: string, usdMicros: number): void
export function assertBudget(db: Database, channel: ChannelConfig, jobId: string, upcomingUsdMicros: number): void
// throws BudgetExceededError if (job total + upcoming) > perVideoUsdMicros
// or (today's total across all jobs + upcoming) > perDayUsdMicros

// ── src/providers/anthropic.ts ────────────────────────────────────────
import { z } from 'zod'
export interface LlmUsageCost { usdMicros: number }
export async function structuredCompletion<T>(opts: {
  model: string; system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number
}): Promise<{ data: T; cost: LlmUsageCost }>
// Implementation uses a forced tool call named "emit" whose input_schema is the zod schema
// (via zod v4's native z.toJSONSchema, reused subschemas inlined); parses tool_use input;
// zod-validates; computes cost from response.usage at the model's per-token price table in this file.

// ── src/providers/whisperx.ts ─────────────────────────────────────────
export interface WordTiming { word: string; startMs: number; endMs: number }
export async function alignTranscript(opts: { baseUrl: string; wavPath: string; transcript: string }): Promise<WordTiming[]>
// POST {baseUrl}/align multipart fields: audio (file), transcript (text)
// sidecar responds { words: [{ word: string, start: number, end: number }] } in SECONDS (float);
// client converts to integer ms.

// ── Artifact schemas (JSON files under runs/<jobId>/) ─────────────────
// script/script.json
export interface ScriptOutput {
  hook: string
  segments: { text: string; visualDirection: string }[]
  platformMeta: Record<'youtube' | 'tiktok' | 'instagram', { title: string; description: string; hashtags: string[] }>
}
// voice/narration.wav  (mono or stereo PCM wav)
// voice/voice.json
export interface VoiceMeta { provider: 'kokoro' | 'edge-tts'; voiceId: string; durationMs: number }
// captions/words.json
export interface CaptionsArtifact { words: WordTiming[] }
// visuals/background.mp4  — 1080×1920, duration ≥ narration durationMs
// assemble/final.mp4      — 1080×1920@30fps H.264+AAC
// qc/qc.json
export interface QcResult { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] }

// ── src/media/ffmpeg.ts ───────────────────────────────────────────────
export interface MediaProbe { durationMs: number; width: number; height: number; hasAudio: boolean; fps: number }
export async function probe(file: string): Promise<MediaProbe>
export async function cropToVertical(input: string, output: string): Promise<void>   // center-crop to 1080x1920, scale
export async function loopToDuration(input: string, output: string, durationMs: number): Promise<void>

// ── src/remotion-types.ts ─────────────────────────────────────────────
// Kept src-side; remotion/ShortVideo.tsx imports (and re-exports) ShortVideoProps
// from here so the NodeNext root program never loads a remotion .tsx via a type import.
export interface ShortVideoProps {
  audioSrc: string; backgroundSrc: string; bgmSrc?: string; bgmVolume?: number  // default 0.12
  words: WordTiming[]; style: CaptionStyle; durationMs: number
}
// Composition id: "ShortVideo", 1080x1920, fps 30; durationInFrames from durationMs via calculateMetadata.
```

**DB schema (src/db/schema.sql) — exact DDL:**

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_stages (
  job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  error TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (job_id, stage)
);
CREATE TABLE IF NOT EXISTS library (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id), video_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','needs-review','published','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL, operation TEXT NOT NULL, usd_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bg_usage (
  channel TEXT NOT NULL, file TEXT NOT NULL, used_at TEXT NOT NULL,
  PRIMARY KEY (channel, file, used_at)
);
-- topics & publishes tables arrive in Plans 2 and 3.
```

> **Blocked semantics (Plan 1):** the `library.state = 'blocked'` value is reserved for publish-time blocks introduced in Plan 3; Plan-1 budget blocks live on `jobs.status = 'blocked'` (a budget breach never writes a library row).

**channels/example.toml — exact content:**

```toml
name = "example"
niche = ["space facts", "astronomy"]
script_model = "claude-sonnet-5"
bg_dir = "assets/bg"
bgm_dir = "assets/bgm"
# NOTE: top-level keys MUST precede the first [table] header — TOML binds
# any key after a header into that table.

[tier_mix]
volume = 2
premium = 1

[voice]
volume = "af_heart"

[caption_style]
font = "Inter"
font_size_px = 72
active_color = "#FFD700"
inactive_color = "#FFFFFF"
stroke_px = 8

[budget]
per_video_usd = 8.0    # loader converts to usdMicros
per_day_usd = 20.0
```

(Loader maps snake_case TOML → camelCase config and converts USD floats to integer micros at the boundary.)

**WhisperX sidecar contract:** `POST /align` (multipart: `audio` wav file, `transcript` text) → `200 {"words": [{"word": "hello", "start": 0.12, "end": 0.31}]}` (seconds, float). Error → `4xx/5xx {"detail": string}`. Model: whisperx alignment-only using its `load_align_model` + `align` on the provided transcript (no re-transcription), `WHISPERX_DEVICE` env (`cpu` default).

---

<!-- TASK GROUPS A (1–5), B (6–9), C (10–15) are appended below. -->
## Task Group A: Foundation

Tasks 1–5 build the deterministic core: project toolchain, channel-config loader, the sole SQLite gateway, the cost ledger with hard caps, and the resumable job runner. Each task is committed independently and leaves `pnpm test` green. Relative imports use `.js` extensions throughout (TypeScript `moduleResolution: NodeNext`).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `assets/bg/.gitkeep`, `assets/bgm/.gitkeep`
- Test: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the toolchain later tasks rely on — scripts `pnpm test` (`vitest run`, excludes `**/*.contract.test.ts`), `pnpm test:contract` (`CONTRACT=1 vitest run`), `pnpm build` (`tsc --noEmit`, which typechecks `src/` only under this task's tsconfig; Task 12 adds a separate `remotion/tsconfig.json` under `moduleResolution: Bundler` and extends `build` to also typecheck `remotion/`), `pnpm brainrot` (`tsx src/cli.ts`); ESM + `moduleResolution: NodeNext` (relative imports in `src/` MUST end in `.js`); pinned deps available to all later tasks (`better-sqlite3` ^12, `zod` ^4, `smol-toml` ^1.7, `nanoid` ^6, `pino` ^10, `@anthropic-ai/sdk` ^0.112, Remotion ^4.0, React ^19, `execa` ^10, `commander` ^15); `.env.example` documents `ANTHROPIC_API_KEY`, `WHISPERX_URL`, `BRAINROT_DB`; committed `assets/bg` and `assets/bgm` seed dirs.

- [ ] **Step 1: Initialize git + write the complete `package.json`.** Run `git init` in the repo root, then create `package.json` verbatim (pinned deps declared directly so `pnpm install` materializes exact majors — no drift from a sequence of `pnpm add` calls):

```json
{
  "name": "brainrot-machine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "test:contract": "CONTRACT=1 vitest run",
    "brainrot": "tsx src/cli.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.112.3",
    "@remotion/bundler": "^4.0.491",
    "@remotion/cli": "^4.0.491",
    "@remotion/renderer": "^4.0.491",
    "better-sqlite3": "^12.11.1",
    "commander": "^15.0.0",
    "dotenv": "^17.4.2",
    "execa": "^10.0.0",
    "kokoro-js": "^1.2.1",
    "msedge-tts": "^2.0.7",
    "nanoid": "^6.0.0",
    "pino": "^10.3.1",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "remotion": "^4.0.491",
    "smol-toml": "^1.7.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.0.0",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.0",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Write the failing smoke test `src/smoke.test.ts`.** Self-contained — proves ESM import of a node builtin, TypeScript type annotations, and vitest all work end-to-end:

```ts
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

describe('smoke', () => {
  it('runs under the ESM + TypeScript + vitest toolchain', () => {
    const canvas: { width: number; height: number; fps: number } = {
      width: 1080,
      height: 1920,
      fps: 30,
    }
    expect(join('runs', 'abc', 'script')).toBe('runs/abc/script')
    expect(canvas.width).toBe(1080)
    expect(canvas.height).toBe(1920)
    expect(canvas.fps).toBe(30)
  })
})
```

- [ ] **Step 3: Run the smoke test expecting failure.** Command: `pnpm test`. Dependencies are not installed yet, so the `vitest` binary is absent. Expected failure: the script exits non-zero (code 127) with `sh: vitest: command not found` followed by pnpm's `ELIFECYCLE  Command failed`.

- [ ] **Step 4: Install exact dependencies.** Command: `pnpm install`. This resolves every pinned range in `package.json` (installs `better-sqlite3` native build, vitest, tsx, typescript, etc.) and writes `pnpm-lock.yaml`.

- [ ] **Step 5: Write `tsconfig.json`.** ES2022 target, `NodeNext` module + resolution, strict, `react-jsx`, no emit (the app runs via `tsx`; `build` only typechecks):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

> `remotion/` is intentionally excluded from this root tsconfig: its `.tsx` files use extensionless relative imports that NodeNext rejects. Task 12 adds `remotion/tsconfig.json` (`moduleResolution: Bundler`) and wires `tsc -p remotion --noEmit` into `pnpm build`.

- [ ] **Step 6: Write `vitest.config.ts`.** `testTimeout` 30000; contract tests excluded from the default run and selected only when `CONTRACT=1`:

```ts
import { defineConfig } from 'vitest/config'

const contract = process.env.CONTRACT === '1'

export default defineConfig({
  test: {
    testTimeout: 30000,
    include: contract ? ['src/**/*.contract.test.ts'] : ['src/**/*.test.ts'],
    exclude: contract
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'src/**/*.contract.test.ts'],
  },
})
```

- [ ] **Step 7: Write `.gitignore`.**

```gitignore
node_modules/
dist/
runs/
data/
.env
.remotion/
assets/bg/*
assets/bgm/*
!assets/bg/.gitkeep
!assets/bgm/.gitkeep
```

- [ ] **Step 8: Write `.env.example`.**

```dotenv
ANTHROPIC_API_KEY=
WHISPERX_URL=http://localhost:8585
BRAINROT_DB=data/brainrot.db
```

- [ ] **Step 9: Create the asset seed dirs.** Command: `mkdir -p assets/bg assets/bgm && touch assets/bg/.gitkeep assets/bgm/.gitkeep`. These keep the user-seeded footage/music folders in git while `.gitignore` excludes their contents.

- [ ] **Step 10: Run the smoke test expecting pass.** Command: `pnpm test`. Expected: vitest reports `Test Files  1 passed (1)` and `Tests  1 passed (1)`.

- [ ] **Step 11: Commit.** Command: `git add -A && git commit -m "chore: scaffold pnpm + typescript + vitest project"`.

---

### Task 2: Channel config loader

**Files:**
- Create: `channels/example.toml`, `src/config/channel.ts`
- Test: `src/config/channel.test.ts`

**Interfaces:**
- Consumes (Task 1): `zod` ^4, `smol-toml` ^1.7 (`parse`), NodeNext `.js` import convention.
- Produces: `interface CaptionStyle`, `interface ChannelConfig`, and `loadChannelConfig(path: string): ChannelConfig` (throws on invalid TOML/schema or a missing file). Tasks 4 and 5 read `channel.name`, `channel.budget.perVideoUsdMicros`, `channel.budget.perDayUsdMicros`, and `channel.scriptModel`.

- [ ] **Step 1: Write the committed sample config `channels/example.toml`.** Exact content from the plan header (this file is the fixture the first test parses):

```toml
name = "example"
niche = ["space facts", "astronomy"]
script_model = "claude-sonnet-5"
bg_dir = "assets/bg"
bgm_dir = "assets/bgm"
# NOTE: top-level keys MUST precede the first [table] header — TOML binds
# any key after a header into that table.

[tier_mix]
volume = 2
premium = 1

[voice]
volume = "af_heart"

[caption_style]
font = "Inter"
font_size_px = 72
active_color = "#FFD700"
inactive_color = "#FFFFFF"
stroke_px = 8

[budget]
per_video_usd = 8.0    # loader converts to usdMicros
per_day_usd = 20.0
```

- [ ] **Step 2: Write the failing test `src/config/channel.test.ts`.** Covers example parse (snake→camel, USD→micros), the `scriptModel` default, a missing required field, and a nonexistent file:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChannelConfig } from './channel.js'

describe('loadChannelConfig', () => {
  it('parses channels/example.toml into a ChannelConfig', () => {
    const cfg = loadChannelConfig('channels/example.toml')
    expect(cfg.name).toBe('example')
    expect(cfg.niche).toEqual(['space facts', 'astronomy'])
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
    expect(cfg.tierMix).toEqual({ volume: 2, premium: 1 })
    expect(cfg.voice).toEqual({ volume: 'af_heart' })
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
      perDayUsdMicros: 20_000_000,
    })
  })

  it('defaults scriptModel to claude-sonnet-5 when script_model is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chan-'))
    const file = join(dir, 'no-model.toml')
    writeFileSync(
      file,
      [
        'name = "nomodel"',
        'niche = ["x"]',
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        '',
        '[tier_mix]',
        'volume = 1',
        'premium = 0',
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
    const cfg = loadChannelConfig(file)
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
  })

  it('throws when a required field is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chan-'))
    const file = join(dir, 'bad.toml')
    // [budget] table omitted entirely
    writeFileSync(
      file,
      [
        'name = "bad"',
        'niche = ["x"]',
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        '',
        '[tier_mix]',
        'volume = 1',
        'premium = 0',
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
      ].join('\n'),
    )
    expect(() => loadChannelConfig(file)).toThrow()
  })

  it('throws when the file does not exist', () => {
    expect(() => loadChannelConfig('channels/does-not-exist.toml')).toThrow()
  })
})
```

- [ ] **Step 3: Run the test expecting failure.** Command: `pnpm vitest run src/config/channel.test.ts`. Expected failure: the suite fails to collect — `Error: Failed to load url ./channel.js (resolved id: ./channel.js) ... Does the file exist?` (`src/config/channel.ts` does not exist yet).

- [ ] **Step 4: Write the implementation `src/config/channel.ts`.** A zod schema validates the raw snake_case TOML (defaulting `script_model`); the loader maps to camelCase and converts USD floats to integer micros at the boundary:

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

export interface ChannelConfig {
  name: string
  niche: string[]
  tierMix: { volume: number; premium: number }
  voice: { volume: string }
  captionStyle: CaptionStyle
  bgDir: string
  bgmDir: string
  budget: { perVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
}

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
  }),
  caption_style: z.object({
    font: z.string(),
    font_size_px: z.number(),
    active_color: z.string(),
    inactive_color: z.string(),
    stroke_px: z.number(),
  }),
  budget: z.object({
    per_video_usd: z.number(),
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
    voice: { volume: raw.voice.volume },
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
      perDayUsdMicros: usdToMicros(raw.budget.per_day_usd),
    },
    scriptModel: raw.script_model,
  }
}
```

- [ ] **Step 5: Run the test expecting pass.** Command: `pnpm vitest run src/config/channel.test.ts`. Expected: `Tests  4 passed (4)`.

- [ ] **Step 6: Commit.** Command: `git add -A && git commit -m "feat: channel config TOML loader with usd-to-micros mapping"`.

---

### Task 3: SQLite gateway

**Files:**
- Create: `src/db/schema.sql`, `src/db/index.ts`
- Test: `src/db/index.test.ts`

**Interfaces:**
- Consumes (Task 1): `better-sqlite3` ^12, NodeNext `.js` convention.
- Produces: `openDb(dbPath: string): Database` — the sole DB gateway. It `mkdir -p`s the parent dir, opens the file, sets `journal_mode = WAL`, and applies `schema.sql` idempotently. Creates tables `jobs`, `job_stages`, `library`, `costs`, `bg_usage`. Foreign-key enforcement is left OFF (no `PRAGMA foreign_keys = ON`), so Task 4 may insert `costs` rows without a matching `jobs` row. Tasks 4 and 5 open the DB exclusively through this function.

- [ ] **Step 1: Write the failing test `src/db/index.test.ts`.** Asserts parent-dir creation + all tables, idempotent reopen, and active WAL mode. A nested `db` path proves `mkdir -p`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './index.js'

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-db-'))
  return join(dir, 'nested', 'brainrot.db') // 'nested' does not exist yet
}

describe('openDb', () => {
  it('creates the parent directory and all tables', () => {
    const db = openDb(tempDbPath())
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('jobs')
    expect(names).toContain('job_stages')
    expect(names).toContain('library')
    expect(names).toContain('costs')
    expect(names).toContain('bg_usage')
    db.close()
  })

  it('is idempotent: reopening the same file succeeds', () => {
    const path = tempDbPath()
    const first = openDb(path)
    first.close()
    const second = openDb(path)
    const rows = second
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
      .all()
    expect(rows).toHaveLength(1)
    second.close()
  })

  it('enables WAL journal mode', () => {
    const db = openDb(tempDbPath())
    const mode = db.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
    db.close()
  })
})
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/db/index.test.ts`. Expected failure: `Error: Failed to load url ./index.js (resolved id: ./index.js) ... Does the file exist?` (`src/db/index.ts` does not exist yet).

- [ ] **Step 3: Write `src/db/schema.sql`.** Exact DDL from the plan's Interface Contract:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('volume','premium')),
  topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','failed','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_stages (
  job_id TEXT NOT NULL REFERENCES jobs(id), stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  error TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (job_id, stage)
);
CREATE TABLE IF NOT EXISTS library (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id), video_path TEXT NOT NULL, metadata_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','needs-review','published','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL, operation TEXT NOT NULL, usd_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bg_usage (
  channel TEXT NOT NULL, file TEXT NOT NULL, used_at TEXT NOT NULL,
  PRIMARY KEY (channel, file, used_at)
);
-- topics & publishes tables arrive in Plans 2 and 3.
```

- [ ] **Step 4: Write `src/db/index.ts`.** Reads `schema.sql` relative to the module (found via `import.meta.url`, so it resolves the same whether run by `tsx` or vitest):

```ts
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url))

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(readFileSync(schemaPath, 'utf8'))
  return db
}
```

- [ ] **Step 5: Run the test expecting pass.** Command: `pnpm vitest run src/db/index.test.ts`. Expected: `Tests  3 passed (3)`.

- [ ] **Step 6: Commit.** Command: `git add -A && git commit -m "feat: sqlite gateway with WAL and idempotent schema"`.

---

### Task 4: Cost ledger

**Files:**
- Create: `src/jobs/costs.ts`
- Test: `src/jobs/costs.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3), `ChannelConfig` (Task 2 — `budget.perVideoUsdMicros`, `budget.perDayUsdMicros`), `better-sqlite3` `Database` type.
- Produces: `class BudgetExceededError extends Error` (with public `reason`), `recordCost(db, jobId, provider, operation, usdMicros): void`, `assertBudget(db, channel, jobId, upcomingUsdMicros): void`. Comparisons are strict `>` (equal-to-cap passes). Per-day uses the UTC date of `created_at` summed across ALL jobs. Task 5 and the paid stage wrappers call these before every billable provider call.

- [ ] **Step 1: Write the failing test `src/jobs/costs.test.ts`.** Covers row insertion, under-cap pass, per-video breach, per-day breach across two jobs, and the exact-boundary pass:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/index.js'
import type { ChannelConfig } from '../config/channel.js'
import { assertBudget, BudgetExceededError, recordCost } from './costs.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainrot-costs-'))
  return openDb(join(dir, 'brainrot.db'))
}

function channel(perVideoUsdMicros: number, perDayUsdMicros: number): ChannelConfig {
  return {
    name: 'test',
    niche: ['x'],
    tierMix: { volume: 1, premium: 0 },
    voice: { volume: 'af_heart' },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros, perDayUsdMicros },
    scriptModel: 'claude-sonnet-5',
  }
}

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

  it('passes when job total + upcoming is under the per-video cap', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 2_000_000)
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).not.toThrow()
    db.close()
  })

  it('throws on a per-video breach', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 7_500_000)
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).toThrow(BudgetExceededError)
    db.close()
  })

  it('throws on a per-day breach across two jobs', () => {
    const db = tempDb()
    // per-video cap is generous so only the per-day cap can trip
    recordCost(db, 'job-1', 'anthropic', 'script', 12_000_000)
    recordCost(db, 'job-2', 'fal', 'visuals', 7_000_000)
    // job-3 has no prior spend, but the day already holds 19M across all jobs
    expect(() =>
      assertBudget(db, channel(100_000_000, 20_000_000), 'job-3', 2_000_000),
    ).toThrow(BudgetExceededError)
    db.close()
  })

  it('passes at the exact boundary (total + upcoming equals the cap)', () => {
    const db = tempDb()
    recordCost(db, 'job-1', 'anthropic', 'script', 7_000_000)
    // per-video: 7_000_000 + 1_000_000 == 8_000_000 cap; per-day 8_000_000 < 20_000_000
    expect(() =>
      assertBudget(db, channel(8_000_000, 20_000_000), 'job-1', 1_000_000),
    ).not.toThrow()
    db.close()
  })
})
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/jobs/costs.test.ts`. Expected failure: `Error: Failed to load url ./costs.js (resolved id: ./costs.js) ... Does the file exist?` (`src/jobs/costs.ts` does not exist yet).

- [ ] **Step 3: Write the implementation `src/jobs/costs.ts`.** Per-day matches the UTC date via `substr(created_at, 1, 10)` (the stored `...Z` ISO timestamp) against `strftime('%Y-%m-%d','now')`; both checks are strict `>`:

```ts
import type { Database } from 'better-sqlite3'
import type { ChannelConfig } from '../config/channel.js'

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

export function assertBudget(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  upcomingUsdMicros: number,
): void {
  const jobRow = db
    .prepare('SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE job_id = ?')
    .get(jobId) as { total: number }
  const jobProjected = jobRow.total + upcomingUsdMicros
  if (jobProjected > channel.budget.perVideoUsdMicros) {
    throw new BudgetExceededError(
      `per-video budget exceeded: ${jobProjected} > ${channel.budget.perVideoUsdMicros} usdMicros`,
    )
  }

  const dayRow = db
    .prepare(
      "SELECT COALESCE(SUM(usd_micros), 0) AS total FROM costs WHERE substr(created_at, 1, 10) = strftime('%Y-%m-%d','now')",
    )
    .get() as { total: number }
  const dayProjected = dayRow.total + upcomingUsdMicros
  if (dayProjected > channel.budget.perDayUsdMicros) {
    throw new BudgetExceededError(
      `per-day budget exceeded: ${dayProjected} > ${channel.budget.perDayUsdMicros} usdMicros`,
    )
  }
}
```

- [ ] **Step 4: Run the test expecting pass.** Command: `pnpm vitest run src/jobs/costs.test.ts`. Expected: `Tests  5 passed (5)`.

- [ ] **Step 5: Commit.** Command: `git add -A && git commit -m "feat: cost ledger with per-video and per-day budget caps"`.

---

### Task 5: Job runner

**Files:**
- Create: `src/jobs/types.ts`, `src/jobs/runner.ts`
- Test: `src/jobs/runner.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 3), `ChannelConfig` (Task 2), `better-sqlite3` `Database` type, `nanoid` (Task 1), `pino` (Task 1).
- Produces:
  - `src/jobs/types.ts`: `type Tier = 'volume' | 'premium'`; `type StageName = 'script' | 'voice' | 'captions' | 'visuals' | 'assemble' | 'qc'`; `const STAGE_ORDER: StageName[]` = `['script','voice','captions','visuals','assemble','qc']`; `interface JobContext { jobId; db; channel; tier; topic; runDir; artifactPath(stage, file): string; log }`; `interface StageDef { name: StageName; run(ctx: JobContext): Promise<void> }`.
  - `src/jobs/runner.ts`: `createJob(db, channel, opts: { topic; tier }, options?: { runsRoot?: string }): string` (nanoid id; inserts a `queued` job + 6 `pending` `job_stages` rows); `interface JobResult { jobId; status: 'ready' | 'needs-review' | 'failed' | 'blocked'; videoPath? }`; `runJob(db, channel, jobId, stages: StageDef[], options?: { runsRoot?: string }): Promise<JobResult>`.
  - **Runs root:** both `createJob` and `runJob` take an optional trailing `options: { runsRoot?: string }` (default `{}`); `runsRoot` defaults to `'runs'`. `JobContext.runDir = <runsRoot>/<jobId>` and `artifactPath(stage, file) = <runsRoot>/<jobId>/<stage>/<file>` (mkdir -p on each call). Group B stage tasks receive `ctx` and must write artifacts only through `ctx.artifactPath(...)`.
  - **Runner semantics:** sets job `running`; iterates the given `stages` in order; skips any stage whose `job_stages.status='done'` (resume); wraps each `run` in try/catch → `running`→`done` or `running`→`failed` (stores `error.message`). On a stage throw the runner discriminates: a `BudgetExceededError` marks the stage failed with the budget reason, sets the job `blocked`, and returns `{ status: 'blocked' }`; any other error sets the job `failed` and returns `{ status: 'failed' }`. Neither writes a library row. After all stages pass it reads `<runDir>/qc/qc.json` → `passed:true` upserts a `library` row `state='ready'`, `passed:false` → `state='needs-review'`; `metadata_json` = the `platformMeta` field of `<runDir>/script/script.json` if that file exists, else `'{}'`; `video_path` = `<runDir>/assemble/final.mp4`. The library upsert and the final job-`done` update run inside **one** better-sqlite3 transaction so a re-run of a completed job is idempotent (`INSERT ... ON CONFLICT(job_id) DO UPDATE`). Returns `JobResult` whose `videoPath` is set only when `final.mp4` exists on disk.

- [ ] **Step 1: Write the failing test `src/jobs/runner.test.ts`.** Uses in-test fake `StageDef`s writing marker files (no real stages) and a fresh temp dir per test for both the DB and runs root:

```ts
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import type { ChannelConfig } from '../config/channel.js'
import { BudgetExceededError } from './costs.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName } from './types.js'
import { createJob, runJob } from './runner.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'brainrot-run-'))
  const db = openDb(join(root, 'data', 'brainrot.db'))
  return { db, runsRoot: join(root, 'runs') }
}

function testChannel(): ChannelConfig {
  return {
    name: 'test',
    niche: ['space'],
    tierMix: { volume: 2, premium: 1 },
    voice: { volume: 'af_heart' },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
  }
}

function row<T>(db: Database, sql: string, ...params: any[]): T {
  return db.prepare(sql).get(...params) as T
}

// Fake happy-path stages: script writes script.json, assemble writes final.mp4,
// qc writes qc.json with the given pass flag, others drop a marker.
function buildStages(calls: StageName[], opts: { qcPassed: boolean } = { qcPassed: true }): StageDef[] {
  return STAGE_ORDER.map((name) => ({
    name,
    async run(ctx: JobContext) {
      calls.push(name)
      if (name === 'script') {
        writeFileSync(
          ctx.artifactPath('script', 'script.json'),
          JSON.stringify({
            hook: 'Did you know?',
            segments: [{ text: 'Space is big.', visualDirection: 'stars' }],
            platformMeta: {
              youtube: { title: 'Space', description: 'd', hashtags: ['#space'] },
              tiktok: { title: 'Space', description: 'd', hashtags: ['#space'] },
              instagram: { title: 'Space', description: 'd', hashtags: ['#space'] },
            },
          }),
        )
      } else if (name === 'assemble') {
        writeFileSync(ctx.artifactPath('assemble', 'final.mp4'), 'FAKEMP4')
      } else if (name === 'qc') {
        writeFileSync(
          ctx.artifactPath('qc', 'qc.json'),
          JSON.stringify({ passed: opts.qcPassed, checks: [] }),
        )
      } else {
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      }
    },
  }))
}

describe('createJob', () => {
  it('inserts a queued job and six pending stages', () => {
    const { db } = setup()
    const jobId = createJob(db, testChannel(), { topic: 'space', tier: 'volume' })
    expect(typeof jobId).toBe('string')
    expect(jobId.length).toBeGreaterThan(0)
    const job = row<{ channel: string; tier: string; topic: string; status: string }>(
      db,
      'SELECT channel, tier, topic, status FROM jobs WHERE id = ?',
      jobId,
    )
    expect(job).toEqual({ channel: 'test', tier: 'volume', topic: 'space', status: 'queued' })
    const stages = (
      db.prepare('SELECT stage FROM job_stages WHERE job_id = ? ORDER BY rowid').all(jobId) as {
        stage: string
      }[]
    ).map((r) => r.stage)
    expect(stages).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])
    const pending = row<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'pending'",
      jobId,
    )
    expect(pending).toEqual({ n: 6 })
  })
})

describe('runJob', () => {
  it('happy path: qc pass → library ready with videoPath and metadata', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls), { runsRoot })

    expect(result.status).toBe('ready')
    expect(result.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(existsSync(result.videoPath!)).toBe(true)
    expect(calls).toEqual(['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'])

    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM job_stages WHERE job_id = ? AND status = 'done'",
        jobId,
      ),
    ).toEqual({ n: 6 })
    const lib = row<{ state: string; video_path: string; metadata_json: string }>(
      db,
      'SELECT state, video_path, metadata_json FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.state).toBe('ready')
    expect(lib.video_path).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))
    expect(JSON.parse(lib.metadata_json).youtube.title).toBe('Space')
  })

  it('qc fail → library needs-review, job still done', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls, { qcPassed: false }), {
      runsRoot,
    })

    expect(result.status).toBe('needs-review')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId)).toEqual({
      status: 'done',
    })
    expect(
      row<{ state: string }>(db, 'SELECT state FROM library WHERE job_id = ?', jobId).state,
    ).toBe('needs-review')
  })

  it('middle-stage throw → job failed, later stages untouched, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const calls: StageName[] = []
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        calls.push(name)
        if (name === 'captions') throw new Error('boom captions')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('failed')
    expect(result.videoPath).toBeUndefined()
    expect(calls).toEqual(['script', 'voice', 'captions'])

    const status = (stage: StageName) =>
      row<{ status: string }>(
        db,
        'SELECT status FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        stage,
      ).status
    expect(status('script')).toBe('done')
    expect(status('voice')).toBe('done')
    expect(status('captions')).toBe('failed')
    expect(status('visuals')).toBe('pending')
    expect(status('assemble')).toBe('pending')
    expect(status('qc')).toBe('pending')

    expect(
      row<{ error: string }>(
        db,
        'SELECT error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'captions',
      ).error,
    ).toBe('boom captions')
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'failed',
    )
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('resume: pre-done stages are skipped and their run fns are not called', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    // Simulate a prior partial run: first two stages already done.
    db.prepare(
      "UPDATE job_stages SET status = 'done' WHERE job_id = ? AND stage IN ('script','voice')",
    ).run(jobId)

    const calls: StageName[] = []
    const result = await runJob(db, channel, jobId, buildStages(calls), { runsRoot })

    expect(calls).toEqual(['captions', 'visuals', 'assemble', 'qc'])
    expect(result.status).toBe('ready')
    // script stage was skipped, so script.json was never written → metadata falls back to '{}'
    expect(
      row<{ metadata_json: string }>(
        db,
        'SELECT metadata_json FROM library WHERE job_id = ?',
        jobId,
      ).metadata_json,
    ).toBe('{}')
  })

  it('artifactPath creates each stage directory on demand', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const seen: Record<string, boolean> = {}
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        const dir = join(runsRoot, jobId, name)
        seen[`${name}:before`] = existsSync(dir)
        const file =
          name === 'qc' ? 'qc.json' : name === 'assemble' ? 'final.mp4' : `${name}.txt`
        const p = ctx.artifactPath(name, file)
        seen[`${name}:after`] = existsSync(dir)
        writeFileSync(p, name === 'qc' ? JSON.stringify({ passed: true, checks: [] }) : 'x')
      },
    }))
    await runJob(db, channel, jobId, stages, { runsRoot })

    for (const name of STAGE_ORDER) {
      expect(seen[`${name}:before`]).toBe(false)
      expect(seen[`${name}:after`]).toBe(true)
    }
  })

  it('budget breach → job blocked, result blocked, no library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })
    const stages: StageDef[] = STAGE_ORDER.map((name) => ({
      name,
      async run(ctx: JobContext) {
        if (name === 'script') throw new BudgetExceededError('per-video budget exceeded')
        writeFileSync(ctx.artifactPath(name, `${name}.txt`), 'ok')
      },
    }))
    const result = await runJob(db, channel, jobId, stages, { runsRoot })

    expect(result.status).toBe('blocked')
    expect(result.videoPath).toBeUndefined()
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'blocked',
    )
    expect(
      row<{ status: string; error: string }>(
        db,
        'SELECT status, error FROM job_stages WHERE job_id = ? AND stage = ?',
        jobId,
        'script',
      ),
    ).toEqual({ status: 'failed', error: 'per-video budget exceeded' })
    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(0)
  })

  it('is idempotent: a second runJob on a completed job returns cleanly with one library row', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })

    const first = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(first.status).toBe('ready')

    // Second run: every stage is already 'done', so the runner skips straight to the
    // final library upsert + job-done update. It must not throw a PRIMARY KEY conflict.
    const second = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(second.status).toBe('ready')
    expect(second.videoPath).toBe(join(runsRoot, jobId, 'assemble', 'final.mp4'))

    expect(
      row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE job_id = ?', jobId).n,
    ).toBe(1)
  })

  it('is idempotent even with a pre-seeded library row (crash before job marked done)', async () => {
    const { db, runsRoot } = setup()
    const channel = testChannel()
    const jobId = createJob(db, channel, { topic: 'space', tier: 'volume' })

    // Simulate a crash after the library row was written but before the job was
    // marked done: mark every stage done and pre-seed a stale library row.
    db.prepare("UPDATE job_stages SET status = 'done' WHERE job_id = ?").run(jobId)
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES (?, ?, '{}', 'needs-review')",
    ).run(jobId, join(runsRoot, jobId, 'assemble', 'final.mp4'))

    // qc.json must exist for the final gate; seed a passing one (stages are skipped).
    const qcDir = join(runsRoot, jobId, 'qc')
    mkdirSync(qcDir, { recursive: true })
    writeFileSync(join(qcDir, 'qc.json'), JSON.stringify({ passed: true, checks: [] }))

    const result = await runJob(db, channel, jobId, buildStages([]), { runsRoot })
    expect(result.status).toBe('ready')
    const lib = row<{ n: number; state: string }>(
      db,
      'SELECT COUNT(*) AS n, MAX(state) AS state FROM library WHERE job_id = ?',
      jobId,
    )
    expect(lib.n).toBe(1)
    expect(lib.state).toBe('ready') // upsert overwrote the stale 'needs-review'
    expect(row<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', jobId).status).toBe(
      'done',
    )
  })
})
```

- [ ] **Step 2: Run the test expecting failure.** Command: `pnpm vitest run src/jobs/runner.test.ts`. Expected failure: the suite fails to collect — `Error: Failed to load url ./types.js (resolved id: ./types.js) ... Does the file exist?` (`src/jobs/types.ts` and `src/jobs/runner.ts` do not exist yet).

- [ ] **Step 3: Write `src/jobs/types.ts`.** The shared vocabulary consumed by the runner and every Group B stage:

```ts
import type { Database } from 'better-sqlite3'
import type { Logger } from 'pino'
import type { ChannelConfig } from '../config/channel.js'

export type Tier = 'volume' | 'premium'
export type StageName = 'script' | 'voice' | 'captions' | 'visuals' | 'assemble' | 'qc'

export const STAGE_ORDER: StageName[] = [
  'script',
  'voice',
  'captions',
  'visuals',
  'assemble',
  'qc',
]

export interface JobContext {
  jobId: string
  db: Database
  channel: ChannelConfig
  tier: Tier
  topic: string
  runDir: string
  artifactPath(stage: StageName, file: string): string
  log: Logger
}

export interface StageDef {
  name: StageName
  run(ctx: JobContext): Promise<void>
}
```

- [ ] **Step 4: Write `src/jobs/runner.ts`.** `createJob` inserts the job + 6 stage rows in one transaction; `runJob` builds the `JobContext`, resumes past `done` stages, records per-stage status, and gates the QC result into the library:

```ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { nanoid } from 'nanoid'
import pino from 'pino'
import type { ChannelConfig } from '../config/channel.js'
import { BudgetExceededError } from './costs.js'
import { STAGE_ORDER } from './types.js'
import type { JobContext, StageDef, StageName, Tier } from './types.js'

const nowIso = (): string => new Date().toISOString()

export interface JobResult {
  jobId: string
  status: 'ready' | 'needs-review' | 'failed' | 'blocked'
  videoPath?: string
}

export function createJob(
  db: Database,
  channel: ChannelConfig,
  opts: { topic: string; tier: Tier },
  _options: { runsRoot?: string } = {},
): string {
  const jobId = nanoid()
  const insertJob = db.prepare(
    'INSERT INTO jobs (id, channel, tier, topic, status) VALUES (?, ?, ?, ?, ?)',
  )
  const insertStage = db.prepare(
    'INSERT INTO job_stages (job_id, stage, status) VALUES (?, ?, ?)',
  )
  db.transaction(() => {
    insertJob.run(jobId, channel.name, opts.tier, opts.topic, 'queued')
    for (const stage of STAGE_ORDER) {
      insertStage.run(jobId, stage, 'pending')
    }
  })()
  return jobId
}

export async function runJob(
  db: Database,
  channel: ChannelConfig,
  jobId: string,
  stages: StageDef[],
  options: { runsRoot?: string } = {},
): Promise<JobResult> {
  const runsRoot = options.runsRoot ?? 'runs'
  const runDir = join(runsRoot, jobId)

  const jobRow = db
    .prepare('SELECT topic, tier FROM jobs WHERE id = ?')
    .get(jobId) as { topic: string; tier: Tier } | undefined
  if (!jobRow) {
    throw new Error(`job not found: ${jobId}`)
  }

  const log = pino({ level: process.env.LOG_LEVEL ?? 'silent' }).child({ jobId })

  const ctx: JobContext = {
    jobId,
    db,
    channel,
    tier: jobRow.tier,
    topic: jobRow.topic,
    runDir,
    artifactPath(stage: StageName, file: string): string {
      const dir = join(runDir, stage)
      mkdirSync(dir, { recursive: true })
      return join(dir, file)
    },
    log,
  }

  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', jobId)

  const stageStatus = db.prepare(
    'SELECT status FROM job_stages WHERE job_id = ? AND stage = ?',
  )
  const markStageRunning = db.prepare(
    'UPDATE job_stages SET status = ?, started_at = ? WHERE job_id = ? AND stage = ?',
  )
  const markStageDone = db.prepare(
    'UPDATE job_stages SET status = ?, finished_at = ? WHERE job_id = ? AND stage = ?',
  )
  const markStageFailed = db.prepare(
    'UPDATE job_stages SET status = ?, error = ?, finished_at = ? WHERE job_id = ? AND stage = ?',
  )

  for (const stage of stages) {
    const existing = stageStatus.get(jobId, stage.name) as { status: string } | undefined
    if (existing?.status === 'done') {
      continue
    }
    markStageRunning.run('running', nowIso(), jobId, stage.name)
    try {
      await stage.run(ctx)
      markStageDone.run('done', nowIso(), jobId, stage.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markStageFailed.run('failed', message, nowIso(), jobId, stage.name)
      // A budget breach is an enforcement outcome, not a crash: park the job
      // 'blocked' with the budget reason so operators can tell the two apart.
      const jobStatus = err instanceof BudgetExceededError ? 'blocked' : 'failed'
      db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(
        jobStatus,
        nowIso(),
        jobId,
      )
      return { jobId, status: jobStatus }
    }
  }

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
}
```

- [ ] **Step 5: Run the test expecting pass.** Command: `pnpm vitest run src/jobs/runner.test.ts`. Expected: `Tests  9 passed (9)`.

- [ ] **Step 6: Commit.** Command: `git add -A && git commit -m "feat: resumable job runner with stage status, qc gate, idempotent library upsert, and blocked-on-budget"`.
## Task Group B: Creative stages

> Consumes Task Group A verbatim: `loadChannelConfig`, `openDb`, `recordCost`, `assertBudget`, `BudgetExceededError`, `createJob`/`runJob` (with `{ runsRoot }` option), `JobContext` (with `artifactPath`), `StageDef`, `STAGE_ORDER`. Do not redefine these.
>
> Shared test helper (`src/stages/_testkit.ts`) is created once in Task 6 Step 8 and reused by Tasks 7 and 9. All TS imports use `.js` extensions (NodeNext ESM). Contract tests (`*.contract.test.ts`) are excluded from `pnpm test` and run only via `pnpm test:contract` — that config is established in Task Group A.

---

### Task 6: Anthropic provider + script stage

**Files:**
- Create: `src/providers/anthropic.ts`, `src/providers/anthropic.test.ts`, `src/providers/anthropic.contract.test.ts`, `src/stages/script.ts`, `src/stages/script.test.ts`, `src/stages/_testkit.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Consumes: `assertBudget(db, channel, jobId, upcomingUsdMicros)`, `recordCost(db, jobId, provider, operation, usdMicros)`, `BudgetExceededError` (`src/jobs/costs.ts`); `JobContext`, `StageDef` (`src/jobs/types.ts`); `ChannelConfig` (`src/config/channel.ts`); `openDb` (`src/db/index.ts`), `createJob` (`src/jobs/runner.ts`) — tests only.
- Produces: `structuredCompletion<T>(opts): Promise<{ data: T; cost: LlmUsageCost }>`, `LlmUsageCost`, `PRICE_TABLE` (`src/providers/anthropic.ts`); `ScriptOutputSchema`, `ScriptOutput` (= `z.infer<typeof ScriptOutputSchema>`, mirrors the contract's `ScriptOutput`), `createScriptStage(client?)`, `scriptStage`, `ESTIMATED_SCRIPT_COST_MICROS` (`src/stages/script.ts`). `ScriptOutput` is consumed by Tasks 7 & 9; `scriptStage` writes `script/script.json`.

**Steps:**

- [ ] **Step 1: Verify dependencies.** `@anthropic-ai/sdk` and `zod` are already pinned and installed by Task 1 — do NOT `pnpm add` (it would re-resolve against the registry and drift the lockfile). Verify with `pnpm list @anthropic-ai/sdk zod` (both listed). The emit tool's `input_schema` is generated with zod v4's native `z.toJSONSchema`, so `zod-to-json-schema` is NOT used. No commit needed.

- [ ] **Step 2: Write failing test for `structuredCompletion`.** Create `src/providers/anthropic.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCompletion } from './anthropic.js';

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

  it('throws when there is no emit tool_use block', async () => {
    const { client } = fakeClient({ content: [{ type: 'text', text: 'nope' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(structuredCompletion({ model: 'claude-sonnet-5', system: 's', prompt: 'p', schema, client })).rejects.toThrow(/no emit tool_use/);
  });
});
```

- [ ] **Step 3: Run the test, expect failure.** `pnpm vitest run src/providers/anthropic.test.ts` → fails to resolve `./anthropic.js` (module not found).

- [ ] **Step 4: Implement `src/providers/anthropic.ts`.**
```ts
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

function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_TABLE[model];
  if (!price) throw new Error(`structuredCompletion: no price table entry for model "${model}"`);
  return (
    Math.round((inputTokens * price.inputUsdMicrosPerMTok) / 1_000_000) +
    Math.round((outputTokens * price.outputUsdMicrosPerMTok) / 1_000_000)
  );
}

export async function structuredCompletion<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  client?: Anthropic; // injected in tests; defaults to a real client
}): Promise<{ data: T; cost: LlmUsageCost }> {
  const client = opts.client ?? new Anthropic();
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
    messages: [{ role: 'user', content: opts.prompt }],
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
  if (!toolUse) throw new Error('structuredCompletion: no emit tool_use block in response');

  const data = opts.schema.parse(toolUse.input); // throws ZodError on malformed input
  const cost: LlmUsageCost = { usdMicros: costMicros(opts.model, response.usage.input_tokens, response.usage.output_tokens) };
  return { data, cost };
}
```

- [ ] **Step 5: Run the test, expect pass.** `pnpm vitest run src/providers/anthropic.test.ts` → 3 passing. Commit: `feat: add anthropic structuredCompletion provider with forced emit tool`

- [ ] **Step 6: Write the contract test (real cheap call).** Create `src/providers/anthropic.contract.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { structuredCompletion } from './anthropic.js';

// Runs only via `pnpm test:contract` (excluded from default `pnpm test`).
// Makes ONE real, cheap Anthropic call; requires ANTHROPIC_API_KEY in env.
describe('structuredCompletion (contract)', () => {
  it('extracts structured data from a real haiku-class call', async () => {
    const schema = z.object({ capital: z.string() });
    const { data, cost } = await structuredCompletion({
      model: 'claude-haiku-4-5',
      system: 'You extract facts. Always return the answer by calling the emit tool.',
      prompt: 'What is the capital of France?',
      schema,
      maxTokens: 256,
    });
    expect(data.capital.toLowerCase()).toContain('paris');
    expect(cost.usdMicros).toBeGreaterThan(0);
  }, 30_000);
});
```

- [ ] **Step 7: Verify the contract test is excluded from default test run.** `pnpm test` → confirm `anthropic.contract.test.ts` is NOT executed (Task Group A's vitest config excludes `*.contract.test.ts`). Commit: `test: add anthropic contract test (haiku, behind test:contract)`

- [ ] **Step 8: Create the shared test helper.** Create `src/stages/_testkit.ts` (test-only; not shipped):
```ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { openDb } from '../db/index.js';
import { createJob } from '../jobs/runner.js';
import type { JobContext } from '../jobs/types.js';
import type { ChannelConfig } from '../config/channel.js';

export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: 'test',
    niche: ['space facts', 'astronomy'],
    tierMix: { volume: 2, premium: 1 },
    voice: { volume: 'af_heart' },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    ...overrides,
  };
}

export function makeCtx(channel: ChannelConfig = testChannel(), topic = 'Why the Moon is drifting away'): JobContext {
  const db = openDb(':memory:');
  const jobId = createJob(db, channel, { topic, tier: 'volume' });
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-test-'));
  return {
    jobId,
    db,
    channel,
    tier: 'volume',
    topic,
    runDir,
    artifactPath(stage, file) {
      const dir = path.join(runDir, stage);
      mkdirSync(dir, { recursive: true });
      return path.join(dir, file);
    },
    log: pino({ level: 'silent' }),
  };
}
```
Commit: `test: add shared JobContext test helper`

- [ ] **Step 9: Write failing test for the script stage.** Create `src/stages/script.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { BudgetExceededError } from '../jobs/costs.js';
import { createScriptStage, ESTIMATED_SCRIPT_COST_MICROS } from './script.js';
import { makeCtx, testChannel } from './_testkit.js';

const VALID_SCRIPT = {
  hook: 'The Moon is slowly leaving us',
  segments: [
    { text: 'Every year the Moon drifts about 3.8 centimeters farther from Earth.', visualDirection: 'moon over dark ocean' },
    { text: 'Tidal forces steal energy from Earth and hand it to the Moon.', visualDirection: 'animated tidal bulge diagram' },
    { text: 'In the deep future, total solar eclipses will vanish forever.', visualDirection: 'solar eclipse timelapse' },
    { text: 'But do not worry, that is billions of years away.', visualDirection: 'calm starfield' },
  ],
  platformMeta: {
    youtube: { title: 'The Moon Is Drifting Away From Earth', description: 'The Moon moves 3.8cm farther each year. Here is why.', hashtags: ['#space', '#astronomy', '#moon'] },
    tiktok: { title: 'The Moon is leaving us', description: 'A tiny drift with a huge future consequence.', hashtags: ['#space', '#moon'] },
    instagram: { title: 'Why the Moon drifts away', description: 'Tidal forces are slowly pushing the Moon out.', hashtags: ['#space', '#astronomy'] },
  },
};

function fakeClient(response: unknown): { client: Anthropic; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('scriptStage', () => {
  it('writes script.json, records cost, and forces the emit tool with the script schema', async () => {
    const ctx = makeCtx(testChannel());
    const { client, create } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: VALID_SCRIPT }],
      usage: { input_tokens: 500, output_tokens: 800 },
    });
    await createScriptStage(client).run(ctx);

    const written = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'));
    expect(written).toEqual(VALID_SCRIPT);

    const rows = ctx.db.prepare('SELECT provider, operation, usd_micros FROM costs WHERE job_id = ?').all(ctx.jobId);
    expect(rows).toEqual([{ provider: 'anthropic', operation: 'script', usd_micros: 500 * 3 + 800 * 15 }]);

    // The emit tool's input_schema is the ScriptOutputSchema rendered to JSON Schema
    // by z.toJSONSchema — an object requiring hook, segments, and platformMeta.
    const sentArgs = create.mock.calls[0][0];
    expect(sentArgs.tool_choice).toEqual({ type: 'tool', name: 'emit' });
    const sentTool = sentArgs.tools[0];
    expect(sentTool.name).toBe('emit');
    expect(sentTool.input_schema.type).toBe('object');
    expect(sentTool.input_schema.required).toEqual(
      expect.arrayContaining(['hook', 'segments', 'platformMeta']),
    );
  });

  it('throws a zod error when the tool input is malformed', async () => {
    const ctx = makeCtx(testChannel());
    const { client } = fakeClient({
      content: [{ type: 'tool_use', name: 'emit', id: 't1', input: { hook: 'x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(createScriptStage(client).run(ctx)).rejects.toThrow();
  });

  it('throws BudgetExceededError before calling the API when over budget', async () => {
    const ctx = makeCtx(testChannel({ budget: { perVideoUsdMicros: 1, perDayUsdMicros: 1 } }));
    const { client, create } = fakeClient({});
    await expect(createScriptStage(client).run(ctx)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
    expect(ESTIMATED_SCRIPT_COST_MICROS).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 10: Run the test, expect failure.** `pnpm vitest run src/stages/script.test.ts` → fails to resolve `./script.js`.

- [ ] **Step 11: Implement `src/stages/script.ts`.**
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
      assertBudget(ctx.db, ctx.channel, ctx.jobId, ESTIMATED_SCRIPT_COST_MICROS);
      const { data, cost } = await structuredCompletion({
        model: ctx.channel.scriptModel,
        system: buildSystem(ctx.channel.niche),
        prompt: buildPrompt(ctx.topic, ctx.channel.niche),
        schema: ScriptOutputSchema,
        client,
      });
      recordCost(ctx.db, ctx.jobId, 'anthropic', 'script', cost.usdMicros);
      await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(data, null, 2));
    },
  };
}

export const scriptStage = createScriptStage();
```

- [ ] **Step 12: Run the test, expect pass.** `pnpm vitest run src/stages/script.test.ts` → 3 passing. Commit: `feat: add script stage (topic -> validated script.json + cost ledger)`

---

### Task 7: Voice stage

**Files:**
- Create: `src/stages/voice.ts`, `src/stages/voice.test.ts`
- Modify: `package.json` (add `kokoro-js`, `msedge-tts`)

**Interfaces:**
- Consumes: `ScriptOutput` (`src/stages/script.ts`); `JobContext`, `StageDef` (`src/jobs/types.ts`); `makeCtx`/`testChannel` (`src/stages/_testkit.ts`) — tests; `kokoro-js` (`KokoroTTS.from_pretrained`, `tts.generate`, `audio.save`); `msedge-tts` (`MsEdgeTTS`, `setMetadata`, `toStream`).
- Produces: `voiceStage`, `VoiceMeta` (`{ provider: 'kokoro' | 'edge-tts'; voiceId: string; durationMs: number }`), `parseWavDurationMs(buffer)` (`src/stages/voice.ts`); artifacts `voice/narration.wav` + `voice/voice.json`. `narration.wav` consumed by captions (Task 9) & assemble; `voice.json` consumed by assemble.

**Steps:**

- [ ] **Step 1: Verify dependencies.** `kokoro-js` and `msedge-tts` are already pinned and installed by Task 1 — do NOT `pnpm add`. Verify with `pnpm list kokoro-js msedge-tts` (both listed). No commit needed.

- [ ] **Step 2: Write failing test for `parseWavDurationMs` and the voice stage.** Create `src/stages/voice.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: vi.fn() } }));
vi.mock('msedge-tts', () => ({ MsEdgeTTS: vi.fn(), OUTPUT_FORMAT: {} }));

import { KokoroTTS } from 'kokoro-js';
import { MsEdgeTTS } from 'msedge-tts';
import { voiceStage, parseWavDurationMs } from './voice.js';
import { makeCtx } from './_testkit.js';
import type { JobContext } from '../jobs/types.js';

// Canonical mono 16-bit PCM WAV. byteRate = rate*channels*2.
function buildWav(numSamples: number, sampleRate = 16000): Buffer {
  const bytesPerSample = 2;
  const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const ONE_SECOND_WAV = buildWav(16000); // 32000 data bytes / 32000 byteRate -> 1000 ms

const SCRIPT = {
  hook: 'Hook here',
  segments: [
    { text: 'One.', visualDirection: 'a' },
    { text: 'Two.', visualDirection: 'b' },
  ],
  platformMeta: {
    youtube: { title: 't', description: 'd', hashtags: [] },
    tiktok: { title: 't', description: 'd', hashtags: [] },
    instagram: { title: 't', description: 'd', hashtags: [] },
  },
};

async function ctxWithScript(): Promise<JobContext> {
  const ctx = makeCtx();
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(SCRIPT));
  return ctx;
}

beforeEach(() => vi.clearAllMocks());

describe('parseWavDurationMs', () => {
  it('computes duration from data size / byteRate', () => {
    expect(parseWavDurationMs(buildWav(16000))).toBe(1000);
    expect(parseWavDurationMs(buildWav(8000))).toBe(500);
  });
  it('rejects non-RIFF buffers', () => {
    expect(() => parseWavDurationMs(Buffer.from('not a wav file at all'))).toThrow(/RIFF/);
  });
});

describe('voiceStage', () => {
  it('uses kokoro on the happy path and writes wav + meta', async () => {
    const ctx = await ctxWithScript();
    const save = vi.fn(async (p: string) => { await fs.writeFile(p, ONE_SECOND_WAV); });
    const generate = vi.fn().mockResolvedValue({ save });
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(generate).toHaveBeenCalledWith('Hook here\n\nOne.\n\nTwo.', { voice: 'af_heart' });
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 });
  });

  it('falls back to edge-tts when kokoro throws', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'));
    const setMetadata = vi.fn().mockResolvedValue(undefined);
    const toStream = vi.fn().mockReturnValue({ audioStream: Readable.from([ONE_SECOND_WAV]) });
    vi.mocked(MsEdgeTTS).mockImplementation(() => ({ setMetadata, toStream }) as never);

    await voiceStage.run(ctx);

    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta).toEqual({ provider: 'edge-tts', voiceId: 'en-US-AriaNeural', durationMs: 1000 });
  });

  it('throws when both kokoro and edge-tts fail', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(KokoroTTS.from_pretrained).mockRejectedValue(new Error('no model'));
    vi.mocked(MsEdgeTTS).mockImplementation(() => ({
      setMetadata: vi.fn().mockResolvedValue(undefined),
      toStream: vi.fn(() => { throw new Error('edge down'); }),
    }) as never);

    await expect(voiceStage.run(ctx)).rejects.toThrow(/voice synthesis failed/);
  });
});
```

- [ ] **Step 3: Run the test, expect failure.** `pnpm vitest run src/stages/voice.test.ts` → fails to resolve `./voice.js`.

- [ ] **Step 4: Implement `src/stages/voice.ts`.** (First kokoro use downloads the ~82M ONNX model to the Hugging Face cache — a one-time cost on the real path; tests mock it.)
```ts
import { promises as fs } from 'node:fs';
import { KokoroTTS } from 'kokoro-js';
import { MsEdgeTTS, type OUTPUT_FORMAT } from 'msedge-tts';
import type { StageDef, JobContext } from '../jobs/types.js';
import type { ScriptOutput } from './script.js';

export interface VoiceMeta {
  provider: 'kokoro' | 'edge-tts';
  voiceId: string;
  durationMs: number;
}

const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const EDGE_VOICE = 'en-US-AriaNeural';
// The Edge TTS backend supports "riff-24khz-16bit-mono-pcm" (a RIFF/WAV PCM
// container), but msedge-tts ships that OUTPUT_FORMAT member commented out, so
// only MP3/Opus constants exist. We pass the literal, protocol-valid format
// string; the cast only satisfies the enum-typed parameter.
const EDGE_FORMAT = 'riff-24khz-16bit-mono-pcm' as unknown as OUTPUT_FORMAT;

// Duration from a RIFF/WAVE header: data-chunk size / fmt byteRate.
export function parseWavDurationMs(buf: Buffer): number {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('parseWavDurationMs: not a RIFF/WAVE buffer');
  }
  let byteRate = 0;
  let dataSize = 0;
  let dataFound = false;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      byteRate = buf.readUInt32LE(body + 8); // fmt: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
    } else if (chunkId === 'data') {
      // Streaming WAVs (edge-tts) may declare a placeholder size larger than the
      // actual payload; clamp to the bytes we really have.
      dataSize = Math.min(chunkSize, buf.length - body);
      dataFound = true;
      break;
    }
    offset = body + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (byteRate <= 0 || !dataFound) throw new Error('parseWavDurationMs: missing fmt or data chunk');
  return Math.floor((dataSize / byteRate) * 1000);
}

function narrationFromScript(script: ScriptOutput): string {
  return [script.hook, ...script.segments.map((s) => s.text)].join('\n\n');
}

async function synthKokoro(text: string, voiceId: string, wavPath: string): Promise<void> {
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' });
  const audio = await tts.generate(text, { voice: voiceId });
  await audio.save(wavPath);
}

async function synthEdge(text: string, wavPath: string): Promise<void> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, EDGE_FORMAT);
  // toStream is synchronous in current msedge-tts; awaiting a plain object is a
  // no-op, so this is robust across versions that return a promise.
  const { audioStream } = await tts.toStream(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  await fs.writeFile(wavPath, Buffer.concat(chunks));
}

export const voiceStage: StageDef = {
  name: 'voice',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptOutput;
    const narration = narrationFromScript(script);
    const wavPath = ctx.artifactPath('voice', 'narration.wav');

    let provider: VoiceMeta['provider'];
    let voiceId: string;
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

    const durationMs = parseWavDurationMs(await fs.readFile(wavPath));
    const meta: VoiceMeta = { provider, voiceId, durationMs };
    await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2));
  },
};
```

- [ ] **Step 5: Run the test, expect pass.** `pnpm vitest run src/stages/voice.test.ts` → 5 passing (2 `parseWavDurationMs` + 3 `voiceStage`). Commit: `feat: add voice stage (kokoro -> edge-tts fallback, wav header duration)`

---

### Task 8: WhisperX sidecar + TS client

**Files:**
- Create: `sidecar/whisperx/app.py`, `sidecar/whisperx/test_app.py`, `sidecar/whisperx/requirements.txt`, `sidecar/whisperx/Dockerfile`, `docker-compose.yml` (repo root), `src/providers/whisperx.ts`, `src/providers/whisperx.test.ts`

**Interfaces:**
- Consumes: `whisperx` (`load_align_model`, `load_audio`, `align`) — sidecar; Node global `fetch`/`FormData`/`Blob` — TS client.
- Produces: sidecar `POST /align` (multipart `audio` wav + `transcript` text -> `{"words":[{word,start,end}]}` seconds float); `alignTranscript(opts): Promise<WordTiming[]>`, `WordTiming` (`{ word: string; startMs: number; endMs: number }`) in `src/providers/whisperx.ts`. `alignTranscript`/`WordTiming` consumed by captions (Task 9).

**Steps:**

- [ ] **Step 1: Write failing test for the sidecar `/align` endpoint.** Create `sidecar/whisperx/test_app.py`:
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
```

- [ ] **Step 2: Write `requirements.txt`, then run the test, expect failure.** Create `sidecar/whisperx/requirements.txt`:
```
fastapi==0.115.6
uvicorn[standard]==0.34.0
whisperx==3.3.1
python-multipart==0.0.20
```
Install (`cd sidecar/whisperx && pip install -r requirements.txt && pip install pytest`), then `pytest -q` → fails with `ModuleNotFoundError: No module named 'app'`.

- [ ] **Step 3: Implement `sidecar/whisperx/app.py`.** (Verified against the whisperX README: `load_align_model(language_code=, device=) -> (model, metadata)`; `align(segments, model, metadata, audio, device, return_char_alignments=False)`; `load_audio(path)`; result carries a flat `word_segments` list of `{word,start,end,score}`.)
```python
import os
import tempfile

import whisperx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

app = FastAPI()

DEVICE = os.environ.get("WHISPERX_DEVICE", "cpu")
SAMPLE_RATE = 16000  # whisperx.load_audio always resamples to 16 kHz

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
    data = await audio.read()
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        tmp.write(data)
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

- [ ] **Step 4: Run the test, expect pass.** `cd sidecar/whisperx && pytest -q` → 2 passing. Commit: `feat: add whisperx alignment sidecar (POST /align) + tests`

- [ ] **Step 5: Add the `Dockerfile` and `docker-compose.yml`.** Create `sidecar/whisperx/Dockerfile`:
```dockerfile
FROM python:3.11-slim

# ffmpeg is required by whisperx.load_audio; git for pip VCS deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch wheel (keeps the image small; no CUDA).
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV WHISPERX_DEVICE=cpu
EXPOSE 8585
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8585"]
```
Create `docker-compose.yml` (repo root):
```yaml
services:
  whisperx:
    build: ./sidecar/whisperx
    ports:
      - "8585:8585"
    environment:
      WHISPERX_DEVICE: cpu
    volumes:
      - whisperx-cache:/root/.cache   # persist downloaded alignment models

volumes:
  whisperx-cache:
```
Verify it builds: `docker compose build whisperx` (or `docker compose config` if a build is impractical in this environment). Commit: `chore: containerize whisperx sidecar (Dockerfile + docker-compose)`

- [ ] **Step 6: Write failing test for the TS client `alignTranscript`.** Create `src/providers/whisperx.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alignTranscript } from './whisperx.js';

let server: http.Server;
let baseUrl: string;
let lastBody: string;
let responder: () => { status: number; body: string };

beforeEach(async () => {
  responder = () => ({ status: 200, body: JSON.stringify({ words: [{ word: 'hi', start: 0.12, end: 0.34 }] }) });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      const r = responder();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function tmpWav(): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-wx-'));
  const p = path.join(dir, 'narration.wav');
  await writeFile(p, Buffer.from('RIFFxxxxWAVEdummy'));
  return p;
}

describe('alignTranscript', () => {
  it('posts multipart audio + transcript and converts seconds to integer ms', async () => {
    const wavPath = await tmpWav();
    const words = await alignTranscript({ baseUrl, wavPath, transcript: 'hi there' });
    expect(lastBody).toContain('name="transcript"');
    expect(lastBody).toContain('hi there');
    expect(lastBody).toContain('name="audio"');
    expect(lastBody).toContain('filename="narration.wav"');
    expect(words).toEqual([{ word: 'hi', startMs: 120, endMs: 340 }]);
  });

  it('throws on a non-2xx response', async () => {
    const wavPath = await tmpWav();
    responder = () => ({ status: 500, body: JSON.stringify({ detail: 'boom' }) });
    await expect(alignTranscript({ baseUrl, wavPath, transcript: 'x' })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 7: Run the test, expect failure.** `pnpm vitest run src/providers/whisperx.test.ts` → fails to resolve `./whisperx.js`.

- [ ] **Step 8: Implement `src/providers/whisperx.ts`.**
```ts
import { readFile } from 'node:fs/promises';

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export async function alignTranscript(opts: {
  baseUrl: string;
  wavPath: string;
  transcript: string;
}): Promise<WordTiming[]> {
  const bytes = await readFile(opts.wavPath);
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'narration.wav');
  form.append('transcript', opts.transcript);

  const res = await fetch(`${opts.baseUrl}/align`, { method: 'POST', body: form });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`alignTranscript: whisperx responded ${res.status}: ${raw}`);
  }

  const body = (await res.json()) as { words: { word: string; start: number; end: number }[] };
  return body.words.map((w) => ({
    word: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
```

- [ ] **Step 9: Run the test, expect pass.** `pnpm vitest run src/providers/whisperx.test.ts` → 2 passing. Commit: `feat: add whisperx TS client (alignTranscript, seconds -> integer ms)`

---

### Task 9: Captions stage

**Files:**
- Create: `src/stages/narration-text.ts`, `src/stages/captions.ts`, `src/stages/captions.test.ts`
- Modify: `src/stages/voice.ts` (refactor to import the shared `narrationText`)

**Interfaces:**
- Consumes: `ScriptOutput` (`src/stages/script.ts`); `alignTranscript`, `WordTiming` (`src/providers/whisperx.ts`); `JobContext`, `StageDef` (`src/jobs/types.ts`); `makeCtx` (`src/stages/_testkit.ts`) — tests.
- Produces: `narrationText(script: ScriptOutput): string` (`src/stages/narration-text.ts`, shared by voice + captions); `captionsStage`, `CaptionsArtifact` (`{ words: WordTiming[] }`) (`src/stages/captions.ts`); artifact `captions/words.json` consumed by assemble.
- Plan 1: captions always come from WhisperX. Plan 2 adds a dual mode that prefers provider-supplied word timings (ElevenLabs) when present — noted in `captions.ts`.

**Steps:**

- [ ] **Step 1: Create the shared `narrationText` helper.** Create `src/stages/narration-text.ts`:
```ts
import type { ScriptOutput } from './script.js';

/**
 * Narration text fed to TTS and to caption alignment: the hook followed by each
 * segment's spoken text, joined with blank lines. Shared by the voice and
 * captions stages so both produce byte-identical transcripts.
 */
export function narrationText(script: ScriptOutput): string {
  return [script.hook, ...script.segments.map((s) => s.text)].join('\n\n');
}
```
Commit: `refactor: extract shared narrationText helper`

- [ ] **Step 2: Refactor `voice.ts` to import `narrationText`.** In `src/stages/voice.ts`: (a) add `import { narrationText } from './narration-text.js';` alongside the other imports; (b) delete the local `function narrationFromScript(script: ScriptOutput): string { ... }` block; (c) change `const narration = narrationFromScript(script);` to `const narration = narrationText(script);`. The `import type { ScriptOutput }` line stays (still used for the `JSON.parse(...) as ScriptOutput` cast).

- [ ] **Step 3: Run the voice tests, expect pass (refactor is behavior-preserving).** `pnpm vitest run src/stages/voice.test.ts` → still 5 passing. Commit: `refactor: voice stage uses shared narrationText helper`

- [ ] **Step 4: Write failing test for the captions stage.** Create `src/stages/captions.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';

vi.mock('../providers/whisperx.js', () => ({ alignTranscript: vi.fn() }));

import { alignTranscript } from '../providers/whisperx.js';
import { captionsStage } from './captions.js';
import { makeCtx } from './_testkit.js';
import type { JobContext } from '../jobs/types.js';

const SCRIPT = {
  hook: 'Hook here',
  segments: [
    { text: 'One.', visualDirection: 'a' },
    { text: 'Two.', visualDirection: 'b' },
  ],
  platformMeta: {
    youtube: { title: 't', description: 'd', hashtags: [] },
    tiktok: { title: 't', description: 'd', hashtags: [] },
    instagram: { title: 't', description: 'd', hashtags: [] },
  },
};

async function ctxWithScript(): Promise<JobContext> {
  const ctx = makeCtx();
  await fs.writeFile(ctx.artifactPath('script', 'script.json'), JSON.stringify(SCRIPT));
  return ctx;
}

beforeEach(() => vi.clearAllMocks());

describe('captionsStage', () => {
  it('writes words.json with integer-ms timings from the aligner', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(alignTranscript).mockResolvedValue([
      { word: 'hello', startMs: 120, endMs: 340 },
      { word: 'world', startMs: 350, endMs: 600 },
    ]);

    await captionsStage.run(ctx);

    const artifact = JSON.parse(await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'));
    expect(artifact).toEqual({
      words: [
        { word: 'hello', startMs: 120, endMs: 340 },
        { word: 'world', startMs: 350, endMs: 600 },
      ],
    });
    for (const w of artifact.words) {
      expect(Number.isInteger(w.startMs)).toBe(true);
      expect(Number.isInteger(w.endMs)).toBe(true);
    }
    expect(vi.mocked(alignTranscript)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'Hook here\n\nOne.\n\nTwo.' }),
    );
  });

  it('throws when the aligner returns no words', async () => {
    const ctx = await ctxWithScript();
    vi.mocked(alignTranscript).mockResolvedValue([]);
    await expect(captionsStage.run(ctx)).rejects.toThrow(/no word timings/);
  });
});
```

- [ ] **Step 5: Run the test, expect failure.** `pnpm vitest run src/stages/captions.test.ts` → fails to resolve `./captions.js`.

- [ ] **Step 6: Implement `src/stages/captions.ts`.**
```ts
import { promises as fs } from 'node:fs';
import type { StageDef, JobContext } from '../jobs/types.js';
import type { ScriptOutput } from './script.js';
import { narrationText } from './narration-text.js';
import { alignTranscript, type WordTiming } from '../providers/whisperx.js';

export interface CaptionsArtifact {
  words: WordTiming[];
}

// Plan 1: captions always come from the WhisperX sidecar. Plan 2 adds a dual
// mode that prefers provider-supplied word timings (ElevenLabs) when present.
export const captionsStage: StageDef = {
  name: 'captions',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptOutput;
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

- [ ] **Step 7: Run the test, expect pass.** `pnpm vitest run src/stages/captions.test.ts` → 2 passing. Commit: `feat: add captions stage (whisperx alignment -> words.json)`

- [ ] **Step 8: Run the full Task Group B suite.** `pnpm vitest run src/providers src/stages` → all green (anthropic, script, voice, whisperx client, captions). Confirm `pnpm test` still excludes `anthropic.contract.test.ts`. Commit (if any incidental fixups): `test: verify task group B stages pass together`
## Task Group C: Media pipeline & end-to-end

> Consumes Group A (`loadChannelConfig`, `openDb`, `createJob`, `runJob(db, channel, jobId, stages, opts?)`, `JobContext`, `StageDef`, `STAGE_ORDER`) and Group B (`scriptStage`, `voiceStage`, `captionsStage`, and the artifacts `script/script.json`, `voice/narration.wav`, `voice/voice.json`, `captions/words.json`). All relative imports inside `src/` use explicit `.js` extensions (ESM/NodeNext). `remotion/*.tsx` relative imports are extensionless (webpack/esbuild resolve them at bundle time, and `remotion/tsconfig.json` — added in Task 12 — type-checks them under `moduleResolution: Bundler`, kept out of the root NodeNext build). Cross-boundary type-only imports from `src/` into `remotion/` (and vice versa) use `import type` so nothing node-only is dragged into the browser bundle and nothing browser-only is dragged into the CLI.
>
> **Remotion SSR asset rule (verified against remotion.dev, v4):** absolute file paths and `file://` URLs are **not** supported in `<OffthreadVideo>`/`<Audio>`/`<Img>`. The documented mechanism for dynamic local files during a Node render is: **copy the file into the `public` folder that lives inside the bundle output (`path.join(serveUrl, 'public', …)`) after `bundle()`, then reference it with `staticFile()`** ("if you use the server-side rendering APIs, you can add assets to the `public` folder that is inside the bundle after the fact" — remotion.dev/docs/assets; "Preferrably, copy files into the `public` folder and `staticFile()`" — remotion.dev/docs/miscellaneous/absolute-paths). This is why `ShortVideoProps.audioSrc`/`backgroundSrc`/`bgmSrc` carry **public-relative path strings** (e.g. `"<jobId>/background.mp4"`) and the composition resolves them with `staticFile(...)`; the assemble stage performs the copy-into-bundle step.

---

### Task 10: ffmpeg helpers

**Files:**
- Create `src/media/ffmpeg.ts`
- Test `src/media/ffmpeg.test.ts`

**Interfaces:**
- Consumes: system `ffmpeg`/`ffprobe` binaries (via `execa`).
- Produces: `interface MediaProbe { durationMs: number; width: number; height: number; hasAudio: boolean; fps: number }`, `async function probe(file: string): Promise<MediaProbe>`, `async function cropToVertical(input: string, output: string): Promise<void>`, `async function loopToDuration(input: string, output: string, durationMs: number): Promise<void>` (exact contract signatures).

> Prerequisite note: `ffmpeg` and `ffprobe` must be on `PATH` (`brew install ffmpeg`). `execa` is already a dependency (Group A/B). No network.

- [ ] **Step 1: Write the failing test.** Create `src/media/ffmpeg.test.ts`:
  ```ts
  import { afterAll, beforeAll, describe, expect, it } from 'vitest'
  import { execa } from 'execa'
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import { cropToVertical, loopToDuration, probe } from './ffmpeg.js'

  let dir: string
  let fixture: string

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'brainrot-ffmpeg-'))
    fixture = path.join(dir, 'fixture.mp4')
    // 2s 640x360 testsrc2 video + 440Hz sine audio, H.264 + AAC.
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      fixture, '-y',
    ])
  }, 60000)

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('probe', () => {
    it('reports duration, dimensions, audio presence, and fps', async () => {
      const p = await probe(fixture)
      expect(p.width).toBe(640)
      expect(p.height).toBe(360)
      expect(p.hasAudio).toBe(true)
      expect(p.fps).toBe(30)
      expect(Number.isInteger(p.durationMs)).toBe(true)
      expect(p.durationMs).toBeGreaterThanOrEqual(1900)
      expect(p.durationMs).toBeLessThanOrEqual(2100)
    })
  })

  describe('cropToVertical', () => {
    it('produces a 1080x1920 clip', async () => {
      const out = path.join(dir, 'cropped.mp4')
      await cropToVertical(fixture, out)
      const p = await probe(out)
      expect(p.width).toBe(1080)
      expect(p.height).toBe(1920)
    })
  })

  describe('loopToDuration', () => {
    it('loops the source to at least the requested duration', async () => {
      const out = path.join(dir, 'looped.mp4')
      await loopToDuration(fixture, out, 5000)
      const p = await probe(out)
      expect(p.durationMs).toBeGreaterThan(2000) // longer than the 2s source
      expect(p.durationMs).toBeGreaterThanOrEqual(4900) // reached ~5s target (ffmpeg -t trims to <= requested; one-frame tolerance)
    })
  })
  ```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/media/ffmpeg.test.ts` — fails at import resolution: `Failed to resolve import "./ffmpeg.js"` / `Cannot find module './ffmpeg.js'` because `src/media/ffmpeg.ts` does not exist yet.

- [ ] **Step 3: Implement.** Create `src/media/ffmpeg.ts`:
  ```ts
  import { execa } from 'execa'

  export interface MediaProbe {
    durationMs: number
    width: number
    height: number
    hasAudio: boolean
    fps: number
  }

  interface FfprobeStream {
    codec_type: string
    width?: number
    height?: number
    r_frame_rate?: string
  }
  interface FfprobeJson {
    streams: FfprobeStream[]
    format: { duration?: string }
  }

  export async function probe(file: string): Promise<MediaProbe> {
    const { stdout } = await execa('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      file,
    ])
    const data = JSON.parse(stdout) as FfprobeJson
    const video = data.streams.find((s) => s.codec_type === 'video')
    if (!video) throw new Error(`probe: no video stream in ${file}`)
    const hasAudio = data.streams.some((s) => s.codec_type === 'audio')
    const durationSec = parseFloat(data.format.duration ?? '0')
    const [num, den] = (video.r_frame_rate ?? '0/1').split('/').map(Number)
    const fps = den ? num / den : 0
    return {
      durationMs: Math.round(durationSec * 1000),
      width: video.width ?? 0,
      height: video.height ?? 0,
      hasAudio,
      fps,
    }
  }

  export async function cropToVertical(input: string, output: string): Promise<void> {
    await execa('ffmpeg', [
      '-i', input,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
      '-c:a', 'copy',
      '-y',
      output,
    ])
  }

  export async function loopToDuration(input: string, output: string, durationMs: number): Promise<void> {
    const seconds = (durationMs / 1000).toFixed(3)
    await execa('ffmpeg', [
      '-stream_loop', '-1',
      '-i', input,
      '-t', seconds,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-y',
      output,
    ])
  }
  ```

- [ ] **Step 4: Run, expect pass.** `pnpm vitest run src/media/ffmpeg.test.ts` — all three describe blocks pass.

- [ ] **Step 5: Commit.** `git add src/media/ffmpeg.ts src/media/ffmpeg.test.ts && git commit -m "feat: add ffmpeg probe/crop/loop media helpers"`

---

### Task 11: Visuals stage (volume tier)

**Files:**
- Create `src/stages/visuals-volume.ts`
- Test `src/stages/visuals-volume.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `StageDef` (from `src/jobs/types.js`); `probe`, `cropToVertical`, `loopToDuration` (from `src/media/ffmpeg.js`); artifact `voice/voice.json` (reads `.durationMs`); `bg_usage` table; `ctx.channel.bgDir`, `ctx.channel.name`.
- Produces: `export const visualsVolumeStage: StageDef` (`name: 'visuals'`), artifact `visuals/background.mp4` (1080×1920, duration ≥ narration `durationMs`), and one inserted `bg_usage` row.

- [ ] **Step 1: Write the failing test.** Create `src/stages/visuals-volume.test.ts`:
  ```ts
  import { afterAll, beforeEach, describe, expect, it } from 'vitest'
  import { execa } from 'execa'
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import pino from 'pino'
  import { openDb } from '../db/index.js'
  import { probe } from '../media/ffmpeg.js'
  import { visualsVolumeStage } from './visuals-volume.js'
  import type { ChannelConfig } from '../config/channel.js'
  import type { JobContext } from '../jobs/types.js'

  const cleanup: string[] = []

  function tmp(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }

  async function makeClip(file: string): Promise<void> {
    // 2s 640x360 testsrc2 + sine (same command as Task 10 fixture) — forces the crop path.
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      file, '-y',
    ])
  }

  function makeChannel(bgDir: string): ChannelConfig {
    return {
      name: 'testchan',
      niche: ['space'],
      tierMix: { volume: 2, premium: 1 },
      voice: { volume: 'af_heart' },
      captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
      bgDir,
      bgmDir: tmp('brainrot-bgm-'),
      budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
      scriptModel: 'claude-sonnet-5',
    }
  }

  function makeCtx(runDir: string, channel: ChannelConfig): JobContext {
    return {
      jobId: 'job-visuals',
      db: openDb(':memory:'),
      channel,
      tier: 'volume',
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

  function seedVoice(ctx: JobContext, durationMs: number): void {
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs }),
    )
  }

  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  describe('visualsVolumeStage', () => {
    it('crops+loops a chosen clip to background.mp4 and records bg_usage', async () => {
      const bgDir = tmp('brainrot-bg-')
      await makeClip(path.join(bgDir, 'clip1.mp4'))
      await makeClip(path.join(bgDir, 'clip2.mp4'))
      const channel = makeChannel(bgDir)
      const ctx = makeCtx(tmp('brainrot-run-'), channel)
      seedVoice(ctx, 2000)

      await visualsVolumeStage.run(ctx)

      const p = await probe(ctx.artifactPath('visuals', 'background.mp4'))
      expect(p.width).toBe(1080)
      expect(p.height).toBe(1920)
      expect(p.durationMs).toBeGreaterThanOrEqual(2000) // >= narration durationMs

      const rows = ctx.db
        .prepare('SELECT file FROM bg_usage WHERE channel = ?')
        .all('testchan') as { file: string }[]
      expect(rows.length).toBe(1)
      expect(['clip1.mp4', 'clip2.mp4']).toContain(rows[0].file)
    }, 60000)

    it('excludes recently used clips (chooses the unused one)', async () => {
      const bgDir = tmp('brainrot-bg-')
      await makeClip(path.join(bgDir, 'clip1.mp4'))
      await makeClip(path.join(bgDir, 'clip2.mp4'))
      const channel = makeChannel(bgDir)
      const ctx = makeCtx(tmp('brainrot-run-'), channel)
      seedVoice(ctx, 2000)
      ctx.db
        .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
        .run('testchan', 'clip1.mp4', new Date().toISOString())

      await visualsVolumeStage.run(ctx)

      const rows = ctx.db
        .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 1')
        .all('testchan') as { file: string }[]
      expect(rows[0].file).toBe('clip2.mp4') // clip1 excluded as recently used
    }, 60000)

    it('throws when bgDir has no mp4 clips', async () => {
      const channel = makeChannel(tmp('brainrot-bg-empty-'))
      const ctx = makeCtx(tmp('brainrot-run-'), channel)
      seedVoice(ctx, 2000)
      await expect(visualsVolumeStage.run(ctx)).rejects.toThrow(/no .mp4 background clips/)
    })
  })
  ```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/stages/visuals-volume.test.ts` — fails at import: `Cannot find module './visuals-volume.js'` (`src/stages/visuals-volume.ts` does not exist).

- [ ] **Step 3: Implement.** Create `src/stages/visuals-volume.ts`:
  ```ts
  import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import { cropToVertical, loopToDuration, probe } from '../media/ffmpeg.js'
  import type { JobContext, StageDef } from '../jobs/types.js'

  const PAD_MS = 500

  export const visualsVolumeStage: StageDef = {
    name: 'visuals',
    async run(ctx: JobContext): Promise<void> {
      const voice = JSON.parse(
        readFileSync(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
      ) as { durationMs: number }

      const bgDir = ctx.channel.bgDir
      let all: string[]
      try {
        all = readdirSync(bgDir).filter((f) => f.toLowerCase().endsWith('.mp4'))
      } catch {
        all = []
      }
      if (all.length === 0) {
        throw new Error(`visuals: no .mp4 background clips found in bgDir '${bgDir}'`)
      }

      const recent = (
        ctx.db
          .prepare('SELECT file FROM bg_usage WHERE channel = ? ORDER BY used_at DESC LIMIT 5')
          .all(ctx.channel.name) as { file: string }[]
      ).map((r) => r.file)
      const recentSet = new Set(recent)
      let candidates = all.filter((f) => !recentSet.has(f))
      if (candidates.length === 0) candidates = all // don't empty the pool

      const chosen = candidates[Math.floor(Math.random() * candidates.length)]
      const chosenPath = path.join(bgDir, chosen)

      const p = await probe(chosenPath)
      const tmp = mkdtempSync(path.join(tmpdir(), 'brainrot-visuals-'))
      let source = chosenPath
      if (!(p.width === 1080 && p.height === 1920)) {
        const cropped = path.join(tmp, 'cropped.mp4')
        await cropToVertical(chosenPath, cropped)
        source = cropped
      }

      const targetMs = voice.durationMs + PAD_MS
      const out = ctx.artifactPath('visuals', 'background.mp4')
      await loopToDuration(source, out, targetMs)

      ctx.db
        .prepare('INSERT INTO bg_usage (channel, file, used_at) VALUES (?, ?, ?)')
        .run(ctx.channel.name, chosen, new Date().toISOString())

      ctx.log.info({ chosen, targetMs, out }, 'visuals: background prepared')
    },
  }
  ```

- [ ] **Step 4: Run, expect pass.** `pnpm vitest run src/stages/visuals-volume.test.ts` — all three tests pass.

- [ ] **Step 5: Commit.** `git add src/stages/visuals-volume.ts src/stages/visuals-volume.test.ts && git commit -m "feat: add volume-tier visuals stage with recent-use-aware bg selection"`

---

### Task 12: Remotion project (ShortVideo composition)

**Files:**
- Create `src/remotion-types.ts`, `remotion/index.ts`, `remotion/Root.tsx`, `remotion/ShortVideo.tsx`, `remotion/Captions.tsx`, `remotion/public/.gitkeep`, `remotion/tsconfig.json`
- Modify `vitest.config.ts` (include the `remotion/` test glob), `package.json` (add deps; extend the `build` script to also typecheck `remotion/`)
- Test `remotion/remotion.test.ts`

**Interfaces:**
- Consumes (type-only): `WordTiming` (from `src/providers/whisperx.js`), `CaptionStyle` (from `src/config/channel.js`).
- Produces: `ShortVideoProps` in `src/remotion-types.ts` (exact contract fields; re-exported by `remotion/ShortVideo.tsx`), `export const ShortVideo`, composition id `"ShortVideo"` 1080×1920 @ 30fps whose `durationInFrames` is derived from `props.durationMs` via `calculateMetadata`.

> Note: `renderMedia` (Task 13) downloads a headless Chrome shell on first use; `selectComposition` here does not render frames, so it is fast enough for a 120s timeout. Composition `defaultProps` are required by Remotion when the component has required props; `calculateMetadata` overrides the placeholder `durationInFrames`.

- [ ] **Step 1: Verify dependencies.** `remotion`, `@remotion/bundler`, `@remotion/renderer`, `react`, `react-dom`, `@types/react`, and `@types/react-dom` are already pinned and installed by Task 1 — do NOT `pnpm add` (a bare `@4` re-resolve could rewrite the exact ranges Task 1 pinned). Verify with `pnpm list remotion @remotion/bundler @remotion/renderer react` (all listed; the `remotion.test.ts` file below imports `@remotion/bundler`/`@remotion/renderer`, so the packages must exist before the test can even load).

- [ ] **Step 2: Write the failing test.** Create `remotion/remotion.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { bundle } from '@remotion/bundler'
  import { selectComposition } from '@remotion/renderer'
  import path from 'node:path'
  import type { ShortVideoProps } from './ShortVideo'

  describe('ShortVideo composition', () => {
    it('bundles and resolves to 1080x1920 with duration derived from props', async () => {
      const serveUrl = await bundle({ entryPoint: path.resolve('remotion/index.ts') })
      const sampleProps: ShortVideoProps = {
        audioSrc: 'sample/narration.wav',
        backgroundSrc: 'sample/background.mp4',
        words: [{ word: 'hello', startMs: 0, endMs: 500 }],
        style: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
        durationMs: 4000,
      }
      const comp = await selectComposition({ serveUrl, id: 'ShortVideo', inputProps: sampleProps })
      expect(comp.width).toBe(1080)
      expect(comp.height).toBe(1920)
      expect(comp.fps).toBe(30)
      expect(comp.durationInFrames).toBe(Math.ceil((4000 / 1000) * 30)) // 120
    }, 120000)
  })
  ```

- [ ] **Step 3: Run, expect failure.** First replace `vitest.config.ts` in full so the runner discovers the `remotion/` test glob while preserving the `CONTRACT` ternary (only the non-contract `include` changes vs Task 1):
  ```ts
  import { defineConfig } from 'vitest/config'

  const contract = process.env.CONTRACT === '1'

  export default defineConfig({
    test: {
      testTimeout: 30000,
      include: contract ? ['src/**/*.contract.test.ts'] : ['src/**/*.test.ts', 'remotion/**/*.test.ts'],
      exclude: contract
        ? ['**/node_modules/**', '**/dist/**']
        : ['**/node_modules/**', '**/dist/**', 'src/**/*.contract.test.ts'],
    },
  })
  ```
  Then `pnpm vitest run remotion/remotion.test.ts` — fails: `bundle()` rejects with an entry-point/module-resolution error because `remotion/index.ts` and the composition files do not exist yet.

- [ ] **Step 4: Create the shared props type `src/remotion-types.ts`.** `ShortVideoProps` lives src-side (not under `remotion/`) so the NodeNext root program never loads a remotion `.tsx` via a cross-boundary type import — Task 13's `assemble.ts` imports this file, not `remotion/ShortVideo.js`. It imports `CaptionStyle`/`WordTiming` from `src/` with `.js` extensions:
  ```ts
  import type { CaptionStyle } from './config/channel.js'
  import type { WordTiming } from './providers/whisperx.js'

  export interface ShortVideoProps {
    audioSrc: string
    backgroundSrc: string
    bgmSrc?: string
    bgmVolume?: number // default 0.12
    words: WordTiming[]
    style: CaptionStyle
    durationMs: number
  }
  ```

- [ ] **Step 5: Implement.** Create the four composition files plus the public-dir keepfile.

  `remotion/public/.gitkeep` — empty file (guarantees a `public` folder ships in the bundle; the assemble stage writes per-job assets under it).

  `remotion/Captions.tsx`:
  ```tsx
  import React from 'react'
  import { useCurrentFrame, useVideoConfig } from 'remotion'
  import type { CaptionStyle } from '../src/config/channel'
  import type { WordTiming } from '../src/providers/whisperx'

  export function chunkWords(words: WordTiming[], size = 4): WordTiming[][] {
    const pages: WordTiming[][] = []
    for (let i = 0; i < words.length; i += size) pages.push(words.slice(i, i + size))
    return pages
  }

  export const Captions: React.FC<{ words: WordTiming[]; style: CaptionStyle }> = ({ words, style }) => {
    const frame = useCurrentFrame()
    const { fps } = useVideoConfig()
    const currentTimeMs = (frame / fps) * 1000

    const pages = chunkWords(words, 4)
    const page = pages.find(
      (p) => currentTimeMs >= p[0].startMs && currentTimeMs <= p[p.length - 1].endMs,
    )
    if (!page) return null

    return (
      <div
        style={{
          position: 'absolute',
          bottom: '25%',
          left: 0,
          right: 0,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '0.25em',
          padding: '0 5%',
          textAlign: 'center',
        }}
      >
        {page.map((w, i) => {
          const active = currentTimeMs >= w.startMs && currentTimeMs <= w.endMs
          return (
            <span
              key={i}
              style={{
                fontFamily: style.font,
                fontWeight: 'bold',
                fontSize: style.fontSizePx,
                color: active ? style.activeColor : style.inactiveColor,
                WebkitTextStroke: `${style.strokePx}px black`,
                paintOrder: 'stroke fill',
                transform: active ? 'scale(1.08)' : 'scale(1)',
                display: 'inline-block',
              }}
            >
              {w.word}
            </span>
          )
        })}
      </div>
    )
  }
  ```

  `remotion/ShortVideo.tsx`:
  ```tsx
  import React from 'react'
  import { AbsoluteFill, Audio, OffthreadVideo, staticFile } from 'remotion'
  import type { ShortVideoProps } from '../src/remotion-types'
  import { Captions } from './Captions'

  // Single source of truth is src/remotion-types.ts; re-exported here so Root.tsx and
  // the composition test can keep importing ShortVideoProps from './ShortVideo'.
  export type { ShortVideoProps }

  // audioSrc/backgroundSrc/bgmSrc are public-relative paths (files copied into the
  // bundle's public/ folder by the assemble stage) resolved here via staticFile().
  export const ShortVideo: React.FC<ShortVideoProps> = ({
    audioSrc,
    backgroundSrc,
    bgmSrc,
    bgmVolume,
    words,
    style,
  }) => {
    return (
      <AbsoluteFill style={{ backgroundColor: 'black' }}>
        <OffthreadVideo src={staticFile(backgroundSrc)} muted />
        <Audio src={staticFile(audioSrc)} />
        {bgmSrc ? <Audio src={staticFile(bgmSrc)} volume={bgmVolume ?? 0.12} /> : null}
        <Captions words={words} style={style} />
      </AbsoluteFill>
    )
  }
  ```

  `remotion/Root.tsx`:
  ```tsx
  import React from 'react'
  import { Composition } from 'remotion'
  import { ShortVideo, type ShortVideoProps } from './ShortVideo'

  const FPS = 30

  const defaultProps: ShortVideoProps = {
    audioSrc: '',
    backgroundSrc: '',
    words: [],
    style: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    durationMs: 1000,
  }

  export const RemotionRoot: React.FC = () => {
    return (
      <Composition
        id="ShortVideo"
        component={ShortVideo}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={FPS} // placeholder; calculateMetadata overrides it
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.ceil((props.durationMs / 1000) * FPS),
        })}
      />
    )
  }
  ```

  `remotion/index.ts`:
  ```ts
  import { registerRoot } from 'remotion'
  import { RemotionRoot } from './Root'

  registerRoot(RemotionRoot)
  ```

- [ ] **Step 6: Run, expect pass.** `pnpm vitest run remotion/remotion.test.ts` — resolves `1080×1920 @ 30fps`, `durationInFrames === 120`.

- [ ] **Step 7: Add `remotion/tsconfig.json`.** The root tsconfig excludes `remotion/` (its `.tsx` files use extensionless relative imports that NodeNext rejects). This bundler-oriented config type-checks them exactly as Remotion's webpack/esbuild resolves them. `include` covers this directory plus `../src` because the compositions import types from `src/` (`CaptionStyle`, `WordTiming`):
  ```json
  {
    "extends": "../tsconfig.json",
    "compilerOptions": {
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "jsx": "react-jsx",
      "noEmit": true
    },
    "include": [".", "../src"]
  }
  ```

- [ ] **Step 8: Extend the `build` script to typecheck `remotion/`.** Edit `package.json` so `build` runs both the root (`src/`) typecheck and the Remotion typecheck. Exact edit:
  ```diff
  -    "build": "tsc --noEmit",
  +    "build": "tsc --noEmit && tsc -p remotion --noEmit",
  ```

- [ ] **Step 9: Run the full typecheck, expect pass.** `pnpm build` — both `tsc --noEmit` (root/`src`) and `tsc -p remotion --noEmit` (Remotion under `moduleResolution: Bundler`) exit 0 with no diagnostics. This is the first step that exercises the Remotion typecheck gate.

- [ ] **Step 10: Commit.** `git add src/remotion-types.ts remotion/ vitest.config.ts package.json pnpm-lock.yaml && git commit -m "feat: add Remotion ShortVideo composition with word captions and bundler tsconfig"`

---

### Task 13: Assemble stage

**Files:**
- Create `src/stages/assemble.ts`
- Test `src/stages/assemble.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `StageDef`; artifacts `voice/voice.json` (`.durationMs`), `captions/words.json` (`.words`), `visuals/background.mp4`, `voice/narration.wav`; `ctx.channel.captionStyle`, `ctx.channel.bgmDir`; `bundle` (`@remotion/bundler`), `selectComposition`+`renderMedia` (`@remotion/renderer`); type-only `ShortVideoProps` (`src/remotion-types.js`), `WordTiming` (`src/providers/whisperx.js`).
- Produces: `export const assembleStage: StageDef` (`name: 'assemble'`), artifact `assemble/final.mp4` (1080×1920@30fps, H.264 + AAC).

> Asset mechanism (verified, see group header): copy `background.mp4`/`narration.wav`/`bgm.mp3` into `path.join(serveUrl, 'public', jobId)` after `bundle()`, and pass public-relative paths as props; the composition resolves them with `staticFile()`. The bundle is built once per process (module-level memoized promise) and reused across renders.

- [ ] **Step 1: Write the failing test.** Create `src/stages/assemble.test.ts`:
  ```ts
  import { afterAll, describe, expect, it } from 'vitest'
  import { execa } from 'execa'
  import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import pino from 'pino'
  import { openDb } from '../db/index.js'
  import { probe } from '../media/ffmpeg.js'
  import { assembleStage } from './assemble.js'
  import type { ChannelConfig } from '../config/channel.js'
  import type { JobContext } from '../jobs/types.js'

  const cleanup: string[] = []
  function tmp(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }

  function makeChannel(bgmDir: string): ChannelConfig {
    return {
      name: 'testchan',
      niche: ['space'],
      tierMix: { volume: 2, premium: 1 },
      voice: { volume: 'af_heart' },
      captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
      bgDir: tmp('brainrot-bg-'),
      bgmDir,
      budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
      scriptModel: 'claude-sonnet-5',
    }
  }

  function makeCtx(runDir: string, channel: ChannelConfig): JobContext {
    return {
      jobId: 'job-assemble',
      db: openDb(':memory:'),
      channel,
      tier: 'volume',
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

  async function codecs(file: string): Promise<{ video?: string; audio?: string }> {
    const { stdout } = await execa('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file])
    const streams = (JSON.parse(stdout).streams as { codec_type: string; codec_name: string }[])
    return {
      video: streams.find((s) => s.codec_type === 'video')?.codec_name,
      audio: streams.find((s) => s.codec_type === 'audio')?.codec_name,
    }
  }

  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  describe('assembleStage', () => {
    it('renders a 1080x1920@30 H.264+AAC final.mp4 (~1s)', async () => {
      const channel = makeChannel(tmp('brainrot-bgm-')) // empty bgm dir -> no bgm
      const ctx = makeCtx(tmp('brainrot-run-'), channel)

      // Real tiny fixtures.
      await execa('ffmpeg', [
        '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=1080x1920:rate=30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        ctx.artifactPath('visuals', 'background.mp4'), '-y',
      ])
      await execa('ffmpeg', [
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        ctx.artifactPath('voice', 'narration.wav'), '-y',
      ])
      writeFileSync(
        ctx.artifactPath('voice', 'voice.json'),
        JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 }),
      )
      writeFileSync(
        ctx.artifactPath('captions', 'words.json'),
        JSON.stringify({
          words: [
            { word: 'hello', startMs: 0, endMs: 300 },
            { word: 'there', startMs: 300, endMs: 650 },
            { word: 'world', startMs: 650, endMs: 1000 },
          ],
        }),
      )

      await assembleStage.run(ctx)

      const out = ctx.artifactPath('assemble', 'final.mp4')
      expect(existsSync(out)).toBe(true)
      const p = await probe(out)
      expect(p.width).toBe(1080)
      expect(p.height).toBe(1920)
      expect(p.fps).toBeGreaterThanOrEqual(29)
      expect(p.fps).toBeLessThanOrEqual(31)
      expect(p.hasAudio).toBe(true)
      expect(p.durationMs).toBeGreaterThanOrEqual(900)
      expect(p.durationMs).toBeLessThanOrEqual(1300)
      const c = await codecs(out)
      expect(c.video).toBe('h264')
      expect(c.audio).toBe('aac')
    }, 180000)
  })
  ```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/stages/assemble.test.ts` — fails at import: `Cannot find module './assemble.js'` (`src/stages/assemble.ts` does not exist).

- [ ] **Step 3: Implement.** Create `src/stages/assemble.ts`:
  ```ts
  import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
  import path from 'node:path'
  import { bundle } from '@remotion/bundler'
  import { renderMedia, selectComposition } from '@remotion/renderer'
  import type { JobContext, StageDef } from '../jobs/types.js'
  import type { WordTiming } from '../providers/whisperx.js'
  import type { ShortVideoProps } from '../remotion-types.js'

  let bundlePromise: Promise<string> | undefined
  function getBundle(): Promise<string> {
    if (!bundlePromise) {
      bundlePromise = bundle({ entryPoint: path.resolve('remotion/index.ts') })
    }
    return bundlePromise
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
      copyFileSync(
        ctx.artifactPath('visuals', 'background.mp4'),
        path.join(publicJobDir, 'background.mp4'),
      )
      copyFileSync(
        ctx.artifactPath('voice', 'narration.wav'),
        path.join(publicJobDir, 'narration.wav'),
      )
      if (bgmFile) {
        copyFileSync(path.join(ctx.channel.bgmDir, bgmFile), path.join(publicJobDir, 'bgm.mp3'))
      }

      const props: ShortVideoProps = {
        audioSrc: `${ctx.jobId}/narration.wav`,
        backgroundSrc: `${ctx.jobId}/background.mp4`,
        bgmSrc: bgmFile ? `${ctx.jobId}/bgm.mp3` : undefined,
        words: captions.words,
        style: ctx.channel.captionStyle,
        durationMs: voice.durationMs,
      }

      const composition = await selectComposition({
        serveUrl,
        id: 'ShortVideo',
        inputProps: props,
      })
      const outPath = ctx.artifactPath('assemble', 'final.mp4')
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outPath,
        inputProps: props,
      })
      ctx.log.info({ outPath }, 'assemble: rendered final.mp4')
    },
  }
  ```

- [ ] **Step 4: Run, expect pass.** `pnpm vitest run src/stages/assemble.test.ts` — renders and probes a `1080×1920@30`, `h264`+`aac`, ~1s `final.mp4` (first run may download the headless Chrome shell).

- [ ] **Step 5: Run the full typecheck, expect pass.** `pnpm build` — both `tsc --noEmit` (root/`src`) and `tsc -p remotion --noEmit` exit 0. This guards against src↔remotion program leakage: `assemble.ts` imports `ShortVideoProps` from `src/remotion-types.js`, so no remotion `.tsx` is pulled into the root NodeNext program.

- [ ] **Step 6: Commit.** `git add src/stages/assemble.ts src/stages/assemble.test.ts && git commit -m "feat: add Remotion assemble stage rendering final mp4"`

---

### Task 14: QC stage

**Files:**
- Create `src/stages/qc.ts`
- Test `src/stages/qc.test.ts`

**Interfaces:**
- Consumes: `JobContext`, `StageDef`; `probe` (`src/media/ffmpeg.js`); system `ffmpeg` (`blackdetect`, `volumedetect`, `freezedetect`); artifacts `assemble/final.mp4`, `voice/voice.json` (`.durationMs`), `captions/words.json` (`.words`).
- Produces: `export interface QcResult { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] }`, `export function qcStage(opts?: { minMs?: number; maxMs?: number }): StageDef` (`name: 'qc'`; defaults `minMs 15000`, `maxMs 180000`), artifact `qc/qc.json`.

- [ ] **Step 1: Write the failing test.** Create `src/stages/qc.test.ts`:
  ```ts
  import { afterAll, describe, expect, it } from 'vitest'
  import { execa } from 'execa'
  import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import pino from 'pino'
  import { openDb } from '../db/index.js'
  import { qcStage } from './qc.js'
  import type { ChannelConfig } from '../config/channel.js'
  import type { JobContext } from '../jobs/types.js'
  import type { QcResult } from './qc.js'

  const cleanup: string[] = []
  function tmp(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }

  function makeCtx(runDir: string): JobContext {
    const channel: ChannelConfig = {
      name: 'testchan',
      niche: ['space'],
      tierMix: { volume: 2, premium: 1 },
      voice: { volume: 'af_heart' },
      captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
      bgDir: tmp('brainrot-bg-'),
      bgmDir: tmp('brainrot-bgm-'),
      budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
      scriptModel: 'claude-sonnet-5',
    }
    return {
      jobId: 'job-qc',
      db: openDb(':memory:'),
      channel,
      tier: 'volume',
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

  function seedVoice(ctx: JobContext): void {
    writeFileSync(
      ctx.artifactPath('voice', 'voice.json'),
      JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', durationMs: 1000 }),
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
  async function goodClip(file: string): Promise<void> {
    await execa('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=1080x1920:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
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
  })
  ```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/stages/qc.test.ts` — fails at import: `Cannot find module './qc.js'` (`src/stages/qc.ts` does not exist).

- [ ] **Step 3: Implement.** Create `src/stages/qc.ts`:
  ```ts
  import { readFileSync, statSync, writeFileSync } from 'node:fs'
  import { execa } from 'execa'
  import { probe } from '../media/ffmpeg.js'
  import type { JobContext, StageDef } from '../jobs/types.js'

  export interface QcResult {
    passed: boolean
    checks: { name: string; passed: boolean; detail: string }[]
  }

  const MB = 1024 * 1024
  const MAX_SIZE_BYTES = 256 * MB

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

  export function qcStage(opts?: { minMs?: number; maxMs?: number }): StageDef {
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

        let wordCount = 0
        try {
          const captions = JSON.parse(
            readFileSync(ctx.artifactPath('captions', 'words.json'), 'utf8'),
          ) as { words: unknown[] }
          wordCount = Array.isArray(captions.words) ? captions.words.length : 0
        } catch {
          wordCount = 0
        }
        checks.push({
          name: 'captions-present',
          passed: wordCount > 0,
          detail: `${wordCount} words`,
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

        const result: QcResult = { passed: checks.every((c) => c.passed), checks }
        writeFileSync(ctx.artifactPath('qc', 'qc.json'), JSON.stringify(result, null, 2))
        ctx.log.info({ passed: result.passed }, 'qc: complete')
      },
    }
  }
  ```

- [ ] **Step 4: Run, expect pass.** `pnpm vitest run src/stages/qc.test.ts` — good clip passes all checks (including `audio-level` and `frozen-frames`); black clip fails `black-frames`; missing-words case fails `captions-present`; silent static clip fails both `audio-level` and `frozen-frames`.

- [ ] **Step 5: Commit.** `git add src/stages/qc.ts src/stages/qc.test.ts && git commit -m "feat: add QC stage with ffprobe/blackdetect checks"`

---

### Task 15: CLI + golden-path e2e

**Files:**
- Create `src/cli.ts`, `tests-fixtures/golden/script.json`, `tests-fixtures/golden/words.json`, `README.md`
- Test `src/jobs/golden-path.test.ts` (pipeline integration), `src/cli.test.ts` (CLI wiring)

**Interfaces:**
- Consumes: `loadChannelConfig` (`src/config/channel.js`); `openDb` (`src/db/index.js`); `createJob`, `runJob`, `JobResult` (`src/jobs/runner.js`); `scriptStage`, `voiceStage`, `captionsStage`, `visualsVolumeStage`, `assembleStage`, `qcStage` (the six stages); `probe` (`src/media/ffmpeg.js`); `commander`.
- Produces: `brainrot` CLI (`produce`, `jobs`, `costs`), a golden-path pipeline integration test, and a CLI-wiring test.

> This task splits its two concerns honestly: (1) `src/jobs/golden-path.test.ts` is an **integration test** — it exercises the deterministic pipeline surface (`createJob` + `runJob` + the six-stage array with the trailing `{ runsRoot }` option; the core positional signature `runJob(db, channel, jobId, stages)` is unchanged) and does NOT shell out to the CLI, so it carries no fake red step. (2) `src/cli.test.ts` is a genuine red→green cycle that spawns `src/cli.ts` as a subprocess so the commander wiring (arg parsing, `resolveDbPath`, exit codes) is actually covered.

- [ ] **Step 1: Verify dependencies.** `commander` and `dotenv` are already pinned and installed by Task 1 — do NOT `pnpm add`. Verify with `pnpm list commander dotenv` (both listed).

- [ ] **Step 2: Write the golden-path fixtures.** Create `tests-fixtures/golden/script.json`:
  ```json
  {
    "hook": "Did you know a day on Venus is longer than its entire year?",
    "segments": [
      {
        "text": "Venus rotates so slowly that a single spin takes 243 Earth days.",
        "visualDirection": "slow pan across a glowing, cloud-wrapped Venus"
      },
      {
        "text": "But it orbits the Sun in just 225 days, so its day is longer than its year.",
        "visualDirection": "diagram of Venus tracing its orbit around the Sun"
      }
    ],
    "platformMeta": {
      "youtube": {
        "title": "Venus: A Day Longer Than Its Year",
        "description": "The strange, ultra-slow rotation of Venus, explained in 30 seconds.",
        "hashtags": ["#space", "#venus", "#astronomy"]
      },
      "tiktok": {
        "title": "Venus is WILD",
        "description": "A day longer than a year?!",
        "hashtags": ["#space", "#venus", "#facts"]
      },
      "instagram": {
        "title": "Venus: Day vs Year",
        "description": "Mind-bending planetary facts.",
        "hashtags": ["#space", "#venus", "#reels"]
      }
    }
  }
  ```
  Create `tests-fixtures/golden/words.json`:
  ```json
  {
    "words": [
      { "word": "Did", "startMs": 0, "endMs": 300 },
      { "word": "you", "startMs": 300, "endMs": 550 },
      { "word": "know", "startMs": 550, "endMs": 900 },
      { "word": "Venus", "startMs": 900, "endMs": 1400 },
      { "word": "spins", "startMs": 1400, "endMs": 1850 },
      { "word": "incredibly", "startMs": 1850, "endMs": 2400 },
      { "word": "slowly", "startMs": 2400, "endMs": 2800 },
      { "word": "today", "startMs": 2800, "endMs": 3000 }
    ]
  }
  ```

- [ ] **Step 3: Write the golden-path integration test.** Create `src/jobs/golden-path.test.ts`. This is an integration test, not a red→green unit cycle: it wires the real six-stage array through `runJob` and asserts a finished, QC-passed video. There is NO fake red step — see Step 4 for how to run it.
  ```ts
  import { afterAll, describe, expect, it } from 'vitest'
  import { execa } from 'execa'
  import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import path from 'node:path'
  import { loadChannelConfig } from '../config/channel.js'
  import { openDb } from '../db/index.js'
  import { createJob, runJob } from './runner.js'
  import { probe } from '../media/ffmpeg.js'
  import { scriptStage } from '../stages/script.js'
  import { voiceStage } from '../stages/voice.js'
  import { captionsStage } from '../stages/captions.js'
  import { visualsVolumeStage } from '../stages/visuals-volume.js'
  import { assembleStage } from '../stages/assemble.js'
  import { qcStage } from '../stages/qc.js'

  const REPO_ROOT = process.cwd()
  const cleanup: string[] = []
  function tmp(prefix: string): string {
    const d = mkdtempSync(path.join(tmpdir(), prefix))
    cleanup.push(d)
    return d
  }

  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  describe('golden-path e2e', () => {
    it('resumes past seeded stages and produces a ready video', async () => {
      const workspace = tmp('brainrot-e2e-')
      const bgDir = path.join(workspace, 'bg')
      const bgmDir = path.join(workspace, 'bgm')
      const runsRoot = path.join(workspace, 'runs')
      mkdirSync(bgDir, { recursive: true })
      mkdirSync(bgmDir, { recursive: true }) // empty -> no bgm
      mkdirSync(runsRoot, { recursive: true })

      // One 1080x1920 background clip in the library.
      await execa('ffmpeg', [
        '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=1080x1920:rate=30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        path.join(bgDir, 'bg1.mp4'), '-y',
      ])

      // Channel TOML with absolute asset dirs.
      const tomlPath = path.join(workspace, 'channel.toml')
      writeFileSync(
        tomlPath,
        [
          'name = "example"',
          'niche = ["space facts", "astronomy"]',
          'script_model = "claude-sonnet-5"',
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
          `bg_dir = ${JSON.stringify(bgDir)}`,
          `bgm_dir = ${JSON.stringify(bgmDir)}`,
          '',
        ].join('\n'),
      )

      const channel = loadChannelConfig(tomlPath)
      const db = openDb(path.join(workspace, 'brainrot.db'))
      const jobId = createJob(db, channel, { topic: 'Space facts about Venus', tier: 'volume' })

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
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        path.join(runDir, 'voice', 'narration.wav'), '-y',
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
        .prepare(`SELECT stage, status FROM job_stages WHERE job_id = ? AND stage IN ('script','voice','captions')`)
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

      const qc = JSON.parse(
        readFileSync(path.join(runDir, 'qc', 'qc.json'), 'utf8'),
      ) as { passed: boolean }
      expect(qc.passed).toBe(true)
    }, 240000)
  })
  ```

- [ ] **Step 4: Run the golden-path integration test, expect PASS.** `pnpm vitest run src/jobs/golden-path.test.ts`. Because every consumed module (the six stages, `runJob`, `probe`, `loadChannelConfig`, `openDb`) was implemented in Tasks 1–14, this is not a red step: it is expected to PASS if Tasks 1–14 were implemented correctly. Any failure here is a real integration bug (a stage contract mismatch, an artifact-path or duration bug, a QC gate error) — do not proceed to the CLI; fix the exposed integration bug first, then re-run until this passes.

- [ ] **Step 5: Write the failing CLI test.** Create `src/cli.test.ts`. This is a genuine red step: it spawns `src/cli.ts` as a subprocess, so it fails until the CLI file exists.
  ```ts
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
  ```

- [ ] **Step 6: Run the CLI test, expect failure.** `pnpm vitest run src/cli.test.ts` — both cases fail: `pnpm exec tsx src/cli.ts ...` exits non-zero because `src/cli.ts` does not exist yet (tsx reports it cannot find the entry module), so `result.exitCode` is not 0.

- [ ] **Step 7: Implement the CLI.** Create `src/cli.ts`:
  ```ts
  import 'dotenv/config'
  import { Command } from 'commander'
  import { createJob, runJob } from './jobs/runner.js'
  import { loadChannelConfig } from './config/channel.js'
  import { openDb } from './db/index.js'
  import { scriptStage } from './stages/script.js'
  import { voiceStage } from './stages/voice.js'
  import { captionsStage } from './stages/captions.js'
  import { visualsVolumeStage } from './stages/visuals-volume.js'
  import { assembleStage } from './stages/assemble.js'
  import { qcStage } from './stages/qc.js'
  import type { Tier } from './jobs/types.js'

  function resolveDbPath(flagDb?: string): string {
    return flagDb ?? process.env.BRAINROT_DB ?? 'data/brainrot.db'
  }

  const program = new Command()
  program.name('brainrot').description('Brainrot Machine CLI')

  program
    .command('produce')
    .requiredOption('--channel <path>', 'path to channel TOML')
    .requiredOption('--topic <text>', 'topic text')
    .option('--tier <tier>', 'quality tier', 'volume')
    .option('--db <path>', 'sqlite db path')
    .option('--runs-root <path>', 'runs root directory', 'runs')
    .action(async (opts: { channel: string; topic: string; tier: string; db?: string; runsRoot: string }) => {
      const channel = loadChannelConfig(opts.channel)
      const db = openDb(resolveDbPath(opts.db))
      const jobId = createJob(db, channel, { topic: opts.topic, tier: opts.tier as Tier })
      const stages = [
        scriptStage,
        voiceStage,
        captionsStage,
        visualsVolumeStage,
        assembleStage,
        qcStage(),
      ]
      const result = await runJob(db, channel, jobId, stages, { runsRoot: opts.runsRoot })
      process.stdout.write(JSON.stringify(result) + '\n')
      // exit 0 for ready/needs-review; exit 1 for failed AND blocked (the JSON line
      // above carries the ready/needs-review/failed/blocked distinction for tooling).
      process.exit(result.status === 'failed' || result.status === 'blocked' ? 1 : 0)
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

  program.parseAsync(process.argv)
  ```

- [ ] **Step 8: Run the CLI test, expect pass.** `pnpm vitest run src/cli.test.ts` — `jobs` opens the seeded db, prints the table header (exit 0), and `produce --help` prints usage listing `--channel`/`--topic`/`--tier` (exit 0).

- [ ] **Step 9: Write the README.** Create `README.md`:
  ```markdown
  # Brainrot Machine

  Automated short-form video pipeline. `brainrot produce` turns a topic into a
  finished, QC-checked, word-captioned 9:16 MP4 in the library.

  ## Prerequisites

  - Node >= 22 and [pnpm](https://pnpm.io)
  - [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
  - Docker (for the WhisperX caption-alignment sidecar)

  ## Setup

  ```bash
  pnpm install
  cp .env.example .env          # fill in provider keys (ANTHROPIC_API_KEY, ...)
  docker compose up -d whisperx # caption alignment sidecar
  ```

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
  # options: --tier volume  --db data/brainrot.db  --runs-root runs
  ```

  Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
  `1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

  ## Where outputs land

  - Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
    `words.json`, `background.mp4`, `final.mp4`, `qc.json`)
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
  pnpm test             # unit + integration (mocked providers; real ffmpeg/Remotion)
  pnpm test:contract    # one real paid call per provider (manual, excluded by default)
  ```

  Media/render tests shell out to ffmpeg and run a real Remotion render; the first
  render downloads a headless Chrome shell.
  ```

  Wire a `brainrot` script into `package.json` if not already present:
  `"scripts": { "brainrot": "tsx src/cli.ts" }`.

- [ ] **Step 10: Final commit.** `git add src/cli.ts src/cli.test.ts src/jobs/golden-path.test.ts tests-fixtures/golden/script.json tests-fixtures/golden/words.json README.md package.json && git commit -m "feat: add brainrot CLI, CLI-wiring test, and golden-path integration test"`
