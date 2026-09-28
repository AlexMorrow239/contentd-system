# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Brainrot Machine: an automated pipeline that turns a topic into a finished,
QC-checked, word-captioned 9:16 short video, ready to post to YouTube Shorts,
Instagram Reels and/or TikTok — per channel, per declared platform. The
pipeline's job ends at a finished video in the library; posting it is a
manual, per-platform step an operator does by hand from the dashboard's
`/post` page (see "Posting: manual, per platform" below) — there is no
upload adapter, no OAuth grant and no scheduler in this codebase. Single
Node/TypeScript package — not a multi-package monorepo
(`pnpm-workspace.yaml` here only configures
`allowBuilds`/`minimumReleaseAgeExclude`, it declares no `packages:` list).
`remotion/` has its own `tsconfig.json` and is type-checked separately but is
built from the same root and `pnpm install`.

## Commands

Development needs Node >=22, pnpm, and ffmpeg/ffprobe on PATH. The default
suite uses mocked providers and disposable fixtures; no `.env`, live daemon,
or service container is needed. Remotion's first render may download Chrome.
`prod/channels/` is the only maintained channel directory.

```bash
pnpm install
pnpm check                  # formatting, lint, CLI/Remotion types, Next build, default suite
pnpm build                  # CLI/Remotion type-check only
pnpm dashboard:build        # production Next.js build, including dashboard type-check
pnpm dashboard:dev          # explicit BRAINROT_ROOT required
pnpm test:dashboard         # Playwright; build + install Chromium first
pnpm test                   # mocked providers, real ffmpeg/Remotion
pnpm test:config             # schema, path rules, tracked channel TOMLs
pnpm test:scout              # sources, scoring, filtering, queues
pnpm test:pipeline           # stages, lifecycle, real render tests
pnpm test:coverage           # report-only coverage; no thresholds
pnpm vitest run src/jobs/test/runner.test.ts
```

Opt-in tiers:

```bash
pnpm test:contract           # real paid provider calls; run deliberately

docker compose --profile test up -d --wait minio
pnpm test:storage            # free MinIO conformance tests
docker compose --profile test stop minio
```

`pnpm check` does not run Python tests, paid contracts, MinIO tests, or image
builds. The sidecar tests live in `sidecar/whisperx/test_app.py`; run them with
`python -m pytest sidecar/whisperx/test_app.py` in an environment containing
its runtime dependencies plus pytest and httpx. Test dependencies are not yet
declared separately; see [development audit](docs/development-audit.md).

Production runs through Compose. `.env.example` documents its settings;
create `.env` only if absent, and fill in the provider keys. Read-only examples:

```bash
docker compose exec brainrot pnpm brainrot jobs
docker compose exec brainrot pnpm brainrot costs
docker compose exec brainrot pnpm brainrot topics list
docker compose exec brainrot pnpm brainrot library list
```

Prefer dashboard actions for routine mutations: its queue coordinates leases.
For break-glass CLI work, stop the daemon first, then use a one-shot container;
`docker compose exec` cannot run against a stopped service:

```bash
docker compose stop brainrot
docker compose run --rm --no-deps brainrot pnpm brainrot resume JOB_ID
docker compose start brainrot
```

Replace `JOB_ID` with the affected job. Use `--force` for a `running` job only
when no live process owns it. SIGTERM stops polling but does not cancel an
active render; Docker can kill it after the stop timeout. See README Recovery.
Host entrypoints require an explicit `--root`/`BRAINROT_ROOT`; tests use temp
roots. Compose supplies `/app/state` and a container-only SQLite volume.

Release commands (both images; the dashboard shares the brainrot image):

```bash
pnpm check
docker compose build brainrot whisperx
docker compose up -d --no-build
```

Channel TOMLs are live bind mounts, reloaded every tick. Stop the daemon before
editing them if it must not consume unvalidated changes. See README for setup,
production operations, and recovery.

## Architecture

### The pipeline: stages over a JobContext

`src/jobs/pipeline.ts` owns stage order for produce, resume, and produce-next:

```
script -> voice -> captions -> visuals -> assemble -> qc -> store
```

A `StageDef` runs against `JobContext` (`src/jobs/types.ts`). Read/write artifacts
through `ctx.artifactPath(stage, file)`, under `runs/<jobId>/<stage>/`.
`runJob` persists stage status and skips stages already `done`, making resume
reusable without repeating successful work. Errors mark a job `failed`;
`BudgetExceededError` marks it `blocked`.

