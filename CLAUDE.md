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

```bash
pnpm install
cp .env.example .env          # provider keys — see README for which are required
docker compose up -d whisperx # caption-alignment sidecar (captions + ElevenLabs-fallback)

pnpm build                    # tsc --noEmit on both src/ and remotion/ — no emit, type-check only
pnpm test                     # vitest run — mocked providers, real ffmpeg/Remotion (~20s warm)
                               # a globalSetup esbuilds src/ -> dist/ first (~19ms);
                               # CLI tests spawn `node dist/cli.js` via src/testing/run-cli.ts
pnpm test:coverage            # same run + v8 coverage -> coverage/ (report-only, no thresholds)
pnpm test:contract            # CONTRACT=1 — real paid calls: ElevenLabs, one LLM call

pnpm brainrot produce --channel local/channels/<name>.toml --topic "..."
pnpm brainrot run                    # the demand-driven daemon: produce/scout/digest workers + the action lanes
pnpm brainrot scout | produce-next | digest  # one manual/debug unit of each, outside the daemon
pnpm brainrot jobs | costs
pnpm brainrot topics list|reject <ids...>
pnpm brainrot topics requeue <id>   # orphaned 'claimed' topic -> 'candidate'; refuses while a live job holds it
pnpm brainrot topics prune-media [--channel <name>] [--dry-run]  # re-check reddit candidates, reject image-sourced ones
pnpm brainrot library list|approve|reject <jobIds...>
pnpm brainrot library backfill-store   # upload finished videos with no stored object yet

# A bare `pnpm brainrot ...` on the host reads `local/` — unset BRAINROT_ROOT
# means local, and production is `/app/state` inside the container — an
# empty `jobs` table means wrong root, not a lost job. Production state lives
# in a container-only volume:
docker compose exec brainrot pnpm brainrot jobs   # read-only; safe while the daemon runs
# Mutating commands take no lease and race live workers — stop the daemon first:
docker compose stop brainrot && docker compose run --rm --no-deps brainrot pnpm brainrot resume <jobId>
# src/ is baked into the image, not mounted — code changes need a rebuild:
docker compose build brainrot
```

Run a single test file: `pnpm vitest run src/jobs/test/runner.test.ts`.
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

### One daemon, five workers share one SQLite file

`brainrot run` (`src/loop/daemon.ts`) is the container's `CMD` and the only
long-running process — there is no host cron and no per-loop container
anymore. It starts five workers concurrently: `produce`, `scout`, `digest`,
and a pair — `actions-fast` / `actions-slow` — covered in their own
subsection below. There is no `publish` worker: nothing in this codebase
uploads to a platform, so there is nothing left to schedule or back off.
Every worker shares one shape (`runWorker`): check demand →
do one unit of work → re-check immediately, so throughput follows demand,
not a schedule. An idle unit sleeps `IDLE_SLEEP_MS` (30s) before its next
check — `runWorker` takes a per-worker override, which is what lets
`actions-fast` poll at ~1s instead — and a unit that throws logs a
`worker-error` line and sleeps `ERROR_SLEEP_MS` (60s) instead of taking the
daemon down. Consecutive identical idle lines are deduped (keyed on the
emitted JSON) so a quiet night is silent rather than one line every 30
seconds forever — any worked unit or error resets the dedupe so the next idle
reason is still reported once. `digest` is the one pipeline
worker that isn't demand-driven: it's time-gated, firing once per local day
at or after `DIGEST_HOUR` (08:00), with an in-memory guard so a same-day
restart can re-fire it once — acceptable for a read-only report whose only
delivery is the log stream.

`produce` wraps `src/loop/produce-next.ts`, which still does **one unit of
work per call** — the daemon's poll loop controls throughput now, not cron
cadence, but the tick function's own shape is unchanged. It:

- takes a named lease (`src/loop/lease.ts`, `leases` table, name `produce`)
  so only one process is doing that kind of work at a time; a held lease is a
  normal no-op, not an error. This now guards **daemon-vs-manual-CLI** races
  rather than daemon-vs-daemon ones — see "outside these leases" below.
  `scout` takes the only other lease (name `scout`, 30-min TTL, acquired
  inside `scoutUnit`) and prints the same `lease-held` noop line. There are
  two lease names in the whole codebase: `produce` and `scout`.
  `produce-next` heartbeats its lease at every stage start (`runJob`'s
  `heartbeat` option, threaded through `resumeJob` as well) so a render
  longer than the TTL is not taken over mid-flight.
- runs an idempotent **repair sweep** at the top of the lease window to heal
  state left inconsistent by a crash between two writes that should have been
  atomic — a topic left `claimed` after its job already landed in `library`.
- reads `channels/*.toml` fresh every unit — via `tryLoadChannelsDir`, before
  the lease: a broken TOML is reported as a `config-error` noop line rather
  than thrown, because a unit that throws logs a `worker-error` line, not a
  structured noop.
- runs a **reclaim sweep** in the same lease window, skipped entirely when
  object storage isn't configured (`s3ConfigError() === undefined` gates it):
  `posts/reclaim.ts`'s `reclaimableObjects` finds every video in the channel
  whose stored object is still in the bucket but has already been posted to
  every platform the channel declares (a plain `COUNT(*) FROM posts ... >=
  declared.length` correlated subquery — no age clause, no "settled" state
  machine; see "Config" below for why the old aged-out horizon needed none of
  that either), and `reclaimObjects` deletes the object and stamps
  `reclaimed_at`. The `library_objects` row survives reclaim so
  `unstoredLibraryJobs` can still tell "reclaimed" from "never stored" by row
  absence, which is what stops `library backfill-store` from re-uploading
  what this sweep just deleted.

Object storage itself is **optional**, not required to produce. The `store`
stage (`src/stages/store.ts`), which runs last in the pipeline, no-ops and
logs rather than throwing when `s3ConfigError()` is set — an unconfigured
deployment still produces a normal `ready`/`needs-review` job, it just has no
cloud copy and the video lives only under `runs/`. `produce`'s CLI command
warns to stderr on the same condition rather than refusing (`src/cli.ts`).
This replaced an earlier fail-fast design (design spec §3.5 predates the
removal of the publish pipeline, when Instagram's upload required a publicly
reachable URL); nothing in this codebase requires that anymore.

`produce-next` asks `planTick` (`src/loop/plan-tick.ts`) whether to resume a
blocked job or claim+produce a new topic. `planTick` skips a channel holding
`ceil(videos_per_day × backlog_days)` unconsumed videos (`pendingInventory`,
`jobs/library.ts`) and reports `backlog-full` — "unconsumed" now means "not
yet posted to every platform the channel declares", a plain row-existence
check against `posts`, not an age-based definition. `backlog_days` (default
2) is consequently a pure **production depth cap**: hold too much unposted
video and production pauses for that channel until the operator posts or
discards some of it. There is no aged-out horizon anymore — nothing deletes a
video for sitting in the queue too long; the operator's `library.reject`
("discard") is the only way a video that will never be posted stops counting
toward the cap.

