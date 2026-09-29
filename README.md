# Brainrot Machine

Automated short-form video pipeline. `brainrot produce` turns a topic into a
finished, QC-checked, word-captioned 9:16 MP4 in the library. The pipeline's
job ends there — posting a finished video to YouTube Shorts, Instagram Reels
or TikTok is a manual, per-platform step an operator does by hand from the
dashboard (see "Posting a video" below). There is no upload adapter, no
OAuth grant and no scheduler in this codebase.

## Prerequisites

- Node >= 22 and [pnpm](https://pnpm.io)
- [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
- Docker (for the WhisperX caption-alignment sidecar — needed for captions
  whenever a job's voice wasn't synthesized by a successful ElevenLabs call)

## Setup

```bash
pnpm install
cp .env.example .env          # fill in provider keys (see below)
docker compose up -d whisperx # caption alignment sidecar
```

Development runs through disposable test fixtures. `docker/state/channels/` is the
only maintained channel directory; there is no local operational environment
or channel-promotion copy. Provider keys are needed for production and the
opt-in contract tests, not for `pnpm test`.

Keys in `.env`:

- `ANTHROPIC_API_KEY` — script generation
- `ELEVENLABS_API_KEY` — premium voice (optional; unset falls back to kokoro/edge-tts)
- `BRAINROT_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (Compose default 12)

## Seed background footage

Drop vertical-friendly clips into the channel's background folder(s) (default
`assets/bg/`). The visuals stage picks
a clip at random from the pool, avoiding the 5 most recently used per channel.

```bash
cp ~/footage/*.mp4 assets/bg/
```

`bg_dir` in a channel TOML accepts either a single path or a list of paths,
and each path is scanned **recursively** — so `bg_dir = "assets/bg"` pools
every clip under `assets/bg/`, including subfolders, while

```toml
bg_dir = ["assets/bg/minecraft-parkour", "assets/bg/subway-surfers"]
```

restricts the pool to just those two category trees (and their own
subfolders).

## Produce a video

```bash
docker compose stop brainrot
docker compose run --rm --no-deps brainrot pnpm brainrot produce \
  --channel /app/state/channels/mvp.toml --topic "Why is Venus so hot?"
docker compose start brainrot
```

Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
`1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

A channel that sets `[voice.premium]` (ElevenLabs voiceId/modelId) gets that
narration provider automatically, with word-level timings (no WhisperX
dependency on the happy path) — no separate flag or tier needed. It falls back
to kokoro/edge-tts on failure or when unconfigured. This requires
`ELEVENLABS_API_KEY` in `.env`.

Voice selection comes only from the channel: omit `[voice.premium]` to use
the free chain. Tests mock each provider independently; there is no `--dev`
flag or development voice override.

## Where outputs land

Production uses `/app/state` inside the container:

- Per-job artifacts: `/app/state/runs/<jobId>/attempts/<attemptId>/<stage>/`, visible on the host
  under `docker/state/runs/<jobId>/attempts/<attemptId>/<stage>/`.
- Finished video: the committed assemble stage’s `final.mp4`, linked from the library.
- SQLite state: `/app/state/db/brainrot.db` in the `brainrot-data` named volume.
- Channel configuration: `docker/state/channels/*.toml`, mounted read-only at
  `/app/state/channels`.

Finished videos remain in their committed attempt directories (legacy videos
retain `runs/<jobId>/assemble/final.mp4`). Keep those local
files until their videos are no longer needed: if one is deleted or goes missing,
the application cannot recover it. Tests use temporary directories cleaned up
after each file.

## Inspect

```bash
docker compose exec brainrot pnpm brainrot jobs    # last 20 jobs
docker compose exec brainrot pnpm brainrot costs   # per-day USD totals, last 7 days
```

## Posting a video

Posting is manual. The pipeline's job ends when a video lands in the
library as `ready`; getting it onto YouTube, Instagram or TikTok is
something an operator does by hand, from the dashboard's `/post` page:

```bash
docker compose up -d dashboard
open http://127.0.0.1:8787/post
```

1. **Open `/post`.** It lists every `ready` video that still has at least
   one declared platform unposted, oldest first — story-mode parts included,
   in order, so working down the page top-to-bottom keeps a series posted in
   sequence without having to track it by hand.
2. **Play or download the video** from the inline player on its card (or from
   `/library` — same file).
3. **Copy the per-platform blocks.** Each still-open platform on the card has
   a readonly, copy-buttoned paste field: YouTube gets separate title,
   description and tags fields; Instagram and TikTok get one composed caption
   (they have no separate title field, so it reads `title. description
#tags`).
4. **Upload by hand** through each platform's own app or web uploader, using
   the pasted title/caption/tags.
5. **Tick the platform off.** Back on `/post`, paste the live post's URL into
   the `url` field (optional — you can also mark it posted with no link) and
   click "mark posted". The card's block for that platform swaps to a
   "posted" state showing the saved link and an "unmark" control, in case of
   a mis-click.

A video is not fully done until every platform the channel declares has been
marked.

**Production is held once a channel hits its backlog cap.** `backlog_days`
(default 2) caps how many finished, unposted videos a channel may hold;
`produce-next` stops producing more for a channel sitting at
`ceil(videos_per_day × backlog_days)` unconsumed videos until the operator
clears some of that backlog. Nothing ages a video out anymore — there is no
scheduler left to time a post against, so a video the operator hasn't gotten
to yet simply waits. If a video will never be posted (wrong take, dead
topic), **discarding** it from `/library` (`library reject`, or the
dashboard's "discard" action) is how it stops counting toward that cap: it
frees the video's stored bytes and drops out of the posting queue for good.

### Channel config

Declare which platforms a channel targets as a flat top-level array —
not a `[publish]` table, which no longer exists:

```toml
videos_per_day = 3
platforms = ["youtube", "instagram", "tiktok"]
```

`videos_per_day` is the volume knob: the pipeline produces that many videos
a day per channel. It is pure demand, not a schedule and not a cap checked
against any platform — nothing here calls a platform API, so there is
nothing to enforce a limit against. An empty (or absent) `platforms` list
means "not decided yet": the channel still produces, it just has no posting
checklist on `/post`, and every unconsumed video counts toward the channel's
backlog until platforms are declared.

`backlog_days` (default `2`) caps how many finished videos a channel may hold
before `produce-next` stops producing more for it — see "Posting a video"
above for what that means day to day. `[scout] queue_days` (default `3`) is
the same idea one stage earlier: it caps how many scored candidate topics a
channel may hold queued before `scout` stops fetching and scoring more for
it.

## Automation

Production is one long-running process: `brainrot run` is the container's
`CMD` and starts a daemon with five workers running concurrently — there is
no host cron, no launchd agent, and no per-worker container anymore. Each
worker polls in a tight loop: check demand, do one unit of work if there is
any, and re-check immediately; an idle worker sleeps 30 seconds before
checking again, and a worker whose unit throws logs the error and sleeps 60
seconds rather than taking the daemon down. `scout` fills the topic queue,
`produce` performs one unit of work per pass (resume one interrupted/budget-blocked job or
produce one video), and `digest` prints a daily report once per local day.
There is no `publish` worker — nothing in this codebase uploads to a
platform, so there is nothing left to schedule; posting is the manual `/post`
workflow above. The remaining two, `actions-fast` and
`actions-slow`, drain the dashboard's operator-action queue instead of the
pipeline — see "The dashboard queues renders and spends money" below.
Because throughput follows demand rather than a clock, there's nothing
scheduled to fall behind: a channel with topics ready gets them produced as
fast as its own gates (backlog caps, budgets) allow, and a channel with
nothing to do costs nothing but an idle poll.

No API keys are needed for fetching. The scout has one source: subreddits
(`[scout] subreddits`), read through [Arctic Shift](https://arctic-shift.photon-reddit.com),
a free public Reddit archive that picks up posts within minutes, because
reddit.com itself cannot be scouted keylessly any more. RSS feeds and LLM
topic generation were removed; a channel TOML that still declares `rss` or
`generate_topics` fails to load, naming the replacement. Each subreddit's
newest `per_source_limit` posts are fetched, newest first. The archive has no
"hot" ranking and holds scores near zero for the first ~36 hours, so recency
is the only order available. Arctic Shift makes no uptime promises; when the
source starts erroring, check <https://status.arctic-shift.photon-reddit.com>.

The archive keeps posts that Reddit's own listing hides: removed by
moderators, deleted by their authors, or removed by Reddit. These are dropped
inside the source and never counted, so `fetched` can come in under
`per_source_limit`. Each post names its submitting account, so AutoModerator's
recurring scheduled threads ("Basic cosmology questions weekly thread" and
friends) are dropped before scoring and counted as `droppedAutomated`. Each
week's instance is a new post id, so dedupe alone would let them cost a
scoring slot forever. A subreddit name that is not well-formed (`r/space`
rather than `space`) is reported as a source error. A well-formed name for a
subreddit that does not exist just returns nothing.

A failed Arctic Shift request (a rate limit, a query timeout, an outage) is
one `sourceErrors` entry, carrying the API's own error text, and is not
retried. The channel's next scout attempt, at least 20 minutes later, tries
again. When every subreddit across every channel fails, the run reports
`AllSourcesFailedError`; with a single subreddit, one Arctic Shift outage is
enough.

Image submissions are dropped before scoring. The scorer only ever sees
titles, so an astrophotography post reads as a strong topic and scores high,
producing a video with a picture where its story should be. Each post's `url`
field names the submission target, which is enough to drop the
unambiguous cases (reddit-hosted media, imgur, galleries, image file
extensions) without paying to score them. Hosts that are less clear-cut — an
astrophotography site with no file extension, a YouTube explainer — are not
guessed at: the target host goes into the scoring prompt so the model can weigh
it. Each tick reports how many it dropped as `droppedMedia`.

### Start

```bash
docker compose up -d --build
```

Use `--build`, not a bare `up -d`: Compose will happily start a stale local
`project-brainrot-brainrot:latest` image instead of rebuilding it, which
means "start" can silently run old code. `--build` makes it always build (or
confirm current) first.

This brings up the production services: `whisperx` (the caption-alignment sidecar) and
`brainrot` (the daemon: `brainrot run`, five workers polling for demand),
which waits on `whisperx`'s healthcheck before its workers start, plus the
`dashboard`. There is
one log stream for everything the daemon does:

```bash
docker compose logs -f brainrot
```

Each worker prints one JSON line per unit of work, prefixed with which
worker it came from (`{"worker":"produce",...}`), and a `noop` line is
normal, not a failure. Consecutive identical idle lines are deduped, though —
a channel that stays idle for the same reason logs it once, not once every
30 seconds — so a quiet daemon can produce no output at all for hours; that
silence in `docker compose logs -f` is expected, not a hang. `produce` noops
with `lease-held`,
`no-eligible-work`, `backlog-full`, `claim-conflict` (an operator command won
a topic or job mid-unit), `resume-refused` (a blocked job's channel TOML or
the job itself is gone, so no tick can heal it — the message names which),
or `config-error`; `scout` with `lease-held`, `queue-full`, `no-scout-sources`
(a channel was due for a recheck but none of the due ones declares a
`[scout]` source), or that same `config-error`. The `error` field of a
`config-error` line carries the cause — under the daemon that JSON line is the
only report, deliberately: an unstructured stderr print would bypass the idle
dedupe and repeat every 30 seconds. The one-shot commands below still echo it
to stderr, where a human is watching. A worker whose unit throws instead
logs `{"worker":...,"action":"worker-error","error":...}` and backs off for
60 seconds rather than retrying immediately or taking the daemon down — that
line, not an exit code, is the daemon's failure signal, since the daemon
itself never exits under normal operation.

The standalone `pnpm brainrot produce-next` / `scout` /
`digest` commands (useful for a manual, one-shot run outside the daemon)
keep the old exit-code contract: exit `0` for any noop or
successful action, exit `1` when real work failed — a `failed`/`blocked`
produce, or a scout run whose every channel died.

### Cadence

There is no schedule to configure — throughput comes from the poll loop
itself (`src/loop/daemon.ts`). Each of the daemon's three pipeline workers
(produce, scout, digest) checks demand, does one unit of work if
there is any, and re-checks immediately; an idle worker sleeps 30 seconds
(`IDLE_SLEEP_MS`) before its next check, and a worker whose unit throws
sleeps 60 seconds (`ERROR_SLEEP_MS`) instead. `scout` layers a per-channel
clock on top of that poll, `SCOUT_RECHECK_MS` (20 minutes), so a channel
isn't refetched on every 30-second idle poll even when nothing about it
changed — the clock is persisted per channel in `scout_state`, so a daemon
restart does not reset it and does not force an immediate re-scout.
`digest` is the one pipeline
worker still on a real clock: it fires once per local day at or after 08:00
(`DIGEST_HOUR`), printed to the log stream only — nothing else delivers it —
and a restart later the same day can re-fire it once. The other two workers,
`actions-fast` and `actions-slow`, follow the same check-then-sleep shape but
poll at ~1s and 30s respectively for a different queue — see "The dashboard
queues renders and spends money" below.

Times that matter are container-local (`TZ=America/New_York`, set in
`docker/Dockerfile` and pinned again in `docker-compose.yml`'s
`environment:` block — an `env_file` value of the same name would otherwise
override the image's `ENV`), regardless of the host Mac's own timezone.
Changing any of the constants above means editing the source and running
`docker compose build brainrot`, same as any other source change. There is
no hot reload.

### Dashboard

A Next.js App Router application served by the `dashboard` Compose service.
Pages render live SQLite data on the server; React controls submit to the
operator queue and refresh action status without replacing drafts or players:

```bash
docker compose up -d dashboard
open http://127.0.0.1:8787
```

For local development, use an explicitly initialized disposable root (never the
production database volume from the host):

```bash
BRAINROT_ROOT=/path/to/disposable-state pnpm dashboard:dev
pnpm dashboard:build          # builds without runtime state or provider credentials
BRAINROT_ROOT=/path/to/disposable-state pnpm dashboard:start
pnpm exec playwright install chromium
pnpm test:dashboard           # production-server browser tests with disposable fixtures
```

The dev/start commands use port 8787 by default (`BRAINROT_DASHBOARD_PORT`)
and bind to host loopback. Compose sets the internal bind address separately.
The app lives in `dashboard/` and shares the root package and lockfile. Its
webpack extension mapping preserves the CLI's NodeNext `.js` source imports.
Build before running browser tests. `pnpm check` includes the production Next.js
build; browser tests are an additional release check.

Seven pages: `/post`, the manual posting queue described above; an overview
(job health, spend against the global-day and per-channel-day budget caps,
held leases); jobs with a per-stage timeline and the raw error text; the library with inline video
playback; `/posts`, a reverse-chronological log of what has actually gone
out (posted-at, channel, platform, topic, link); the scout topic queue; and
an action history page (`/actions`) listing every operator action that has
been queued, with its status, result and error.

The dashboard serves the explicit production root supplied by Compose, and its
footer names that root. Dashboard tests construct isolated databases directly.

Every page it _reads_ still opens the database through a read-only connection
— the `brainrot-data` mount is read-write on purpose (SQLite must create the
`-shm` file even to read a WAL database), but the guarantee lives in the
connection flag, not the mount. What changed is that the dashboard now also
_writes_, in one narrow way: buttons on the overview, jobs, library, topics
and post pages queue an operator action (`POST /api/actions`) that the daemon
executes, rather than mutating anything itself. Eleven actions are wired
today. Seven are fast — `topics reject/requeue`, `library approve/reject`,
`run digest` and `post mark/unmark` — and four are slow, meaning they can
run for seconds or minutes: `produce next` and per-job `resume` (`/jobs`),
`produce` with a channel you pick and a topic you type (`/jobs`), and
`scout now` (`/topics`). Nothing
wired to the dashboard uploads to a platform — posting is the
paste-and-click `/post` workflow above, not a queued action. What is
still CLI-only after this phase is `costs`' own seven-day breakdown —
the overview page already shows spend against the global-day and
per-channel-day budget caps, just not that day-by-day table — plus `jobs`,
`topics list` and `library list`'s own listing format (the `/jobs`,
`/topics` and `/library` pages cover the same data), `resume --force`,
`produce --channel` taking a path
where `jobs.produce`'s own field deliberately takes a name, and `run`
itself — a scope boundary, not a structural limit.

### The dashboard queues renders and spends money

The dashboard queues operator actions (`POST /api/actions`) that the daemon
executes. It has **no authentication**. The only things standing between a web
page you visit and your production pipeline are:

1. the loopback binding (`127.0.0.1:8787` in `docker-compose.yml`), and
2. the same-origin + CSRF-token check in `dashboard/lib/csrf.ts`.

Nothing wired to the dashboard posts publicly anymore — there is no upload
adapter left to call. Three of the wired actions **render a video and spend
real provider money** on a click: `produce next` and `produce` (a channel
you pick and a topic you type, from `/jobs`) each run the whole pipeline —
an Anthropic call for the script, ElevenLabs if the channel configures
`[voice.premium]`, and a full Remotion render — and `resume` re-runs
whichever of those stages the job has not finished. `scout now` also
spends real provider money without rendering anything, on topic scoring.
A separate risk
is workflow state, not spend: `library reject` ("discard") pulls rejected
videos out of the posting queue but keeps their local files.

Five actions route through a confirmation interstitial naming the
consequence: `produce next`, `produce` and `resume`, because they spend and
render; `library reject` and `post unmark`, because they change or remove
operator state (`post unmark` throws away a saved live link). The rest fire on one
click, `scout now` included — so a click can spend without a prompt. Spend
still lands under a budget cap, but which one depends on the action.
`produce next`, `produce` and `resume` each have a job to meter against, so
they clear the full chain — per-video, channel-day, and global-day. `scout
now` has no job row: its cost is ledgered under a sentinel `scout:<channel>`
id that the channel-day query can't see and there's no video to hang a
per-video cap on, so only the global-day cap backs it. Either way the cap is
enforced in the pipeline rather than at this endpoint: it's the backstop, not
the gate.

**Do not put the dashboard behind a tunnel, reverse proxy, or `0.0.0.0`
binding.** Doing so turns it into remote code execution against your channels
and your provider budgets — it can still trigger real renders and real
provider spend, even with no upload path left. If you need remote access,
use an SSH port-forward to loopback on both ends — never a published port.

Actions run inside the daemon under the same operation leases used by its
workers and by CLI produce/resume/scout commands. The daemon
must be running for a queued action to execute: the dashboard shows a banner
and disables the buttons when it is not, and `POST /api/actions` itself answers
409 rather than queue work nothing would drain.

### Development and release

`docker/state/channels/` is the source of truth. Edit those TOMLs directly; tests create
their own minimal channel fixtures in temporary directories. There is no
`local/channels/` directory to synchronize or promote.

```bash
pnpm test:config    # schema, path rules, and every tracked channel TOML
pnpm test:scout     # sources, filtering, scoring, deduplication
pnpm test:pipeline  # stages, job lifecycle, and mocked-provider render tests
pnpm check         # formatting, lint, CLI/Remotion types, Next.js build, default suite
```

The full default suite also covers daemon workers, action queues, budgets,
leases, the dashboard, and the CLI. No paid providers or running services are
needed. Paid provider contracts remain opt-in.

For a release, run `pnpm check`, then build before restarting the services:

```bash
pnpm check
pnpm test:dashboard
docker compose build brainrot whisperx
docker compose up -d --no-build
```

There is no automatic deployment or CI workflow in this repository. The commands
above are the release gate and deployment procedure. Rebuilding changes the
image; it does not require copying channels or recreating database volumes.

Channel edits are live because Compose bind-mounts `docker/state/channels/` and workers
reload it each tick. To keep a running daemon from consuming an unvalidated edit,
stop it before editing and restart after `pnpm check` passes. Code-only changes
can be built while the old image runs. See Recovery below for the existing
in-flight render shutdown limitation.

Operational commands run inside the container:

```bash
docker compose exec brainrot pnpm brainrot jobs
```

Host CLI/dashboard entrypoints require an explicit `--root`/`BRAINROT_ROOT`;
omission fails before creating a database. Tests pass a disposable root. Do not
set a persistent host root in `.env`; Compose supplies `/app/state` itself.

### Operating the database

All persistent state — jobs, library, topics, costs, leases and
posts — lives in the `brainrot-data` **named volume**,
not under `data/`. `docker-compose.yml`'s mount comment carries the full
reasoning; the short version is that SQLite's WAL mode needs coherent shared
memory across every process that opens the file, a macOS bind mount reaches
the Linux VM over virtiofs, and a host CLI plus the containerised daemon are
then two different kernels sharing one file — the configuration SQLite
documents WAL as unsupported on. It did not fail loudly: transactions went
missing while the pipeline logged success and published for real.

Read-only inspection needs no downtime — the daemon can keep running:

```bash
docker compose exec brainrot pnpm brainrot jobs
docker compose exec brainrot pnpm brainrot costs
docker compose exec brainrot pnpm brainrot topics list
```

Back it up with `VACUUM INTO` rather than `cp`: it takes a crash-consistent
snapshot of a live database, where copying a file mid-write does not.

```bash
docker compose exec brainrot node -e "
  new (require('better-sqlite3'))('/app/state/db/brainrot.db')
    .exec(\"VACUUM INTO '/app/state/db/backup.db'\")"
docker run --rm -v project-brainrot_brainrot-data:/d -v "$PWD":/out alpine \
  sh -c 'mv /d/backup.db /out/brainrot-backup.db'
```

`docker volume rm brainrot-data` destroys the entire posting record along with
every job, library and cost row — there is no re-granting anything to get it
back, since nothing here holds a grant anymore, but the history itself (which
videos were already posted where) is genuinely gone. Take a snapshot before
anything that recreates volumes.

### Recovery

Run production commands inside the container so SQLite and local artifact paths
use the same filesystem as the daemon. CLI `produce`, `resume`, `produce-next`
and `scout` now acquire the same managed leases as dashboard actions. A busy
lease refuses the CLI command; `--force` never overrides live ownership.

The daemon holds a separate singleton lease. Every managed lease lasts five
minutes and renews every minute, including during long stages. A second daemon
is refused before startup recovery changes any rows. An expired owner cannot
renew, commit results, or release a successor's lease.

**Automatic crash recovery preserves progress.** After acquiring production
ownership, the daemon marks abandoned attempts interrupted and schedules the
same queued/running job for resume. Completed stages and the topic claim stay
attached to that job. Recovery waits 30 seconds after the first interruption,
doubles after each consecutive interruption without stage progress, and caps
at 30 minutes. Any completed stage resets that backoff. Recovery respects
backlog capacity and does not create another daily quota slot. Ordinary failed
jobs still require explicit resume.

A `job-recovery` warning names the job, stage, old/new attempt and linked action.
Replaying an interrupted script or premium-voice stage can repeat a paid call;
the warning explicitly reports possible duplicate charges and incomplete cost
accounting. Unknown provider charges cannot be reconstructed automatically.

An interrupted render action keeps its job link and recovery notice. A modern
action interrupted before committing a job link is requeued. Legacy actions
without a reliable job link are left failed rather than replayed; recovery of
their existing jobs is independent. If the linked job already finalized, the
action result is reconstructed from its library row.

Budget-blocked jobs persist the refused call's estimate and wait at least 60
seconds. Automatic resume requires that estimate to fit the current per-video,
channel-day and global-day limits. Day caps reset at UTC midnight; per-video
spend does not. Changed configuration allows a probe. Unknown/legacy refusals
get one probe, then wait for a configuration/day change. Job detail and digest
show the requirement and waiting reason. Explicit resume bypasses the retry
delay, but not budget checks or live ownership.

```bash
# A failed job can be resumed while the daemon runs, if produce is currently free.
docker compose exec brainrot pnpm brainrot resume <jobId>
```

For break-glass maintenance, stop the daemon and use a one-shot container:

```bash
docker compose stop brainrot
docker compose run --rm --no-deps brainrot pnpm brainrot resume <jobId> --force
docker compose start brainrot
```

SIGTERM/SIGINT stops polling and drains active work while renewing ownership.
A forced container kill leaves leases until expiry; do not delete them while an
owner might still run. When leases expire, the next production tick reconciles
abandoned work. A sleeping host can likewise lose ownership: old work stops at
its next checkpoint and recovers through a new attempt.

**Deployment:** stop all old daemon and CLI writers, back up the SQLite volume,
then start one updated daemon so the normal opener applies additive migrations.
Legacy unexpired leases are honored (an old produce lease can last 90 minutes).
Old completed stage paths and library videos remain readable. New stage outputs
are isolated per execution attempt, and SQLite records which directories were
successfully committed. No cloud copy or cloud cleanup is involved; retain local
artifacts needed by completed checkpoints. This change adds no file-retention policy.

### Operational caveats

- **A sleeping Mac pauses all work.** Demand remains queued, but a sleep longer
  than the lease TTL loses ownership. The old daemon cancels when it wakes;
  the service restart acquires new ownership and reconciles interrupted jobs.
  Recovery then obeys persisted retry delays and backlog capacity. Daily quota
  still follows the current UTC day; there is no production catch-up quota.
- **Docker Desktop must be set to start at login**, or nothing runs after a
  reboot and there is no alarm that fires — the failure looks identical to an
  idle day.
- **`depends_on: service_healthy` only gates a `compose up`.** It does not
  survive a Docker Desktop restart: on reboot the engine starts every
  `restart: unless-stopped` container independently of the dependency graph,
  so `brainrot`'s workers can start polling, including a `produce` unit that
  needs captions, before `whisperx`'s healthcheck reports healthy. Nothing
  crashes — the affected job just fails or blocks at the captions stage and
  is recoverable the normal way — but it means a reboot is not guaranteed to
  reproduce the startup ordering `docker compose up -d` gives you.

### Timezones: two different clocks

- **Budget caps and the daily production quota roll over at UTC midnight;
  the digest fires on the local day.** The spend caps and the per-channel
  `videos_per_day` production quota (`planTick`'s `today < videosPerDay`
  check) both key off the cost ledger / `jobs.created_at`, which is UTC, so
  "today" for those flips at midnight UTC — 7 pm EST / 8 pm EDT, i.e. late
  afternoon/early evening US-Eastern — not at local midnight. Expect a fresh
  production quota and budget headroom in the early evening. `digest` is the
  one thing left keyed off the **container's** local wall-clock day (`TZ` is
  pinned to `America/New_York` in `docker-compose.yml`'s `environment:` block
  regardless of the host Mac's own timezone): it fires once per local day at
  or after `DIGEST_HOUR` (08:00). Posting has no clock at all anymore — it
  happens whenever the operator gets to `/post`.
  A `{"worker":"produce","action":"noop","reason":"lease-held"}` line is
  normal while a long render from an earlier unit is still running — `scout`
  takes a managed lease of its own (5 min, renewed every minute) and prints the same shape of line if a
  previous scout run is still going.

## Tests

```bash
pnpm check          # complete Node/TypeScript release check
pnpm test           # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract  # real calls: a few cents (ElevenLabs synth, one Anthropic call) + free Arctic Shift GETs
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
