# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Brainrot Machine: an automated pipeline that turns a topic into a finished,
QC-checked, word-captioned 9:16 short video, and publishes it to YouTube
Shorts and/or Instagram Reels — per channel, per declared platform — on a
per-channel schedule. Single Node/TypeScript package — not a
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
pnpm brainrot auth youtube|instagram --channel <name>
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
script -> voice -> captions -> visuals -> assemble -> qc -> store
```

`runJob` (`src/jobs/runner.ts`) drives this: it persists per-stage status to
`job_stages` and **skips any stage already `done`**, which is what makes
`resumeJob` (`src/jobs/resume.ts`) work — resuming a `failed`/`blocked`/
`queued` job just re-invokes `runJob` with the same stage list, and completed
stages are free. The final gate (after all stages succeed) reads `qc.json`,
`script.json`, and `store.json`, upserts a `library` row (`ready` or
`needs-review` depending on QC) plus its `library_objects` row, and marks the
job `done` — this final window is itself re-run-safe on resume (upsert, not
insert). A missing `store.json` is tolerated, which is what keeps the gate
survivable for jobs produced before object storage existed.

A stage failure marks the job `failed`, _except_ a thrown `BudgetExceededError`
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
- validate the env they depend on before the lease too, as a `bad-env` noop:
  `publish-next` checks `BRAINROT_TOKEN_KEY` and the quota vars
  (`badEnvMessage`), `produce-next` checks that object storage is configured
  (`s3ConfigError`, `src/storage/config.ts`). The latter is a fail-fast, not a
  duplicate of the `store` stage's own construction: `store` runs **last**, so
  without the gate an unconfigured deployment pays for a full Remotion render
  and only then fails the job. Object storage is required to produce — there is
  no local-only fallback (design spec §3.5).

`produce-next` asks `planTick` (`src/loop/plan-tick.ts`) whether to resume a
blocked job or claim+produce a new topic; `publish-next` asks
`src/publish/schedule.ts` which channels are due — inside a 09:00–21:00 local
window, under their `videos_per_day` count for the day, and past a derived
`12h / videos_per_day` minimum gap since their last attempt — orders them by
how far behind that count they are, and fans the chosen video out to every
declared platform that still wants it. Each platform's real daily cap
(YouTube's ~6/day per Google Cloud project, shared across channels;
Instagram's 50/day per account) is enforced twice: once at config load, where
a channel set declaring more `videos_per_day` than a platform allows is a
hard error, and once per tick as a backstop.

Manual commands (`produce`, `resume`, `auth <platform>`,
`library approve/reject`, `publish retry/mark-done`) deliberately run
**outside** these leases — they are operator actions that can race a live
cron tick if the corresponding loop isn't stopped first.

### Config: channel TOML is the unit of everything

Each channel is one `channels/<name>.toml`, loaded by `src/config/channel.ts`
through a zod schema with defaults, then normalized into camelCase
`ChannelConfig`. `loadChannelsDir` enforces an invariant the whole loop system
depends on: **the file's basename must equal the TOML's `name` field** —
`resumeJob` resolves a job's channel config by filename
(`<channelsDir>/<job.channel>.toml`), so a mismatch would silently wedge
resume. Duplicate declared names are also rejected at load time. A channel
TOML with no `[publish]` table never enters the publish pool; one with no
`[scout]` table is never scouted (manual `produce` still works). A `[publish]`
table holds one `[publish.<platform>]` sub-table per platform the channel
targets (`youtube`, `instagram`), each validated against that platform's own
option schema — no schedule of its own, since cadence comes from the
channel's `videos_per_day`. A stale `slots` key at either level is a load
error naming its replacement. A channel declaring both `[publish.youtube]`
and `[publish.instagram]` cross-posts the same rendered video to both.

### Budget enforcement is layered, not a single check

`src/jobs/costs.ts`'s `assertBudget` is called before every paid provider call
and checks, in order: per-video cap (`channel.budget.perVideoUsdMicros`) →
channel-day cap (UTC) → global-day cap (`BRAINROT_GLOBAL_DAILY_USD`, spans all
channels). A breach throws `BudgetExceededError` _before_ the call fires.
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

### Publishing: OAuth + encrypted credentials, per platform

`src/publish/` holds the multi-platform upload path: `oauth-flow.ts` runs the
one-time interactive per-channel consent grant for each platform
(`runYoutubeAuthFlow`, `runInstagramAuthFlow` — structurally identical
loopback-listener-then-browser-consent flows, Instagram's with an extra
short-lived-to-long-lived token exchange Meta requires), `crypto.ts` /
`tokens.ts` store the resulting credential AES-256-GCM-encrypted in
`oauth_tokens` (`BRAINROT_TOKEN_KEY` never leaves `.env`; the table's
`expires_at` column is NULL for YouTube's non-expiring refresh token and set
for Instagram's ~60-day long-lived token), `platforms/youtube.ts` and
`platforms/instagram.ts` each implement upload mechanics and credential
resolution behind the shared `PublishAdapter` seam (`platforms/index.ts` is
the one-line-per-platform registry `publish-next` drives generically),
`schedule.ts` derives the publish window and minimum gap from `videos_per_day`,
and `publishes.ts` is the DAO for the `publishes` table's
claim/done/failed/interrupted state machine, keyed per (channel, platform),
with a `seq` ordinal per local day standing in for the old clock-time slot.
The two platforms' credential-resolution shapes differ: YouTube mints a
fresh access token from its stored refresh token on every tick, while
Instagram's stored token _is_ the access token and is refreshed in place by
its adapter only when within its expiry window (`IG_TOKEN_REFRESH_WINDOW_MS`)
— there is no per-tick mint step. Refresh tokens, access tokens, and other
credential material must never reach logs or stdout — CLI commands print
only confirmations.

### The dashboard is read-only, and structurally so

`src/dashboard/` serves a localhost web view of the database (compose service
`dashboard`, port 8787, loopback-bound). It opens SQLite through
`openDbReadonly` — a sibling of `openDb` that skips the `mkdirSync` and the
`schema.sql` exec, both of which are writes — so no route can mutate state.
Operator mutations stay on the CLI, where the lease-race caveats are
documented.

The module splits SQL from HTML and enforces it by structure: `queries/*` are
`(db, params) -> typed data` and emit no markup, `views/*` are
`(data) -> SafeHtml` and issue no SQL. Interpolation goes through `html.ts`,
which escapes by default — topic titles come from scraped sources, so this is
a live path. `queries/jobs.ts` hardcodes `DASHBOARD_STAGE_ORDER` rather than
calling `pipelineStages()`, which would drag remotion and kokoro into a
viewer; a test asserts the two lists match so they cannot drift.

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
`CREATE TABLE IF NOT EXISTS`) — so schema.sql alone is the declarative shape
of a _fresh_ database, and a new table still needs nothing else.

Changes `CREATE TABLE IF NOT EXISTS` cannot express against an **existing**
database go in `src/db/migrate.ts`, which `openDb` calls right after the
schema exec (and `openDbReadonly` never calls, since it must stay
write-free). This is deliberately not a migration framework: there is no
version ledger and no ordered list of numbered steps. Each step instead
**probes for its own precondition** (`PRAGMA table_info` for an added column,
a `sqlite_master.sql` substring for a CHECK that cannot be ALTERed) and is a
no-op when already applied, so it is idempotent and self-healing on a fresh
database. A step that has to rebuild a table renames the old one aside and
replays `schema.sql` rather than carrying its own copy of the DDL — schema.sql
stays the single source of truth for table shape.

### Test-only build

`scripts/build-test-cli.ts` transpiles `src/` into a mirrored `dist/` tree via
a Vitest `globalSetup`, so the CLI subprocess tests can spawn `node dist/cli.js`
(~0.34s) instead of `pnpm exec tsx src/cli.ts` (~1.15s). It is transpile-only,
never `--bundle`: bundling flattens the module graph and breaks
`import.meta.url`-relative asset lookups. There are four in this codebase —
`src/cli.ts`, `src/db/index.ts`, `src/stages/assemble.ts`, and
`src/dashboard/server.ts` (`static/dashboard.css`) — but
`src/testing/dist-layout.test.ts` guards only the first three. The dashboard's
is untested there because it's also unused there: `docker-compose.yml` runs
the dashboard as `pnpm exec tsx src/dashboard/server.ts` straight against
`src/`, no spawned test starts it from `dist/`, and `build-test-cli.ts` only
copies `db/schema.sql` — not the CSS — into `dist/`. The lookup is consequently
correct by construction but unexercised, same as the Remotion entry path below;
if the dashboard is ever spawned from `dist/` (a container `node dist/...`
entrypoint, a dashboard CLI test), it will 404 its own stylesheet until both a
copy step and a fourth `dist-layout.test.ts` case are added.

Note that no spawned CLI test currently reaches the `assemble` stage, so the
Remotion entry path is correct by construction but unexercised.

## Design docs

`superpowers/specs/` and `superpowers/plans/` contain the original design specs
and implementation plans (walking-skeleton volume pipeline, premium tier,
trend-scout loop, publishing loop) — check these for the reasoning behind a
behavior before assuming it's incidental. The `superpowers/` tree is gitignored
by design: it is local working documentation, not a tracked deliverable.