Manual **CLI** commands (`produce`, `resume`,
`library approve/reject`, `topics reject/requeue`)
deliberately run **outside** these leases — they are operator actions that can
race a live daemon worker if the daemon container isn't stopped first. This is
the CLI path only, and it is deliberate: the CLI is the break-glass tool and
has to work when the daemon is down or wedged, which is exactly when it is
needed.

The **dashboard** path does not have this property. Its controls enqueue into
`operator_actions`, which the daemon's `actions-fast` / `actions-slow` workers
drain in-process, taking the same leases — so a dashboard-triggered
`jobs.resume` waits for the produce lease instead of racing a render. Prefer
the dashboard for routine operator work; reach for the CLI when the daemon
itself is the problem.

The scout side gates on score rather than a window: `scoutChannel` stores
only topics scoring at or above `SCOUT_MIN_SCORE` (80, a code constant in
`src/scout/scout.ts`) — a channel TOML that still sets the old `min_score`
key is a load error naming the replacement, same treatment as a stale
`slots` key. `scoutChannel` also owns a per-channel recheck cadence,
`SCOUT_RECHECK_MS` (20 minutes, also in `src/scout/scout.ts`), so a quiet
subreddit isn't refetched on every 30-second idle poll — backed by the
`scout_state` table (one row per channel, last-attempt timestamp) rather than
in-memory state, so it survives a daemon restart. Because the gate lives
inside `scoutChannel`/`scoutAll` rather than in the daemon's `scoutUnit`, it
applies equally to a manual `pnpm brainrot scout` run — pass `--force` to
bypass it immediately. `scoutUnit` (`src/loop/daemon.ts`) is consequently a
thin wrapper like `produceUnit`, carrying no scheduling state of its own: it
calls `scoutAll` on every configured channel every poll and maps the result
(reporting `queue-full` when at least one channel hit the depth gate, staying
silent when every channel is simply not due for a recheck yet — the common
case). The queue-depth gate itself (`skipped: 'queue-full'`) is
unchanged, and sits alongside a sibling `skipped: 'recheck-not-due'`.
`scoutChannel` returns `skipped: 'queue-full'` before fetching or scoring
anything once a channel has `ceil(videos_per_day × queue_days)` candidate
topics.

The digest carries a **topic-starvation** action item: a
channel that both scouts (any of `subreddits`, `rss`, `generate_topics`) and
declares `platforms`, holding 0 candidate topics AND 0 unposted videos, will
stop producing the moment its backlog drains, and every other line in the
digest would stay quiet about it. Channels with no scout sources are
excluded — they are fed by manual `brainrot produce`, where an empty queue is
normal.

### The operator-action queue: two more workers, drained fast and slow

The dashboard's only write is an `INSERT` into `operator_actions`
(`src/db/schema.sql`, alongside a one-row `daemon_state` liveness table). Two
more daemon workers, `actions-fast` and `actions-slow`, drain that queue
in-process **under the same leases the `produce` and `scout`
workers take** (`digest` takes no lease at all) — this is what makes a
dashboard-triggered mutation race-free where the equivalent CLI command is
not (see "outside these leases", above).

`src/actions/` is split three ways by what may import it: `catalog.ts` is
pure metadata (`kind`, `lane`, label, zod arg schema, `confirm` flag, the
lease it needs) with no heavy imports, read by **both** the dashboard (to
render forms and validate submitted args) and the daemon; `handlers.ts` holds
the `run` implementations for today's thirteen actions — it imports
`approveLibrary`/`rejectLibrary`/`deleteRejectedObjects`, `buildDigest`,
`markPosted`/`unmarkPosted` (`src/posts/posts.ts`),
`rejectTopics`/`requeueTopic`, `createJob`/`runJob`, `backfillStore`,
`pruneMedia`, and `produceNextTick`, `scoutAll` and `resumeJob` — and is
imported **only** by the daemon. The pipeline, scout and storage imports are
what make the arch lint below matter more than it did: they reach Remotion,
the provider clients or the object-storage SDK transitively, so a single
import of this module from the dashboard would pull all of it into the
unauthenticated HTTP process. `queue.ts` is the DAO (`enqueueAction`,
`pendingActions`, `startAction`, `completeAction`, `failAction`, `setActionNotice`,
`getAction`, `listRecentActions`, `failRunningActions`) — there is no
`claimNext`; `pendingActions` plus `startAction`'s `status = 'pending'` guard
together serve that role.

The split is load-bearing, not organizational, the same discipline
`DASHBOARD_STAGE_ORDER` already follows: the dashboard is the one process
that terminates unauthenticated HTTP and must never pull in Remotion,
Anthropic, or credential code. An arch lint in `src/arch.test.ts`
("dashboard action isolation") walks `src/dashboard/**`'s imports
**transitively** — a real DFS over the module graph, not a substring grep —
and fails if any path reaches `src/actions/handlers.ts`.

Thirteen actions exist today, six `fast` and seven `slow`. Fast is
`topics.reject`, `topics.requeue`, `library.approve`, `digest.run`,
`post.mark` and `post.unmark` — local SQLite writes plus, in `digest.run`'s
case, a config-directory read, never a network call, a provider call or a
render, and never a lease: no fast action leases anymore, since the two that
used to (mutating `publishes` rows) are gone with that table. Slow —
anything that can take seconds or minutes — is `produce.next`, `jobs.produce`,
`scout.run`, `jobs.resume`, `library.reject`, `library.backfillStore` and
`topics.pruneMedia`. `library.reject` lives here rather than in fast because
its handler makes real network calls (a dynamic S3 import plus one
`store.delete()` per object, sequentially) that a slow or unreachable bucket
could stretch long enough to stall the fast lane's heartbeat and trip the
dashboard's 409 liveness gate mid-discard.

Of those seven slow actions, four declare a lease and three declare none.
`jobs.produce` and `jobs.resume` take `produce`; `scout.run` and
`topics.pruneMedia` take `scout`; `produce.next`, `library.reject` and
`library.backfillStore` take none. `jobs.produce` sitting beside
`produce.next` is the clearest statement of the lease rule in the whole file:
`produceNextTick` acquires `produce` *inside itself*, so `produce.next`
declaring the lease here would make the worker hold the very lease the tick
then fails to take, turning every click into a green `lease-held` noop —
which is why it declares none. `runJob`, by contrast, does not lease on its
own (the CLI's `produce` command runs outside every lease on purpose, same as
`resume`), so `jobs.produce` declaring `produce` here is what makes the
dashboard's version race-free against the daemon's own produce worker,
exactly where the CLI path is not.