The final gate reads QC/script/store artifacts, upserts the library and stored
object records, marks the job done, and changes its claimed topic to used in
one transaction. Preserve idempotency and that transaction boundary. Missing
store metadata is tolerated; storage is optional. `library.qc_json` carries
the verdict so dashboard queries do not need to read job artifacts.

`visuals-volume.ts` selects and loops/crops a background clip. Voice selection
is independent: configured ElevenLabs first, then kokoro/edge-tts on provider
failure or absence. Budget enforcement must not trigger a paid-provider fallback.

### One daemon, five workers share one SQLite file

`src/loop/daemon.ts` starts `produce`, `scout`, `digest`, `actions-fast`, and
`actions-slow`. Workers check demand, do one unit, and immediately recheck.
Idle/error sleeps are 30s/60s; fast actions poll at 1s. Identical idle messages
are deduplicated. Digest runs at/after 08:00 local time once per process-day;
a same-day restart can produce another report. There is no publishing worker.

`produceNextTick` (`src/loop/produce-next.ts`) loads channels fresh each tick,
reports malformed config as a structured noop, and acquires the `produce`
lease before mutation. It repairs historical claimed-topic/library mismatches,
reclaims fully posted stored objects when storage is configured, then executes
`planTick`. Stage-start heartbeats extend the lease; ownership checks prevent
an expired holder from releasing a successor's lease.

`planTick` (`src/loop/plan-tick.ts`) prefers eligible blocked jobs, then claims
new topics subject to daily production limits, budgets, and backlog capacity.
A channel holding `ceil(videos_per_day * backlog_days)` unconsumed videos
pauses production. Videos do not expire; posting to all declared platforms or
discarding them frees capacity. Running jobs orphaned by a crash are not
automatically resumed.

`fullyPostedClause` (`src/posts/posts.ts`) is shared by reclaim, inventory,
post-queue, and digest readers. Empty `platforms` means nothing is fully posted.
Reclaim deletes bytes and stamps `reclaimed_at`, preserving `library_objects`
so backfill does not re-upload intentionally reclaimed videos.

The two lease names are `produce` and `scout`. Scout's lease TTL is 30 minutes.
Manual `produce`, `resume`, library mutations, and topic reject/requeue bypass
leases; stop the daemon before using them. The dashboard enqueues actions whose
workers coordinate the necessary leases; prefer it for routine operations.

`scoutChannel` stores scores >= `SCOUT_MIN_SCORE` (80). Its persisted
`scout_state` recheck cadence is `SCOUT_RECHECK_MS` (20 minutes); `scout --force`
bypasses it. It also stops fetching when candidate depth reaches
`ceil(videos_per_day * queue_days)`. These gates live in scouting, so manual
and daemon calls share them. A digest flags starvation when a channel with
scout sources and target platforms has neither candidates nor unposted videos.

### The operator-action queue: two more workers, drained fast and slow

The dashboard inserts `operator_actions`; daemon workers execute them.
Keep `src/actions/` separated by import boundary:

- `catalog.ts`: lightweight metadata and argument schemas, shared with dashboard.
- `queue.ts`: action persistence and guarded state transitions.
- `handlers.ts`: daemon-only implementations; never import into the dashboard.

`src/arch.test.ts` checks both dashboard trees' transitive runtime imports, including TSX and dynamic imports. Pipeline,
Remotion, and paid-provider clients must stay outside the HTTP process.
Storage SDK imports are lazy in handlers and the store stage.

Fast actions are `topics.reject`, `topics.requeue`, `library.approve`,
`digest.run`, `post.mark`, and `post.unmark`. They perform no network calls,
rendering, or lease acquisition. Slow actions are `produce.next`, `jobs.produce`,
`scout.run`, `jobs.resume`, `library.reject`, `library.backfillStore`, and
`topics.pruneMedia`. Discard belongs in slow because it can delete S3 objects.

Lease declarations matter:

| Slow action                                               | Worker-acquired lease |
| --------------------------------------------------------- | --------------------- |
| `jobs.produce`, `jobs.resume`                             | `produce`             |
| `scout.run`, `topics.pruneMedia`                          | `scout`               |
| `produce.next`, `library.reject`, `library.backfillStore` | None                  |

`produce.next` takes its own lease inside `produceNextTick`; declaring it again
would turn each action into a lease-held noop. `runJob` and `scoutAll` do not
self-lease, so their action wrappers must do so.

