# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Brainrot Machine: an automated pipeline that turns a topic into a finished,
QC-checked, word-captioned 9:16 short video, and publishes it to YouTube
Shorts on a per-channel schedule. Single Node/TypeScript package — not a
multi-package monorepo (`pnpm-workspace.yaml` here only configures
`allowBuilds`/`minimumReleaseAgeExclude`, it declares no `packages:` list).
`remotion/` has its own `tsconfig.json` and is type-checked separately but is
built from the same root and `pnpm install`.

## Commands

```bash
pnpm install
cp .env.example .env          # provider keys — see README for which are required
docker compose up -d whisperx # caption-alignment sidecar (captions + ElevenLabs-fallback)

pnpm build                    # tsc --noEmit on both src/ and remotion/ — no emit, type-check only
pnpm test                     # vitest run — mocked providers, real ffmpeg/Remotion
                               # a globalSetup esbuilds src/ -> dist/ first (~19ms);
                               # CLI tests spawn `node dist/cli.js` via src/testing/run-cli.ts
pnpm test:contract            # CONTRACT=1 — real paid calls: ElevenLabs, one LLM call

pnpm brainrot produce --channel channels/<name>.toml --topic "..."
pnpm brainrot scout | produce-next | publish-next | digest
pnpm brainrot jobs | costs
pnpm brainrot topics list|reject <ids...>
pnpm brainrot topics requeue <id>   # orphaned 'claimed' topic -> 'candidate'; refuses while a live job holds it
pnpm brainrot library list|approve|reject <jobIds...>
pnpm brainrot publish retry|mark-done <jobId>
pnpm brainrot publishes list [--days N]
pnpm brainrot auth youtube --channel <name>
```

Run a single test file: `pnpm vitest run src/jobs/runner.test.ts`.
Contract tests live in `*.contract.test.ts` and are excluded from the default
`pnpm test` run (see `vitest.config.ts`); they hit real provider APIs and
cost real money — don't run them without a reason.

## Architecture

### The pipeline: stages over a JobContext

A "job" runs a fixed ordered list of stages against one `JobContext`
(`src/jobs/types.ts`). Each `StageDef` is `{ name, run(ctx) }`; stages read
prior stages' artifacts off disk via `ctx.artifactPath(stage, file)`
(`runs/<jobId>/<stage>/<file>`) and write their own. `pipelineStages()` in
`src/jobs/pipeline.ts` is the single source of truth for stage order — CLI
`produce`, `resume`, and `produce-next` all wire through it so they can never
drift apart:

```
script -> voice -> captions -> visuals -> assemble -> qc
```

`runJob` (`src/jobs/runner.ts`) drives this: it persists per-stage status to
`job_stages` and **skips any stage already `done`**, which is what makes
`resumeJob` (`src/jobs/resume.ts`) work — resuming a `failed`/`blocked`/
`queued` job just re-invokes `runJob` with the same stage list, and completed
stages are free. The final gate (after all stages succeed) reads `qc.json` and
`script.json`, upserts a `library` row (`ready` or `needs-review` depending on
QC), and marks the job `done` — this final window is itself re-run-safe on
resume (upsert, not insert).

A stage failure marks the job `failed`, *except* a thrown `BudgetExceededError`
(from `src/jobs/costs.ts`) which marks it `blocked` instead — this is an
enforcement outcome, not a crash, and `produce-next`/digest treat the two
differently.

There is a single visuals implementation: `visuals-volume.ts` picks a random
background clip from `channel.bgDir` and loops/crops it to the narration
duration. Voice synthesis has its own independent fallback chain
(`src/stages/voice.ts`): if the channel config sets `[voice.premium]`
(ElevenLabs), that provider is tried first and falls back to kokoro/edge-tts
on failure or absence — this is a plain per-channel setting, not a pipeline
branch.

### Two cron loops share one SQLite file

`src/loop/produce-next.ts` and `src/loop/publish-next.ts` are the two
long-running cycles, each doing **one unit of work per invocation** — cron
cadence controls throughput, not a loop inside the code. Both:

- take a named lease (`src/loop/lease.ts`, `leases` table) so only one
  process is doing that kind of work at a time; a held lease is a normal
  no-op, not an error. `scout` takes one too (name `scout`, 30-min TTL,
  acquired in its CLI action) and prints the same `lease-held` noop line.
  `produce-next` heartbeats its lease at every stage start (`runJob`'s
  `heartbeat` option, threaded through `resumeJob` as well) so a render
  longer than the TTL is not taken over mid-flight.
- run an idempotent **repair sweep** at the top of the lease window to heal
  state left inconsistent by a crash between two writes that should have been
  atomic (e.g. a topic left `claimed` after its job already landed in
  `library`; a `publishes` row left `claimed` after an upload that never
  confirmed).
- read `channels/*.toml` fresh every tick — via `tryLoadChannelsDir`, before
  the lease: a broken TOML is reported as a `config-error` noop line rather
  than thrown, because a tick that throws prints no JSON line at all.