Seven route through the confirm interstitial (`confirm: true`):
`produce.next`, `jobs.produce` and `jobs.resume` — the ones that render and
spend — plus `library.reject` ("discard") and `post.unmark`, both
data-losing rather than slow or costly, plus two added this phase for a
third reason each: `library.backfillStore`, which can upload a lot of bytes
at whatever an operator's object storage charges per byte, and
`topics.pruneMedia`, which runs for minutes and bulk-rejects scouted topics
(its `dryRun` flag is the safer alternative the interstitial's danger text
points to). Note the gap the other way: `scout.run` fires on one click and
does spend (scoring, plus generation where `generate_topics` is set) yet has
`confirm: false` — `confirm` tracks the irreversible, data-losing or costly,
not "costs money" or "is slow" alone.

The `notice` column follows a similar asymmetry: `startAction` and
`completeAction` clear it, but the two failure transitions (`failAction`,
`failRunningActions`) deliberately do not. `jobs.produce` mints its job id
*inside* the handler and publishes it through `ctx.setNotice` the instant it
exists; if the process dies mid-render, the action row goes `failed` but the
notice is the only place left naming the job the operator can still resume.
`topics.pruneMedia` is the first end-to-end proof that a running handler's
`setNotice` call reaches the row while the handler is still executing and
survives it throwing — closing out what had been true in principle but
untested.

`actions-fast` drains up to
`MAX_FAST_DRAIN` (50) pending rows per poll on its ~1s idle sleep so a
checkbox click feels immediate, and also carries the daemon heartbeat
(stamping `daemon_state`, throttled to `DAEMON_HEARTBEAT_MS` so a 1s poll
doesn't churn the WAL) that lets the dashboard tell "queued" from "queued
into the void." `actions-slow` claims and completes at most one row per poll
on the standard 30s sleep, so one long action can never block the poll that
would report it.

That heartbeat is also a gate, not just a banner: `POST /actions` refuses with
**409** while `daemon_state` is stale (`DAEMON_STALE_MS`, 60s — six missed
beats), because a row queued against a dead daemon is a lie twice over. Nothing
drains it, and on restart the whole backlog fires at once, which on the slow
lane means a pile of renders. The probe runs on its **own** `openDbReadonly`
handle, opened and closed before the write handle exists, so the structural
claim in "the dashboard's read-only guarantee" below stays literally true — the
entire write path is still one `INSERT`. A database it cannot read at all fails
closed, the same conclusion a missing `daemon_state` row already draws.

An action whose required lease (`produce` or `scout` — named
exactly as the other workers name them) is already held is **skipped, not
awaited**: it stays `pending`, explains itself through the row's `notice`
column ("waiting for the produce lease"), and is retried on the next poll.
Taking the head of the queue and blocking on it would let one long render
stall every trivial mutation behind it — the head-of-line problem the two
lanes exist to prevent. A lease found held is remembered in a per-poll skip
set, so every later row in the same poll wanting that same lease is passed
over without re-attempting it: `acquireLease` opens a `BEGIN IMMEDIATE` write
transaction, and on the fast lane's 1s poll a queue of blocked rows would
otherwise be up to 50 write transactions a second of pure WAL churn for a
lease that is plainly not going to free mid-poll. The skip also leaves those
rows entirely untouched — no repeated `notice` write — which is the property
`src/loop/test/actions-worker.test.ts` pins by asserting only the first
blocked row carries a notice.

Each poll's scan window (`ACTION_SCAN_WINDOW`, set to `MAX_FAST_DRAIN`) gives
the slow lane (completion budget 1) a genuine 49-row margin (window 50 minus
the 1 completion it needs), so a couple of consecutive lease-blocked rows
can't idle it with runnable work sitting behind them; the fast lane's own
completion budget already equals `MAX_FAST_DRAIN`, so its scan window is
equal, not wider — the source comment in `src/loop/actions-worker.ts` calls
that shared value a coincidence, not a coupling. The skip set does **not**
widen that window: it removes redundant acquires, not the bound, so 50 rows
all blocked on `produce` still means row 51 was never in the query's result
set and does not run this poll. Left deliberately — it self-heals on the next
poll, and a 50-deep queue on one lease is not a shape one operator clicking
buttons produces.

No fast action takes a lease anymore. The two that used to
(`publish.retry`/`publish.markDone`, mutating `publishes` rows, each holding
it for a short `FAST_ACTION_LEASE_TTL_MS` rather than the lease's own long
TTL) were deleted along with the `publishes` table; `post.mark`/`post.unmark`
mutate `posts`, a table no worker touches, so there is nothing left to race
and nothing to lease.

The slow lane cannot use one fixed short window, because a render legitimately
runs for minutes. It instead takes a short `SLOW_ACTION_LEASE_TTL_MS` (5 min)
and pushes it out every `SLOW_ACTION_HEARTBEAT_MS` (60s) from a `setInterval`
that lives exactly as long as the handler — five beats per TTL, which is the
tolerance for a synchronous stretch that starves the event loop, and the timer
is `unref`'d so a pending beat can never hold the process open past SIGTERM.
The mitigation covers only the two slow actions that declare a lease at all —
`jobs.resume` (`produce`) and `scout.run` (`scout`), below: a SIGKILL
mid-render heals the action row (`failRunningActions`) but not the lease, and
`produce`'s own TTL is 90 minutes, so without this short window `jobs.resume`
would stall the daemon's produce worker for 90 minutes rather than 5.
`produce.next` — what an operator would call "the render button" — declares
**no** lease here (see below): `produceNextTick` self-acquires `produce`
with that lease's own 90-minute TTL, so a SIGKILL mid-tick still orphans the
lease for the full duration. The short TTL mitigates 2 of the 3 slow
actions, not the slow lane as a whole.

Which slow actions declare a lease is deliberately **not** uniform.
`scout.run` declares `scout` and `jobs.resume` declares `produce`, because
neither `scoutAll` nor `resumeJob` leases on its own — the CLI's `scout` and
the daemon's `scoutUnit` each wrap `scoutAll` in the lease themselves, and the
CLI's `resume` runs outside every lease on purpose, which is exactly the race
the dashboard path must not have. `produce.next` declares **none**, and that
is the interesting case: `produceNextTick` acquires `produce` internally, so
declaring the lease here would make the worker hold the very lease the tick
then fails to take — every click would record a
`{action:'noop',reason:'lease-held'}` result and call it a success.

Two slow-handler behaviours are worth knowing before reading a result row.
`produce.next` (the one tick action left) records the tick's own result
**verbatim**, including a `status: 'failed'` JobResult and a `lease-held`
noop — `failAction`
stores no `result`, so failing the action would throw away the very JobResult
the operator queued it to read. And `scout.run` treats a broken channels
directory as a `{action:'noop',reason:'config-error'}` recorded `done`, not a
failure: `digest.run` folds the same `tryLoadChannelsDir` error into its
result, `produce.next` passes through its own `config-error` noop, and the
CLI's `scout` exits 0 on it, reserving exit 1 for a `ScoutRunFailedError` from
`scoutAll` itself. `scout.run` also passes `force: true` unconditionally — an
operator clicking "scout now" means now, and `SCOUT_RECHECK_MS` would
otherwise swallow the click.

A `running` row left behind by a daemon crash is swept to `failed` once per
worker start, with no age threshold — within one process, a `running` row on
the very first poll can only be from a dead process, so there is nothing to
guess. The row's `error` message says "interrupted by a daemon restart", but
its `error_kind` is `'internal'` — `'interrupted'` is not a member of this
codebase's `kind` vocabulary (`src/errors.ts`) at all; the word appears only
in the message text, not the classification.

### Config: channel TOML is the unit of everything

Each channel is one `channels/<name>.toml`, loaded by `src/config/channel.ts`
through a zod schema with defaults, then normalized into camelCase
`ChannelConfig`. `loadChannelsDir` enforces an invariant the whole daemon
depends on: **the file's basename must equal the TOML's `name` field** —
`resumeJob` resolves a job's channel config by filename
(`<channelsDir>/<job.channel>.toml`), so a mismatch would silently wedge
resume. Duplicate declared names are also rejected at load time. One with no
`[scout]` table is never scouted (manual `produce` still works).

Target platforms are a flat top-level array, not a nested table:
`platforms = ["youtube", "instagram", "tiktok"]`. It's the checklist the
`/post` page renders and the set `pendingInventory` measures "fully posted"
against — not a schedule and not a credential, since nothing in this
codebase uploads anywhere. An empty list (the default) means "not decided
yet": the channel still produces, it just has no posting checklist yet, and
every unconsumed video counts toward its backlog. `platformsSchema` rejects
an unknown platform or a duplicate entry by name, not with zod's generic
enum message, so an operator who mistypes one is told what they actually
typed. A channel TOML that still declares a `[publish]` table is a load
error naming the replacement (`the [publish] table was removed — declare
targets as a top-level platforms = [...] instead`) — there is no per-platform
options sub-table anymore (no `privacy`, `category_id`, `ig_user_id`, ...:
nothing here calls a platform API, so there is nothing for those options to
configure). A stale `slots` key at either level, or a stale `[scout]
min_score` key, is a load error naming its replacement too (`slots` ->
`videos_per_day`; `min_score` -> the code constant `SCOUT_MIN_SCORE`).

Config load does **no** platform math on `videos_per_day`. There used to be a
third whole-directory invariant, `assertQuotaHeadroom`, rejecting a channel set
that declared more videos/day than a platform's cap allowed; it is deleted,
because that cap was only ever a guess an unimplemented upload path could not
enforce. `videos_per_day` is pure demand — a channel may declare more than an
operator can realistically post by hand, and the surplus simply piles up
against `backlog_days` until production pauses for that channel.

`backlog_days` (default 2) is a pure **production depth cap**, not an
aged-out horizon — nothing in this codebase deletes a video for sitting in
the queue too long anymore. It caps how many finished, unposted videos
(`pendingInventory`, `jobs/library.ts` — a plain count against `posts`) a
channel may hold before `produce-next` stops producing more for it; the only
way a video stops counting is the operator posting it (on every declared
platform) or discarding it (`library.reject`). `[scout] queue_days` (default
3) is its scout-side analogue, capping how many scored candidate topics a
channel may hold queued before `scout` stops fetching and scoring more for
it.

`BRAINROT_ROOT` is the single path knob, resolved by `src/config/paths.ts`
into `<root>/db/brainrot.db`, `<root>/runs`, and `<root>/channels`; unset
means `local`. The four separate path variables it replaced are gone and now
inert — a `.env` still setting one of the old names is silently ignored, not
a startup error. They lived weeks, not years, so the compatibility guard
that used to name the replacement was cut rather than carried as debt
(`44bba57`).

### The scout filters media before it reaches the scorer

The scorer sees titles, not posts, so an astrophotography submission reads as
a strong topic — "Milky way over Yosemite with a climber on El Capitan" scored
89 — and the resulting video has a picture where its story should be.

Reddit candidates therefore carry a `postKind` derived from the submission
target, which the feed exposes as the `[link]` anchor inside each entry's Atom
`<content>` (the entry's own `<link>` is the comments permalink, identical for
a photo and a story). `sources/post-kind.ts` classifies that target as
`image`, `self`, or `link`.

The split of duties matters: `redditSource` **annotates**, `scoutChannel`
**decides**. A source that filtered internally could not report how many it
dropped, and widening `TrendSource.fetch` to return a count would impose the
concern on `rssSource`, which has nothing to drop. So the drop sits next to
the dedupe filter that already lives in `scoutChannel`, and surfaces as
`droppedMedia`. Dropped items get no `topics` row — re-dropping them next tick
is free, and the table keeps meaning "things we actually considered".

The same split handles AutoModerator's recurring scheduled threads ("All Space
Questions thread for week of …", "Basic cosmology questions weekly thread" —
four in one r/cosmology fetch, all `/u/AutoModerator`, verified 2026-07-27).
Every week's instance is a distinct `t3_` id, so dedupe never catches them and
they would cost a scoring slot forever. `feed.ts` reads Atom's `<author><name>`,
`redditSource` strips the `/u/` prefix, and `scoutChannel` drops them as
`droppedAutomated`. Keying on the bot account rather than title patterns means
no per-channel config and no false positives on a human asking a real question.