Fast workers drain up to `MAX_FAST_DRAIN` (50) actions and maintain the daemon
heartbeat. Slow workers complete at most one per unit. `POST /api/actions` returns
409 when the daemon heartbeat is stale; this prevents queueing into a dead
worker, not unauthorized access.

Lease-blocked actions stay pending with a notice. A per-poll skip set avoids
repeated acquire/write attempts for the same held lease. `ACTION_SCAN_WINDOW`
bounds the pending rows inspected; rows beyond that window can remain blocked
from consideration until earlier rows clear. A later poll alone does not fix it.

Worker-acquired slow leases use a five-minute TTL and 60-second heartbeat.
This does not shorten `produce.next`'s self-acquired 90-minute lease. Heartbeat
timers are unref'd and cleared when handlers finish.

A restart marks leftover running action rows failed. Preserve failure notices:
`jobs.produce` records its new job ID there before rendering, and the operator
needs that ID for recovery. This repairs the action row, not the interrupted job
or its orphaned lease. Successful start/completion clears the notice.

`produce.next` retains the tick result even when it describes failure or a noop;
marking the action failed would discard that result. `scout.run` forces a fresh
attempt and records config-error noops as completed results. Confirmation flags
live in the catalog; they do not uniformly mean “this action spends money.”

### Config: channel TOML is the unit of everything

`prod/channels/*.toml` is the sole maintained source of truth. Compose mounts
it at `/app/state/channels`; tests create disposable channel fixtures.
`src/config/channel.ts` validates TOML with Zod and normalizes to camelCase.
The file basename must equal `name`, and declared channel names must be unique:
resume loads `<channelsDir>/<job.channel>.toml` by filename.

Keep top-level TOML keys before section headers. `platforms` is a top-level
array of unique `youtube`, `instagram`, and/or `tiktok` entries; empty means no
posting checklist and no inventory can count as fully posted. Removed
`[publish]`, `slots`, and `[scout] min_score` settings fail validation.
`videos_per_day` limits production; it is not a platform upload quota.

`backlog_days` (default 2) caps unconsumed finished inventory.
`[scout] queue_days` (default 3) caps candidate depth before a fetch. Neither
is an expiry timer. A channel without scout sources is fed manually.

`BRAINROT_ROOT` is required unless `--root` is supplied. `src/config/paths.ts`
derives `db/brainrot.db`, `runs/`, and `channels/` beneath it. There is no
implicit host root. Compose supplies `/app/state`; tests supply temporary roots.
Only `BRAINROT_ROOT` selects paths; obsolete path variables are ignored.

### The scout filters media before it reaches the scorer

The scorer sees titles, so media posts can look like narratable stories.
Reddit source parsing annotates `postKind`; `scoutChannel` decides what to drop.
Keep this split so scouting can report `droppedMedia` without changing the
`TrendSource.fetch` interface. Dropped candidates do not get topic rows.

The Atom entry's own link is the comments permalink. Classify the submission
from the target `[link]` inside `<content>` using `sources/post-kind.ts`.
Missing/unparseable targets fail open as `link`. Render target hosts into the
scoring prompt for ambiguous media links rather than growing a host blacklist.

Filter AutoModerator/moderator accounts via `isAutomatedAuthor` and report
`droppedAutomated`; recurring threads have fresh IDs and evade ordinary dedupe.
`topics.target_url` records the submission target separately from `topics.url`.
`topics prune-media` repairs older rows by fetching permalink `.rss` and
verifying the feed's ID against the stored dedupe hash before mutation.

### The third source invents topics rather than fetching them

`src/scout/sources/llm.ts` implements `TrendSource`, sharing the ordinary
scoring, dedupe, and insertion path. `[scout] generate_topics` enables it
(default 0, maximum 50). It uses `SCOUT_MODEL` and recent topic titles; normalized
headline text is its external ID, and URL is empty. Story channels reject it
because generated topics have no source body.

The queue-depth gate runs before fetching, so generation fills demand rather
than running on a separate schedule. Reserve estimated spend against the global
daily budget and ledger the actual `scout-generate` cost under `scout:<channel>`,
including paid schema-invalid responses, before scoring can fail.

Two configuration traps:

- A generator-only channel can report all sources failed when its budget gate
  throws, because that becomes a source error. Keep a feed source alongside it
  when that failure mode would be misleading.
- Keep `generate_topics <= per_source_limit`; the source clamps to the fetch
  limit rather than rejecting an oversized request.

### Story mode: channels that narrate reddit posts verbatim