`produce-next` asks `planTick` (`src/loop/plan-tick.ts`) whether to resume a
blocked job or claim+produce a new topic; `publish-next` scans due slots
across channels (`src/publish/slots.ts`), enforces YouTube's per-project daily
upload quota (`BRAINROT_YT_UPLOADS_PER_DAY`, shared across every channel), and
picks the candidate furthest behind its cadence.

Manual commands (`produce`, `resume`, `auth youtube`, `library approve/reject`,
`publish retry/mark-done`) deliberately run **outside** these leases — they
are operator actions that can race a live cron tick if the corresponding loop
isn't stopped first.

### Config: channel TOML is the unit of everything

Each channel is one `channels/<name>.toml`, loaded by `src/config/channel.ts`
through a zod schema with defaults, then normalized into camelCase
`ChannelConfig`. `loadChannelsDir` enforces an invariant the whole loop system
depends on: **the file's basename must equal the TOML's `name` field** —
`resumeJob` resolves a job's channel config by filename
(`<channelsDir>/<job.channel>.toml`), so a mismatch would silently wedge
resume. Duplicate declared names are also rejected at load time. A channel
TOML with no `[publish]` table never enters the publish pool; one with no
`[scout]` table is never scouted (manual `produce` still works).

### Budget enforcement is layered, not a single check

`src/jobs/costs.ts`'s `assertBudget` is called before every paid provider call
and checks, in order: per-video cap (`channel.budget.perVideoUsdMicros`) →
channel-day cap (UTC) → global-day cap (`BRAINROT_GLOBAL_DAILY_USD`, spans all
channels). A breach throws `BudgetExceededError` *before* the call fires.
Providers that pay for a call that then fails downstream (e.g. a schema-invalid
LLM response) still have to ledger that spend — see `src/providers/errors.ts`'s
`ProviderCostError` / `errorCostUsdMicros` duck-typed cost-recovery convention.

### Providers and the sidecar

`src/providers/*.ts` wrap external APIs (Anthropic for scripts, ElevenLabs for
premium voice, kokoro/edge-tts for the free voice fallback chain).
`src/providers/whisperx.ts` talks to the Dockerized WhisperX sidecar
(`docker-compose.yml`) for caption word-level alignment — needed whenever a
job's voice.json wasn't produced by a successful ElevenLabs synth (ElevenLabs
itself returns word timings directly, no alignment pass needed).

### Publishing: OAuth + encrypted refresh tokens

`src/publish/` holds the YouTube upload path: `oauth-flow.ts` runs the
one-time interactive per-channel consent grant, `crypto.ts` / `tokens.ts`
store the refresh token AES-256-GCM-encrypted in `oauth_tokens`
(`BRAINROT_TOKEN_KEY` never leaves `.env`), `youtube.ts` mints access tokens
and performs the resumable upload, `slots.ts` computes due publish slots from
a channel's local-time schedule, and `publishes.ts` is the DAO for the
`publishes` table's claim/done/failed/interrupted state machine. Refresh
tokens and other credential material must never reach logs or stdout —
CLI commands print only confirmations.

### Remotion rendering

`remotion/` is the actual video composition (React components rendered to
frames by `@remotion/renderer`), driven by `src/stages/assemble.ts` and
`src/stages/captions.ts`. It has its own `tsconfig.json` and is type-checked
separately in `pnpm build`, but is not a separate package — no independent
install/version.

### Data flow summary

SQLite (`data/brainrot.db`, WAL mode, `busy_timeout=5000` since multiple cron
processes touch the same file) holds all state: `jobs`/`job_stages` (pipeline
progress), `library` (finished videos awaiting review/publish), `topics`
(scout queue), `costs` (spend ledger), `leases`, `publishes`, `oauth_tokens`.
Per-job filesystem artifacts live under `runs/<jobId>/<stage>/`. Schema lives
in `src/db/schema.sql`, applied via `db.exec` on every `openDb` call (plain
`CREATE TABLE IF NOT EXISTS`, no migration framework — additive schema
changes only).

### Test-only build

`scripts/build-test-cli.ts` transpiles `src/` into a mirrored `dist/` tree via
a Vitest `globalSetup`, so the CLI subprocess tests can spawn `node dist/cli.js`
(~0.34s) instead of `pnpm exec tsx src/cli.ts` (~1.15s). It is transpile-only,
never `--bundle`: bundling flattens the module graph and breaks the three
`import.meta.url`-relative asset lookups in `src/cli.ts`, `src/db/index.ts` and
`src/stages/assemble.ts`. `src/testing/dist-layout.test.ts` guards all three.
Note that no spawned CLI test currently reaches the `assemble` stage, so the
Remotion entry path is correct by construction but unexercised.

## Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` contain the original
design specs and implementation plans (walking-skeleton volume pipeline,
premium tier, trend-scout loop, publishing loop) — check these for the
reasoning behind a behavior before assuming it's incidental.