The ambiguous tail is not guessed at. `app.astrobin.com` is an image host with
no file extension; `youtu.be` is a media link that can still be a strong
topic. Rather than maintain a host list for these, the target *host* is
rendered into the scoring prompt (`candidateLine`) with a rule that a
photograph is not a story. The classifier itself fails open — an absent or
unparseable target is `link`, never `image` — because dropping is the
destructive outcome and needs positive evidence.

`topics.url` is the comments permalink, so `target_url` was added to record
what a post actually points at. Rows predating it are recovered by
`brainrot topics prune-media`, which re-fetches each permalink's `.rss`
(**not** `.json` — that 403s unauthenticated) and verifies identity by
rehashing the feed's own `t3_` id against the row's `dedupe_hash` before
touching anything.

### The third source invents topics rather than fetching them

`llmSource` (`src/scout/sources/llm.ts`) is a `TrendSource` like the other
two: `scoutChannel` builds it from a descriptor, its output joins the same
candidate list, and everything downstream — scorer, the `SCOUT_MIN_SCORE`
gate, dedupe, `insertTopics` — is untouched. Fitting it behind the existing
seam rather than beside it is what makes a channel with no reachable feeds
still a normal channel. It is gated on `[scout] generate_topics` (int 0-50,
default 0 = off), and asks Haiku (`SCOUT_MODEL`, the scorer's own model) for
that many headlines given the channel's `niche` and `recentTopicTitles` — the
same 30-title window the scorer uses, so the generator avoids what is already
queued and the scorer independently zeroes anything near-duplicate that slips
through. A generated topic has no source page, so its **normalized title is
its `externalId`** (lowercased, whitespace collapsed) and `url` is `''`: exact
regenerations dedupe through the ordinary `dedupeHash(sourceId, externalId)`
with no special case.

It is structurally a drought-filler, with no priority logic anywhere: the
queue-full gate runs *before* any source fetches, so generation fires only
while the candidate queue is under `ceil(videos_per_day × queue_days)`. Spend
is ledgered as operation `scout-generate` under the same `scout:<channel>`
sentinel job id scoring uses, reserved against the global day cap
(`assertGlobalDayBudget`, `ESTIMATED_GENERATE_COST_MICROS`) before the call
and trued up after; a paid-but-schema-invalid response is recovered through
the thrown error's cost tag exactly as `scoreWithLedger` does, and recorded
before the scoring transaction so a later scoring throw can never lose it.
A `[story]` channel declaring `generate_topics` is a load error — a generated
topic has no post body to narrate.

Two traps are worth stating because neither announces itself:

- **Keep an `rss` source declared alongside `generate_topics`.** The
  generation budget gate throws *inside* the per-source try, so a breach
  degrades to one `sourceErrors` entry — indistinguishable from a dead feed.
  On a channel where the generator is the only source, that single entry makes
  `failedSources === totalSources` and `scoutAll` raises
  `AllSourcesFailedError`: a budget cap doing its job reads as a total outage
  and exits 1. (`scoutAll` deliberately counts the llm descriptor in
  `sourceCount`, which is also what makes an llm-only channel scoutable at all
  instead of silently skipped as "no `[scout]` sources" — the counting is
  correct, the degenerate single-source case is the trap.)
- **Keep `generate_topics <= per_source_limit`.** `llmSource` clamps its
  request to `min(count, fetchOpts.limit)`, and that limit *is*
  `per_source_limit` (default 25), so a larger `generate_topics` is silently
  truncated rather than rejected at load.

### Story mode: channels that narrate reddit posts verbatim

A channel with a `[story]` table (`max_parts`, default 4) narrates reddit
self-posts instead of scripting niche topics — but the headline property is
narrower than that sentence implies: it is the story's **body** that cannot
come from a model, not the whole narration. The first spoken line, the hook,
is still model-authored — in story mode it is `ctx.topic`, the scout scorer's
own retitling of the post ("AITA for blocking a car in?"), sanitized like
everything else but not reddit's original text. The bodies themselves need no
extra fetch: reddit's Atom `<content>` already carries the full selftext
inside an `<!-- SC_OFF -->`/`<!-- SC_ON -->` span, so there is no second
request and no API key. `src/stories/` (`body.ts`, `split.ts`, `sanitize.ts`)
is pure — an arch lint in `src/arch.test.ts` holds it to importing nothing
from `src/` except `errors.ts` and bans direct db/fs/network access, so a
future change that reaches for the database from inside a "pure" module fails
loudly instead of quietly compromising the guarantee below.

What actually makes "verbatim" true is structural, not a prompt instruction:
`runStoryScript` (`src/stages/script.ts`) assembles `segments` locally from
the post text, and the schema its one model call is validated against
(`storyMetaSchema`) accepts only `platformMeta` — there is no field in the
response the model could put narration into even if it tried. That is why the
guarantee survives a future prompt rewrite rather than depending on one being
worded carefully.

The load-bearing design choice is **one `topics` row per part**. A post too
long for one Short is split on sentence boundaries into up to `max_parts`
parts, each its own row with `body_text`, `series_key`, `part_index`,
`part_count` and `truncated`, each its own dedupe hash (`externalId + '#p' +
partIndex`, 1-based, on every part including the first). The split also keeps
the source's paragraph breaks (`\n\n`) rather than flattening a part into one
run-on span — before this, every story part rendered as a single unbroken
~160-word segment; the preserved breaks are what makes `storySegments`' split
real and give TTS a pause cue. One job therefore
still equals one video, which is why nothing in `jobs/`, `library`, `store` or
`qc` needed to change. All parts share one score, so `eligibleTopic`'s
existing `score DESC, created_at ASC, id ASC` produces them in order for free.
Over-long stories are **truncated, not rejected** — the last part appends a
spoken outro and the permalink goes in every platform description. A final
part landing under `STORY_MIN_TAIL_WORDS` (50) is a different problem and gets
a different fix: `splitStory` merges it into its predecessor instead of
shipping it alone, because `qc.ts`'s `minMs` (15s) is otherwise unconnected to
the split — measured on real feeds, 19% of story bodies ended with a final
part short enough to fail that floor, land the job `needs-review`, and never
publish, after already paying for synth and render. The merge bounds the
combined part at `STORY_WORDS_PER_PART + STORY_MIN_TAIL_WORDS - 1` words (160
+ 50 - 1 = 209), comfortably inside qc's `maxMs` — a future change to either
constant needs to keep clearing that bound. Two
deterministic drops guard the queue ahead of scoring: `droppedBodyless` (no
selftext — this is r/AskReddit, whose stories live in comments the feed does
not carry) and a moderator-account test now folded into `isAutomatedAuthor`
(a suffix match — `AITAMod`, `ModTeam`, `AskHistorians-Mods` — since a
per-subreddit mod team, not just `/u/AutoModerator`, posts the recurring
announcement threads that would otherwise burn a scoring slot every week).

Three load-time invariants join the existing two (filename == `name`, and no
duplicate declared name — the third, `assertQuotaHeadroom`, is gone): `[story]`
with `scout.rss` sources is an error (an RSS item has no body), `[story]` with
`[scout] generate_topics` is an error for the same reason (a generated topic
has no post body either), and `max_parts <= videos_per_day * backlog_days` — a
series drains at `videos_per_day` per day, so a longer one would have its tail
age out mid-series and strand viewers on part 2.

Sanitization (`stories/sanitize.ts`, an algospeak substitution map) runs on
the way into `script.json`, and on more surfaces than "narration" suggests: it
runs on the body, on the spoken hook, and on the model-written `platformMeta`
title/description, because those are published text that platform moderation
compares directly against the audio — a raw flagged word in a title while the
narration speaks the euphemism is exactly the mismatch that draws review. It
deliberately does **not** run on hashtags: substituting inside one produces a
broken hyphenated tag (`#suicide` -> `#self-deletion`), so a whole-word tag
like `#kill` ships unsubstituted while the audio says "unalive" — an accepted
risk, not an oversight. The substitution map itself is small and hand-curated
by necessity: it went 21 entries -> 17 (pre-flight) -> 15 (review), plus a
particle guard on `died` (`"died down/out/off/away"` are senses distinct from
the base verb — "died out" -> "passed out" means *fainted*, not deceased). Six
candidates were rejected outright for changing a sentence's meaning rather
than softening it (`abuse -> mistreatment` breaks as a verb; `death ->
passing` turns "death threats" into "passing threats"), and four low-frequency
collocation leaks are accepted and enumerated in the code comment rather than
guarded against. The rule applied throughout, because a word map cannot see
collocation: *drop or guard what changes meaning, tolerate what is merely
clunky*.

Story mode also breaks `queue_days` as a meaningful depth dial: measured
against a cap of 2, a single scout tick inserted 9 candidate rows (still
bounded — the next tick correctly reported `queue-full`). The bound is
`per_source_limit x subreddits x max_parts`, so 50-100 rows against a
`videos_per_day` of 6 is normal, not a bug — topic mode already overshoots its
nominal cap for the same pre-fetch-gate reason, and story mode multiplies that
overshoot by `max_parts`.

`recentTopicTitles` collapses a series to one representative row (its lowest
surviving `part_index`, suffix stripped) rather than counting every part, for
the same reason: left uncollapsed, the scorer's near-duplicate window counted
parts, not stories, so a 30-row window covered only ~9 distinct stories while
near-identical `X (i/N)` titles crowded the prompt. It is the same unit-shift
trap as the `queue_days` overshoot just above — a depth or window sized in one
unit (stories, queue slots) silently measured in another (rows, parts) —
worth naming twice since a third instance of it is likely.

Posting a series is an **ordered** operation, but the ordering is no longer
enforced as a hard gate — there is no scheduler left to enforce it against.
`channelVideoCandidates`, which used to block part N on a platform until part
N-1 was `done` there, is gone with `src/publish/schedule.ts`. What is left is
`listPostQueue`'s (`src/dashboard/queries/post.ts`) `ORDER BY created_at ASC`:
parts are produced in order, so the `/post` page naturally lists them in
order, and working down the page top-to-bottom is what keeps a series posted
in sequence without the operator having to track it by hand. A permanently
unposted part 1 no longer strands its successors on any timer — nothing ages
a video out anymore (see "Config" above) — it just sits at the top of the
queue until the operator posts or discards it.

Two schema/migration invariants are worth stating because both were nearly
violated during implementation. The story indexes (`ix_topics_job`,
`ix_topics_series`) live in `migrate.ts` rather than `schema.sql`, even though
the story columns themselves are declared in `schema.sql`: `openDb` execs
`schema.sql` **before** calling `migrate`, so an index over a column that only
`migrate.ts`'s `ALTER TABLE` adds to an *existing* database would throw on
every such database and wedge the entire CLI. And `knownHashes` must consult
`series_key` as well as `dedupe_hash`, because a queued story writes only
per-part suffixed hashes — without the `series_key` check every part of an
already-queued story would look unseen on the next tick and be re-scored and
re-billed forever.

One deploy-order note: the dashboard opens the database through
`openDbReadonly`, which never runs `migrate` (it must stay write-free). A
dashboard process reaching a database that no `openDb` call has touched since
this change lands will 500 on `/topics` with `no such column: body_text`. The
property is pre-existing — `target_url` has the identical failure mode — and
this merely widens it; bring the daemon (or any CLI command) up at least once
before relying on the dashboard's topics page.

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

`src/errors.ts` is the single error vocabulary, and it imports nothing from
`src/` — every layer imports it, so a dependency there becomes a dependency
everywhere (an arch lint enforces this). It exports `BrainrotError` plus
`errorMessage` / `classify` / `tagError` / `errorContext` / `isAbortLike`.

Every error carries two axes: a `domain` (`storage`, `provider`,
`config`, `job`, `scout`, `internal` — `'publish'` is gone along with
`src/publish/`; nothing left throws it) and a `kind` (`auth`, `quota`,
`budget`, `invalid`, `not-found`, `rejected`, `conflict`, `refused`,
`transient`, `unknown-outcome`, `internal`), so a surface can match at either
width. `kind` is untouched by the publishing removal — `auth` still describes
a real condition elsewhere (`kind: isAuthStatus(...) ? 'auth' : 'transient'`
in both `providers/elevenlabs.ts` and `providers/whisperx.ts`); `quota`
currently has no live throw site (the platform quota responses it used to
classify went with the adapters), but it stays in the vocabulary rather than
being pruned reactively — a future provider integration is the more likely
next user of it than a resurrected publish path. There is
deliberately no `retryable` flag: `transient` retries next tick, `budget`
retries after a cap change, and `unknown-outcome` never — retry meaning
belongs to each surface.

The concrete classes stay co-located with the domain they describe
(`StorageError` in `storage/types.ts`,
`BudgetExceededError` in `jobs/costs.ts`, `ResumeError` in `jobs/resume.ts`,
the scout trio in `scout/scout.ts`) and extend the base. `src/errors.ts` owns
the vocabulary, not every error object. A subclass narrowing `kind` must use
`declare readonly kind: ...` — target is ES2022, so a real re-declaration
overwrites the base assignment with `undefined`.

**Which errors get classified:** a condition an operator can cause or fix. An
invariant breach — a malformed WAV mid-decode, `planTick` choosing a channel
absent from the set it was handed — stays a plain `Error` and classifies as
`internal/internal`, which is accurate. Errors this codebase does not own are
classified with `tagError`, which attaches a non-enumerable symbol and returns
the same object, so `instanceof z.ZodError` still narrows.

### Providers and the sidecar

`src/providers/*.ts` wrap external APIs (Anthropic for scripts, ElevenLabs for
premium voice, kokoro/edge-tts for the free voice fallback chain).
`src/providers/whisperx.ts` talks to the Dockerized WhisperX sidecar
(`docker-compose.yml`) for caption word-level alignment — needed whenever a
job's voice.json wasn't produced by a successful ElevenLabs synth (ElevenLabs
itself returns word timings directly, no alignment pass needed).

### Posting: manual, per platform

There is no `src/publish/` anymore — no OAuth flow, no encrypted credential
store, no upload adapter, no scheduler, no quota backoff. Posting a finished
video is something the operator does by hand, once per platform, from the
dashboard's `/post` page.

`src/posts/` is what replaced it: `types.ts` declares `PLATFORMS =
['youtube', 'instagram', 'tiktok']` and the `Platform` union; `meta.ts` holds
`platformEntrySchema` (title/description/hashtags), written into
`library.metadata_json` by the script stage and read back by the dashboard's
`/post` query, plus per-platform char/hashtag limits and
`normalizePlatformMeta`, which composes YouTube's title+description+tags into
separate paste fields but folds the others into one caption block (Instagram
and TikTok have no separate title field, so their body is
`title. description #tags`); `posts.ts` is the DAO for the `posts` table — a
row exists **iff** the operator posted that video to that platform, full
stop. No status, no attempt count, no error kind, because nothing here talks
to a platform and there is no failure mode to model. `markPosted` is
idempotent on the `(job_id, platform)` primary key and deliberately does
**not** refresh `posted_at` on a second call (a typo'd-url correction must
not restamp when the video actually went out) but does overwrite `url`
(the later value is the correction); `unmarkPosted` deletes the row.
`reclaim.ts` (covered in the daemon section above) is the read that decides
when a video's stored bytes can be freed: "posted to every platform the
channel declares."

The `/post` page (`src/dashboard/queries/post.ts`,
`src/dashboard/views/post.ts`) renders one card per unposted video, with a
readonly, copy-buttoned paste field per still-open platform holding the
composed title/body/tags, a `url` field to paste the live link back in once
posted, and a "mark posted" button (`post.mark`). A platform already marked
shows its saved link and an "unmark" control (`post.unmark`) instead of the
paste fields — reversing a mis-click does not require re-typing anything.
Nothing on this page, or anywhere in the codebase, ever holds a platform
credential: the paste-and-click shape is the entire mechanism.

### The dashboard's read-only guarantee narrows, not disappears

`src/dashboard/` serves a localhost web view of the database (compose service
`dashboard`, port 8787, loopback-bound). It serves one `BRAINROT_ROOT` per
process — there is no in-page switcher, and the footer names the root being
served; viewing the other root means running a second dashboard against it.
Every GET route still opens SQLite through `openDbReadonly` — a sibling of
`openDb` that skips the `mkdirSync` and the `schema.sql` exec, both of which
are writes — so no read route can mutate state. `POST /actions` is the one
exception: it opens a separate `openDbActions` handle whose only statement is
an `INSERT INTO operator_actions`, and the daemon does the actual mutating
out-of-process (see "the operator-action queue", above). That's also why the
dashboard still holds no `ANTHROPIC_API_KEY`: the credentials a queued
render needs live only in the daemon — though there is now nothing left for
the dashboard to hold a credential FOR either way, since no queued action
ends in a platform upload anymore (`BRAINROT_TOKEN_KEY` itself is gone,
along with the encrypted credential store it protected). Queueing a
*render* is still not prospective, though: `produce.next` and `jobs.resume`
both end in a real Remotion render and real provider spend, and `scout.run`
in real provider calls — all from an unauthenticated POST, which is why the
loopback binding and the two CSRF layers below are the whole of the
boundary. The 409 liveness gate is not a third layer: it refuses
only when the daemon looks stale (`src/dashboard/server.ts:164-183`), so a
cross-origin POST that already cleared CSRF still succeeds whenever the daemon
is up — it protects the operator from queueing into the void, not the pipeline
from an attacker. What is still CLI-only after this phase is the read-only
listing commands (`jobs`, `costs`, `topics list`, `library list`),
`resume --force`, `produce --dev`, and `run` itself — a scope boundary,
not a structural one.

`POST /actions` is guarded by two independent layers (`src/dashboard/csrf.ts`),
either of which alone would stop the classic cross-site-form attack: proof the
request is same-origin (`Sec-Fetch-Site`, then `Origin` vs `Host`), and the
boot-minted CSRF token. The same-origin proof needs its own loopback-Host
allowlist ahead of the `Origin`-vs-`Host` comparison — that comparison only
proves the two headers *agree*, which a DNS-rebinding attacker satisfies
trivially, so the allowlist is the sole check asking "is this host ours" at
all. The redirect guard behind the confirm-page `from` link (`sameSitePath` in
`src/dashboard/server.ts`) re-validates its own *output*, not just the input,
for the same reason: `/..//evil.example` parses as same-origin and then
*normalizes* to `//evil.example`, a protocol-relative off-site URL — a check
that ran once on the raw input would miss it. Both of these are exactly the
kind of thing a "simplify this" pass deletes without understanding why it was
there; see the "do not simplify this away" comments in `csrf.ts` itself before
touching either.

The module splits SQL from HTML and enforces it by structure: `queries/*` are
`(db, params) -> typed data` and emit no markup, `views/*` are
`(data) -> SafeHtml` and issue no SQL. Interpolation goes through `html.ts`,
which escapes by default — topic titles come from scraped sources, so this is
a live path. `queries/jobs.ts` hardcodes `DASHBOARD_STAGE_ORDER` rather than
calling `pipelineStages()`, which would drag remotion and kokoro into a
viewer; a test asserts the two lists match so they cannot drift.

The library page draws four byte states — `local` (runs/ file present),
`archived` (bucket only), `reclaimed` (object deleted after every declared
platform was posted to), and `unstored` (no `library_objects` row at all,
i.e. the `library backfill-store` backlog) — plus a `live` column of post
urls from `posts`. All four come from the database plus `existsSync`; the
dashboard still holds no bucket credentials.

### Remotion rendering

`remotion/` is the actual video composition (React components rendered to
frames by `@remotion/renderer`), driven by `src/stages/assemble.ts` and
`src/stages/captions.ts`. It has its own `tsconfig.json` and is type-checked
separately in `pnpm build`, but is not a separate package — no independent
install/version.

### Data flow summary

SQLite holds all state, at `<root>/db/brainrot.db`
(`/app/state/db/brainrot.db` in the container) — the `brainrot-data` named
volume, deliberately NOT a bind mount. WAL mode
coordinates through an mmap'd `-shm` file every opener must share coherently;
a bind mount from macOS reaches the Linux VM over virtiofs, so the daemon and
a host CLI become two kernels sharing one file, which SQLite documents WAL as
unsupported on. It corrupted silently in practice (`database disk image is
malformed`, then committed transactions vanishing while the pipeline logged
success and published for real — two videos posted to YouTube/Instagram with
no rows to show for it). Never move this back to a bind mount.
`busy_timeout=5000` because the daemon's concurrent workers, the dashboard,
and `docker compose exec` CLI runs all open it at once. It holds:
`jobs`/`job_stages` (pipeline
progress), `library` (finished videos awaiting review/posting), `topics`
(scout queue), `scout_state` (per-channel last-scout-attempt timestamp),
`costs` (spend ledger), `leases`, `posts` (the manual-posting record — one
row per (job, platform) actually posted; `publishes` and `oauth_tokens` are
gone, dropped by `migrate.ts` along with the publishing pipeline they
backed).
Per-job filesystem artifacts live under `<root>/runs/<jobId>/<stage>/`. Schema lives
in `src/db/schema.sql`, applied via `db.exec` on every `openDb` call (plain
`CREATE TABLE IF NOT EXISTS`) — so schema.sql alone is the declarative shape
of a _fresh_ database, and a new table still needs nothing else.

Changes `CREATE TABLE IF NOT EXISTS` cannot express against an **existing**
database go in `src/db/migrate.ts`, which `openDb` calls right after the
schema exec (and `openDbReadonly` never calls, since it must stay
write-free). This is deliberately not a migration framework: there is no
version ledger and no ordered list of numbered steps. Each step instead
**probes for its own precondition** (`PRAGMA table_info` for an added column,
a `sqlite_master.sql` substring for a CHECK that cannot be ALTERed, a
duplicate-row query for a unique index) and is a no-op when already applied,
so it is idempotent and self-healing on a fresh database. A step that has to
rebuild a table renames the old one aside and replays `schema.sql` rather than
carrying its own copy of the DDL — schema.sql stays the single source of truth
for table shape.

Data-dependent DDL — a `CREATE UNIQUE INDEX` or similar that can fail against
existing rows rather than just existing schema — belongs in `migrate.ts`
rather than `schema.sql`, for the same reason every other step there does:
`openDb` execs schema.sql on every command, so DDL that can fail on data
would wedge the entire CLI rather than one command, and a migrate.ts step
can probe for violating rows first and skip-with-a-warning instead of
throwing. `ux_publishes_live`, the partial unique index that used to enforce
one live `publishes` row per (job, platform), was the worked example of
this; it went with the table it constrained. `posts`' own primary key,
`(job_id, platform)`, needs no equivalent — it's a plain `CREATE TABLE`
constraint, not something that can fail against pre-existing data, because
the table starts empty on every fresh install and `migratePublishesToPosts`
(`src/db/migrate.ts`) backfills it with `INSERT OR IGNORE`.

### Test layout and conventions

Tests are colocated (`src/**/*.test.ts`, plus `remotion/**`), in three tiers:
the default hermetic run, `*.contract.test.ts` (`CONTRACT=1`, real paid API
calls), and `*.storage.test.ts` (`STORAGE=1`, needs MinIO up).

**Layout rule: a directory with more than 3 test files folds its tests into a
nested `test/` subdirectory** — `src/loop/test/`, `src/stages/test/`,
`src/scout/test/`, `src/scout/sources/test/`, etc. — so the source directory
listing stays scannable; a directory with 3 or fewer stays flat
(`src/config/`, the repo root). `src/scout/sources/` is the worked example of
the rule firing: `llm.test.ts` took it to four, and the fold followed
immediately (`b6ba6dc`). `src/` root is exempt
from the fold rule regardless of count: its test files are repo-wide concerns
(`arch.test.ts`'s architecture lints, `cli.test.ts`, `smoke.test.ts`,
`errors.test.ts`) rather than one module's tests, and folding them would drag
`scripts/vitest-sequencer.ts` — which lists `src/cli.test.ts` by path — and
`src/testing/dist-layout.test.ts` along for no readability gain. This is a pure
file-location rule, orthogonal to file size: a large file that cleanly
consumes the shared testkit and its module's own `_*.fixtures.ts` does not
need to be split just for being large (see below).

**`src/testing/` is the one shared testkit.** It is excluded from the `dist/`
build, so nothing in it can reach production. Use it rather than re-rolling
fixtures locally:

- `tmp.ts` — `tmpDir(prefix)`. **The only way to make a temp dir.** It registers
  for cleanup; `setup.ts` sweeps after each file. Thirteen files used to
  `mkdtempSync` and never clean up, and on macOS those are not auto-reaped.
- `channel.ts` — `testChannel(overrides)` for the parsed config;
  `channelToml`/`writeChannelToml`/`writeChannelsDir` for the on-disk TOML.
  In `channelToml`, `bg_dir`/`bgm_dir` must stay ahead of every `[section]`
  header or TOML nests them under the last table and the values vanish.
- `job.ts` — `makeCtx(opts)`, `testScript`, `seedVoiceJson`/`seedWordsJson`/
  `seedScriptJson`.
- `db.ts` — `memDb()`/`fileDb()` (both auto-closed) and one seed builder per
  table, each `(db, id?, overrides?)`.
- `cli.ts`, `run-cli.ts`, `storage.ts` — subprocess and object-storage scaffolding.

Conventions:

- **Env only via `vi.stubEnv`.** `setup.ts` registers a global
  `afterEach(vi.unstubAllEnvs)`, so no file needs its own. When the code under
  test writes `process.env` itself (`applyDevFlag`), stub the key to `undefined`
  first — that registers it so the global unstub reverts the write.
- **A spawned CLI cannot see `vi.stubEnv`.** Pass what it needs through
  `runCli(args, { env })`. Inheriting the developer's `.env` instead is how two
  tests came to assert `ENOENT` while actually failing the storage gate, and to
  fail on any checkout without a `.env` — see `storageEnvVars()`.
- One top-level `describe` named after the symbol under test. `it(`, never
  `test(`. Helpers at the top of the file or in a colocated `_*.fixtures.ts` —
  never buried between describes.
- Conditional tiers use `describe.skipIf`/`it.skipIf`. A bare `return` reports
  a **pass** for work that never ran.
- Prefer one file per module over a facet split, even for a large file
  (`cli.test.ts`, `src/dashboard/test/server.test.ts`, and
  `src/scout/test/scout.test.ts` are each several hundred lines holding
  every describe for their module, subprocess and in-process tests included).
  A split earns its keep only when it separates a genuinely different concern
  — `src/config/channels.smoke.test.ts` stays apart from `channel.test.ts`
  because it hits real on-disk channel directories (a git-tracked
  `prod/channels/` and the dev mode root's own gitignored `local/channels/`)
  and would otherwise cost `channel.test.ts` its hermeticity, not because of
  size.
- A `_<module>.fixtures.ts` holds what only that module needs, and **delegates
  row SQL to `src/testing/db.ts`** rather than re-issuing INSERTs. That is what
  lets a module keep an ergonomic local call shape (digest ages rows via
  `isoAgo`) without a second copy of the schema.
- Repo-wide architecture lints go in `src/arch.test.ts`. They are import-heavy
  by nature (proving module A must not load module B means loading B), so they
  are kept out of behavior files that would otherwise be instant.
- The eslint test-tier rule relaxation covers `**/*.test.ts`, `src/testing/**`
  and `**/_*.fixtures.ts` — stub adapters and untyped rows live in all three.

**Performance.** The suite runs ~23s wall for 1127 tests (plus 1 skipped)
across 85 files (warm; a first run after `pnpm install` is slower while the
Remotion webpack cache in `node_modules/.cache` fills, and any measurement
taken while something else is loading the machine can read 3x high). Wall
clock is set by the slowest single file, not by the total —
`src/jobs/test/golden-path.test.ts` is the floor at ~14s, one indivisible
e2e render: the whole suite finishing within about 10s of that same number
is the sign everything else is fully parallel behind it. That also means CPU spent anywhere shows up
everywhere: cutting ~48s of CPU out of `visuals-volume` and `qc` roughly halved
`golden-path`, `assemble` and `remotion` too, purely by ending the contention.

`scripts/vitest-sequencer.ts` starts the known-slow files first because Vitest
orders by byte size, which is uncorrelated with runtime here —
`remotion/remotion.test.ts` is 36 lines and bundles a Remotion composition.
`src/testing/sequencer.test.ts` fails if an entry in that list stops matching a
real file, so it cannot silently rot again.

When a test asserts on _selection_ rather than on encoded output, give it cheap
inputs: `visuals-volume.test.ts` went 36s → 9.7s by handing its six selection
tests a 0.2s 320×180 source and a 100ms narration, instead of the 2s clip the
one output-contract test actually needs. Fixtures several tests share are
encoded once in `beforeAll` and copied — `qc.test.ts` re-encoded the same
1080×1920 clip five times (28s → 7.4s).

### Test-only build

`scripts/build-test-cli.ts` transpiles `src/` into a mirrored `dist/` tree via
a Vitest `globalSetup`, so the CLI subprocess tests can spawn `node dist/cli.js`
instead of `pnpm exec tsx src/cli.ts`. It is transpile-only,
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