`[story]` channels narrate Reddit self-post bodies from Atom `<content>`.
The body is assembled locally by `runStoryScript` (`src/stages/script.ts`);
the model response schema accepts only platform metadata, not narration.
The hook is still the scout's model-authored topic title. “Verbatim” refers to
the body source, with sanitization applied before narration.

`src/stories/` is pure: the architecture lint permits only `errors.ts` imports
from `src/` and bans direct database, filesystem, and network access.

Each story part is a separate `topics` row/job/video. Parts share `series_key`,
carry `body_text`, `part_index`, `part_count`, and `truncated`, and use a dedupe
hash suffixed with `#p<index>` even for part one. Preserve sentence/paragraph
boundaries. Oversized stories truncate at `max_parts` with an outro and source
link; short final tails merge into the preceding part. Changes to split limits
must still fit QC duration bounds.

`knownHashes` checks both series keys and per-part hashes; otherwise an existing
story can be fetched, scored, and billed again. `recentTopicTitles` uses one
representative per series so the novelty window counts stories, not parts.
Candidate depth is checked before fetching, so a batch can overshoot the nominal
queue limit, especially when each story generates multiple parts.

Channel validation rejects story RSS sources and generated topics because they
lack Reddit bodies. It also requires `max_parts <= videos_per_day * backlog_days`
so a series fits production capacity. This is not an age-out rule: videos do
not expire. Drop bodyless and automated-author candidates before scoring.

Sanitization applies to the body, hook, and metadata titles/descriptions, not
hashtags. Preserve meaning when extending substitutions; guard ambiguous
collocations or omit substitutions that change meaning.

Posting order is manual. The post queue sorts by creation time; there is no
per-platform predecessor gate. Work through parts in order.

Indexes on columns added to existing databases belong in `migrate.ts`, because
schema application runs before migrations. The read-only dashboard never
migrates; initialize/migrate through the daemon or a CLI database open before
relying on pages that query newly added columns.

### Budget enforcement is layered, not a single check

`src/jobs/costs.ts`'s `assertBudget` is called before every paid provider call
and checks, in order: per-video cap (`channel.budget.perVideoUsdMicros`) →
channel-day cap (UTC) → global-day cap (`BRAINROT_GLOBAL_DAILY_USD`, spans all
channels). A breach throws `BudgetExceededError` _before_ the call fires.
Providers that pay for a call that then fails downstream (e.g. a schema-invalid
LLM response) still have to ledger that spend. The provider tags the thrown
error via `tagError` (`src/errors.ts`) with `context: { costUsdMicros }`, which
leaves the error's identity intact — anthropic keeps throwing a real `ZodError`
so callers still match `instanceof z.ZodError` — and `src/providers/errors.ts`'s
`errorCostUsdMicros` reads it back.

### Errors: one vocabulary, two axes

`src/errors.ts` owns `BrainrotError`, `errorMessage`, `classify`, `tagError`,
`errorContext`, and `isAbortLike`. It imports nothing from `src/`; an architecture
lint protects that boundary. Domain classes stay with their owning modules.

Errors have a domain (`storage`, `provider`, `config`, `job`, `scout`, `internal`)
and kind (`auth`, `quota`, `budget`, `invalid`, `not-found`, `rejected`,
`conflict`, `refused`, `transient`, `unknown-outcome`, `internal`). Retry policy
belongs to the consuming operation; there is no universal retryable flag.

Classify operator-fixable failures. Invariant breaches remain plain errors and
classify as internal. `tagError` preserves an external error's identity, so
`instanceof z.ZodError` still works. A subclass narrowing `kind` must use
`declare readonly kind: ...`; an emitted ES2022 field would overwrite the
base constructor's assignment with undefined.

### Providers and the sidecar

`src/providers/*.ts` wrap external APIs (Anthropic for scripts, ElevenLabs for
premium voice, kokoro/edge-tts for the free voice fallback chain).
`src/providers/whisperx.ts` talks to the Dockerized WhisperX sidecar
(`docker-compose.yml`) for caption word-level alignment — needed whenever a
job's voice.json wasn't produced by a successful ElevenLabs synth (ElevenLabs
itself returns word timings directly, no alignment pass needed).

### Posting: manual, per platform

Posting happens by hand from `/post`. There is no upload adapter, OAuth grant,
credential store, publishing worker, or platform retry state machine.

`src/posts/types.ts` declares the platform vocabulary; `meta.ts` validates and
normalizes titles/descriptions/hashtags and composes paste fields. YouTube has
separate title/body/tags; Instagram and TikTok use one caption block.

A `posts` row means the video was actually posted to that platform.
`markPosted` is idempotent on `(job_id, platform)`: URL corrections must not
refresh `posted_at`. `unmarkPosted` deletes the row. The dashboard presents
paste fields for unposted platforms and saved links/unmark controls for posted
ones. Reclaim uses the same fully-posted predicate as inventory and the queue.

### The dashboard's read-only guarantee narrows, not disappears

`dashboard/` is the Next.js App Router frontend; `src/dashboard/` holds shared
query and HTTP helpers. The service runs without provider or bucket credentials and binds to host
loopback through Compose. Actions can spend provider budget and render videos;
keep the loopback binding. The footer identifies its explicit runtime root.

GET routes use `openDbReadonly`: no mkdir, schema application, or migration.
`POST /api/actions` uses a separate `openDbActions` handle for one queue insert;
the daemon performs the requested mutation. The database volume must remain
read-write even for GETs because SQLite WAL readers need shared-memory files.

Preserve both CSRF layers in `src/dashboard/csrf.ts`: same-origin proof and the
boot-generated token. The loopback Host allowlist additionally prevents DNS
rebinding; matching Origin and Host alone is insufficient. `sameSitePath` must
validate the normalized redirect target as well as raw input: `/..//evil.example`
can normalize into a protocol-relative external URL. The daemon-liveness 409
check is an operational guard, not an authorization boundary.

Queries return typed data without markup; React Server Components render it.
React escapes scraped text; `src/dashboard/links.ts` validates external link
schemes. Never use raw HTML for scraped content. Client components handle forms,
clipboard controls, and router refreshes. Stable row keys preserve drafts and
video elements across refreshes. `POST /api/actions` returns JSON acceptance
with an action ID; confirmation pages remain GET-only until submission.

Database openers live in `src/db/dashboard.ts` without schema or migration
imports; the dashboard must not import `src/db/index.ts`. Next reads
config and state at request time, never while building. Its launcher mints one
CSRF token shared through the server environment across Next bundles/workers.
Use webpack extension aliases for shared NodeNext `.js` source imports.
The lightweight `DASHBOARD_STAGE_ORDER` must agree with the pipeline (tested),
but importing `pipelineStages()` would pull rendering/provider code into HTTP.

Library byte states are `local`, `archived`, `reclaimed`, and `unstored`.
A missing `library_objects` row means never stored; a reclaimed row means its
stored bytes were deliberately removed. Do not confuse these for backfill or
local artifact deletion. The library's QC verdict comes from `library.qc_json`.

### Remotion rendering

`remotion/` is the actual video composition (React components rendered to
frames by `@remotion/renderer`), driven by `src/stages/assemble.ts` and
`src/stages/captions.ts`. It has its own `tsconfig.json` and is type-checked
separately in `pnpm build`, but is not a separate package — no independent
install/version.

### Data flow summary

SQLite lives at `<root>/db/brainrot.db`, in the `brainrot-data` named volume
in production. Never replace it with a macOS bind mount: WAL requires coherent
shared memory across all openers, and mixing host/VM kernels over virtiofs
previously corrupted state. Use container CLI commands for production access.
`busy_timeout=5000` handles concurrent daemon/dashboard/CLI connections.

The database holds jobs/stages, library/object metadata, topics/scout state,
costs, leases, posting records, operator actions, and daemon liveness. Artifacts
live under `<root>/runs/<jobId>/<stage>/`, bound to host `prod/runs/`.

`src/db/schema.sql` describes a fresh database and is executed on each
`openDb`. Existing-database changes belong in `src/db/migrate.ts`, called after
schema application. Each migration probes its precondition and must be
idempotent. Table rebuilds reuse schema.sql rather than duplicating DDL.
Data-dependent indexes and indexes over newly migrated columns belong in
migrate.ts so schema application cannot wedge an older database first.
`openDbReadonly` and `openDbActions` never apply migrations.

### Test layout and conventions

Tests are colocated (`src/**/*.test.ts`, plus `remotion/**`), in three tiers:
the default hermetic run, `*.contract.test.ts` (`CONTRACT=1`, real paid API
calls), and `*.storage.test.ts` (`STORAGE=1`, needs MinIO up via
`docker compose --profile test up -d --wait minio`). Storage tests use
`TEST_S3_*` overrides and a `brainrot-tests` bucket; production credentials
never select their store. Compose forwards only explicit production settings.
Voice selection is solely `[voice.premium]` or the free fallback chain; there
is no `--dev`, `voice.dev`, or development voice environment override.

**Layout:** more than three test files in a directory go into its `test/`
subdirectory; `src/` root is exempt for repo-wide tests. Prefer one behavior
file per module; split by genuinely different concerns, not size alone.

**`src/testing/` is the one shared testkit.** The test CLI build excludes it
from `dist/`; runtime code must not import it. Production runs source through
`tsx`, so the `dist/` exclusion is not a production isolation guarantee. Use
the shared helpers rather than re-rolling fixtures locally:

- `tmp.ts` — `tmpDir(prefix)`. **The only way to make a temp dir.** It registers
  for cleanup; `setup.ts` sweeps after each file. Use `testRoot()` when a test
  needs the runtime layout with `db/`, `runs/`, and `channels/`.
- `channel.ts` — `testChannel(overrides)` for the parsed config;
  `channelToml`/`channelTomlLines`/`writeChannelsDir` for the on-disk TOML.
  In `channelToml`, `bg_dir`/`bgm_dir` must stay ahead of every `[section]`
  header or TOML nests them under the last table and the values vanish.
- `job.ts` — `makeCtx(opts)`, `testScript`, `seedVoiceJson`/`seedWordsJson`/
  `seedScriptJson`.
- `db.ts` — `memDb()`/`fileDb()` (both auto-closed) and one seed builder per
  table, each `(db, id?, overrides?)`.
- `cli.ts`, `run-cli.ts`, `storage.ts` — subprocess and object-storage
  scaffolding; `anthropic.ts` and `reddit-feed.ts` supply provider/feed fakes.

Conventions:

- **Env only via `vi.stubEnv`.** `setup.ts` registers a global
  `afterEach(vi.unstubAllEnvs)`, so no file needs its own.
- **Pass subprocess settings explicitly through `runCli(args, { env })`.**
  The child inherits environment variables unless overridden. Explicit values
  keep tests independent of the developer's `.env`; use `storageEnvVars()`
  for fake storage configuration. Empty strings prevent dotenv from filling
  a key from the host file when testing missing configuration.
- One top-level `describe` named after the symbol under test. `it(`, never
  `test(`. Helpers at the top of the file or in a colocated `_*.fixtures.ts` —
  never buried between describes.
- Conditional tiers use `describe.skipIf`/`it.skipIf`. A bare `return` reports
  a **pass** for work that never ran.
- Keep real-config smoke tests separate from fixture-based schema tests.
- A `_<module>.fixtures.ts` holds what only that module needs, and **delegates
  row SQL to `src/testing/db.ts`** rather than re-issuing INSERTs. That is what
  lets a module keep an ergonomic local call shape (digest ages rows via
  `isoAgo`) without a second copy of the schema.
- Repo-wide architecture lints go in `src/arch.test.ts`. They are import-heavy
  by nature (proving module A must not load module B means loading B), so they
  are kept out of behavior files that would otherwise be instant.
- The eslint test-tier rule relaxation covers `**/*.test.ts`, `src/testing/**`
  and `**/_*.fixtures.ts` — stub adapters and untyped rows live in all three.

**Performance.** `scripts/vitest-sequencer.ts` starts known slow files first;
`src/testing/sequencer.test.ts` verifies its entries still name real files.
Use short, low-resolution media fixtures for selection/branching tests. Reserve
full-size encodes for output-contract tests, and encode shared fixtures once
in `beforeAll`. Measure the current suite before changing its scheduling;
historical test counts and timings are not acceptance criteria.

### Test-only build

Vitest global setup runs `scripts/build-test-cli.ts` to transpile `src/` into
a mirrored `dist/` tree for CLI subprocess tests. Do not bundle: CLI entrypoint
guards, schema lookup, and Remotion paths depend on `import.meta.url` and the
preserved directory depth. `pnpm build` remains type-checking only.

The builder copies `db/schema.sql`. CLI production runs source through `tsx`;
the dashboard uses its separate Next.js production build in `dashboard/.next`. No current spawned CLI
test reaches assembly; real rendering is exercised through stage/pipeline tests.

## Design docs

[README.md](README.md) is the current operator runbook;
[docs/development-audit.md](docs/development-audit.md) records the development
simplification and remaining release limitations.

`superpowers/specs/` and `superpowers/plans/` are optional, gitignored local
history. Consult them for rationale when present, but check claims against
current code: some describe removed publishing and development systems.
Do not make builds, tests, or required instructions depend on those files
being present in a clean checkout.
