# contentd-system

The `contentd` daemon and its support harness: the operator dashboard, CLI utilities,
and integrations for an automated short-form video pipeline. `contentd produce` turns a topic into a
finished, QC-checked, word-captioned 9:16 MP4 in the library. The pipeline's
job ends there — posting a finished video to YouTube Shorts, Instagram Reels
or TikTok is a manual, per-platform step an operator does by hand from the
dashboard (see "Posting a video" below). There is no upload adapter, no
OAuth grant and no scheduler in this codebase.

## Prerequisites

- Node >= 22 and [pnpm](https://pnpm.io)
- [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
- Docker (for the WhisperX caption-alignment sidecar — needed for captions
  whenever a job's voice has no usable provider word timings).
  This installation uses 3 GiB for the Docker VM; Colima defaults to 2 GiB. See
  Operational caveats for resizing and out-of-memory diagnosis.

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
- `ELEVENLABS_API_KEY` — required for voice synthesis
- `CONTENTD_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (default 25)

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
docker compose stop contentd
docker compose run --rm --no-deps contentd pnpm contentd produce \
  --channel /app/state/channels/mvp.toml --topic "Why is Venus so hot?"
docker compose start contentd
```

Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
`1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

ElevenLabs is the only voice provider. Set `ELEVENLABS_API_KEY` in `.env` and
configure the channel's voice:

```toml
[voice]
voice_id = "Gubgw9l4dtIoQA9YZHgx"
model = "eleven_multilingual_v2" # optional; this is the default
```

Missing credentials or an ElevenLabs error fails the job; there is no alternate
voice provider. The voice must be accessible to your ElevenLabs subscription.
Migrate old TOMLs by moving `voice_id` and optional `model` from `[voice.premium]`
into `[voice]` and removing `volume` and `provider`; the old fields are rejected.
ElevenLabs supplies word timings on the happy path. WhisperX remains available
for historical audio or missing provider alignment, not for voice synthesis.

## Where outputs land

Production uses `/app/state` inside the container:

- Per-job artifacts: `/app/state/runs/<jobId>/attempts/<attemptId>/<stage>/`, visible on the host
  under `docker/state/runs/<jobId>/attempts/<attemptId>/<stage>/`.
- Finished video: the committed assemble stage’s `final.mp4`, linked from the library.
- SQLite state: `/app/state/db/contentd.db` in the `contentd-data` named volume.
- Channel configuration: `docker/state/channels/*.toml`, mounted read-only at
  `/app/state/channels`.

Finished videos remain in their committed attempt directories (legacy videos
retain `runs/<jobId>/assemble/final.mp4`). Keep those local
files until their videos are no longer needed: if one is deleted or goes missing,
the application cannot recover it. Tests use temporary directories cleaned up
after each file.

## Inspect

Script generation uses the original post text and metadata saved during scouting.
When a selected topic links to an external article, the script stage retrieves
its readable text before calling the model. Older Reddit topics recover their
post through Arctic Shift; the pipeline does not request Reddit pages directly.
Article retrieval is best-effort, so blocked, missing, or unreadable sources
leave an explicit gap in the prompt rather than stopping production.

Each job saves its source snapshot before the paid script call. Retries reuse
that snapshot, including retrieval failures; completed script checkpoints remain
unchanged. The attempt's `script/context.json` records the source URLs, retrieval
warnings, truncation flags, and exact context supplied to the model. Post and
article bodies share a 60,000-character prompt limit, and the script's budget
estimate includes this additional input. Story videos still narrate their saved
part verbatim after sanitization; their metadata model now sees the full current
part within that limit. Manual topics without sources continue without retrieval.

```bash
docker compose exec contentd pnpm contentd jobs    # last 20 jobs
docker compose exec contentd pnpm contentd costs   # per-day USD totals, last 7 days
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
   its job detail page — same file).
3. **Copy the per-platform blocks.** Each still-open platform on the card has
   a readonly, copy-buttoned paste field: YouTube gets separate title,
   description and tags fields; Instagram and TikTok get one composed caption
   (they have no separate title field, so it reads `title. description
#tags`).
4. **Upload by hand** through each platform's own app or web uploader, using
   the pasted title/caption/tags.
5. **Tick the platform off.** Back on `/post`, click "mark posted". The card's
   block for that platform swaps to a "posted" state with an "unmark" control
   in case of a mis-click. No live post URL is needed.

A video is not fully done until every platform the channel declares has been
marked.

The daemon automatically deletes the finished local MP4 **24 hours after the
last required platform is marked posted**. It checks on startup and every five
minutes while running, including videos posted before this feature was enabled.
The library entry, posting links, metadata, and intermediate render files remain;
the dashboard shows the local video as missing after cleanup. Unmarking a required
platform before cleanup prevents deletion, and marking it again starts a new
24-hour wait. Correcting a posting URL does not reset the timer. Cleanup uses the
channel's current platform list; channels with no platforms or missing configuration
are skipped, and invalid channel configuration prevents the entire cleanup pass.

**Production is held once a channel hits its backlog cap.** `backlog_days`
(default 2) caps how many finished, unposted videos a channel may hold;
`produce-next` stops producing more for a channel sitting at
`ceil(videos_per_day × backlog_days)` unconsumed videos until the operator
clears some of that backlog. Nothing ages a video out anymore — there is no
scheduler left to time a post against, so a video the operator hasn't gotten
to yet simply waits. If a video will never be posted (wrong take, dead
topic), **Delete** on `/jobs`, job details, or `/post` removes the job and its
posting records from the dashboard and frees backlog capacity. Recorded costs,
daily production counts, and local files remain. It does not remove posts from
external platforms. Deleted jobs are excluded from automatic MP4 cleanup.

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

Production is one long-running process: `contentd run` is the container's
`CMD` and starts a daemon with six workers running concurrently — there is
no host cron, no launchd agent, and no per-worker container anymore. Each
worker polls in a tight loop: check demand, do one unit of work if there is
any, and re-check immediately; an idle worker sleeps 30 seconds before
checking again, and a worker whose unit throws logs the error and sleeps 60
seconds rather than taking the daemon down. `scout` fills the topic queue,
`produce` performs one unit of work per pass (resume one interrupted/budget-blocked job or
produce one video), and `digest` prints a daily report once per local day.
`cleanup` checks every five minutes for fully posted MP4s past the 24-hour retention
period. Its JSON log lists deleted files and individual errors; failed deletions
are retried on the next cleanup pass. Missing files need no further action.
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

On a Mac, install the host sleep helper once so production continues while the
display is asleep:

```bash
pnpm daemon:caffeinate install
```

The host helper lives in `daemon/src/app/host/`. After upgrading from an older
helper location, rerun `pnpm daemon:caffeinate install` to update the absolute
script path stored in the LaunchAgent.

The helper starts immediately and at login, independently of your terminal. It
runs macOS `caffeinate` while this checkout's `contentd` container is running,
including while workers wait for new work. It releases the sleep assertion when
the container stops or Docker becomes unavailable, and reacquires it after a
restart. It checks every 30 seconds. Docker Desktop must still run on the host.

Sleep prevention defaults on. Set `CONTENTD_CAFFEINATE=false` in this checkout's
`.env` to switch it off; the helper reloads that setting every 30 seconds without
a Docker restart. Set it back to `true` to enable it. This host-only setting is
not forwarded into containers. For a foreground run, use `pnpm daemon:caffeinate
run`; an exported environment setting takes precedence over `.env` in that process.
The login service reads `.env` and does not save your shell's override.

Use `pnpm daemon:caffeinate uninstall` to remove the login service. Its log is
`logs/caffeinate.log`; `pmset -g assertions` shows the active sleep assertions.
Re-run the install command after moving this checkout or changing the Node
installation. One login service is installed per user; reinstalling points it at
the current checkout. The helper needs the host's Node and installed dependencies.

The display can sleep, but the computer stays awake. Actual sleep still pauses
Docker: this does not guarantee operation with the laptop lid closed, after
explicit sleep, logout, or shutdown. Keep the laptop open and preferably plugged
in for unattended production; the idle-sleep assertion also applies on battery.
The helper keeps existing production running; platform posting remains manual.

Use `--build`, not a bare `up -d`: Compose will happily start a stale local
`contentd-system:latest` image instead of rebuilding it, which
means "start" can silently run old code. `--build` makes it always build (or
confirm current) first.

This brings up the production services: `whisperx` (the caption-alignment sidecar) and
`contentd` (the daemon: `contentd run`, six workers polling for demand),
which waits on `whisperx`'s healthcheck before its workers start, plus the
`dashboard`. There is
one log stream for everything the daemon does:

```bash
docker compose logs -f contentd
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

The standalone `pnpm contentd produce-next` / `scout` /
`digest` commands (useful for a manual, one-shot run outside the daemon)
keep the old exit-code contract: exit `0` for any noop or
successful action, exit `1` when real work failed — a `failed`/`blocked`
produce, or a scout run whose every channel died.

### Cadence

There is no schedule to configure — throughput comes from the poll loop
itself (`daemon/src/app/daemon.ts`). Each of the daemon's three pipeline workers
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
and a restart later the same day can re-fire it once. The `cleanup` worker uses
the same idle poll with an in-memory five-minute throttle; it checks immediately
after a restart and measures retention as 24 elapsed hours from persisted posting
timestamps. The two action workers,
`actions-fast` and `actions-slow`, follow the same check-then-sleep shape but
poll at ~1s and 30s respectively for a different queue — see "The dashboard
queues renders and spends money" below.

Times that matter are container-local (`TZ=America/New_York`, set in
`docker/Dockerfile` and pinned again in `docker-compose.yml`'s
`environment:` block — an `env_file` value of the same name would otherwise
override the image's `ENV`), regardless of the host Mac's own timezone.
Changing any of the constants above means editing the source and running
`docker compose build contentd`, same as any other source change. There is
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
CONTENTD_ROOT=/path/to/disposable-state pnpm dashboard:dev
pnpm dashboard:build          # builds without runtime state or provider credentials
CONTENTD_ROOT=/path/to/disposable-state pnpm dashboard:start
pnpm exec playwright install chromium
pnpm test:dashboard           # production-server browser tests with disposable fixtures
```

The dev/start commands use port 8787 by default (`CONTENTD_DASHBOARD_PORT`)
and bind to host loopback. Compose sets the internal bind address separately.
The app lives in `dashboard/` and shares the root package and lockfile. Its
webpack extension mapping preserves the CLI's NodeNext `.js` source imports.
Build before running browser tests. `pnpm check` includes the production Next.js
build; browser tests are an additional release check.

Five main pages: `/post`, the manual posting queue described above; an overview
(job health, spend against daily budget caps, held leases); `/jobs`, the lifecycle
workspace; the scout topic queue; and action history (`/actions`).

Jobs shows production status, video review/QC summaries, posting progress, and
costs in compact rows. Icon actions resume failed or budget-blocked jobs, approve
videos needing review, and delete inactive jobs.
Resume and Approve queue in one click; Delete opens a confirmation modal
identifying the job and explaining what is removed and retained. Actions stay on
the page with job-specific feedback. Running or queued actions disable conflicting
buttons on their row.

Channel, job status, video review, posting progress, and topic/job-ID search
filters apply immediately (search after a short debounce). Filters stay in this
browser across visits until **Clear filters** is clicked; an explicit filtered
URL overrides the saved selection. Pages show 50 jobs, newest first. Opening a
job and returning preserves the filtered page.

Topics uses the same filter bar and pagination: channel, topic status, and
case-insensitive title/topic-ID search. Its filters persist separately from Jobs,
with the same URL overrides and **Clear filters** control. Topics shows 50 rows
per page, highest score first.

Job details contain the video player, complete QC issues, posting history with
timestamps and optional links, stage errors, budget waits, and the cost ledger.
The former `/library` and `/posts` screens redirect to Jobs; manual posting
continues on `/post`. A post without a saved link still counts as posted.

The dashboard serves the explicit production root supplied by Compose, and its
footer names that root. Dashboard tests construct isolated databases directly.

Every page it _reads_ still opens the database through a read-only connection
— the `contentd-data` mount is read-write on purpose (SQLite must create the
`-shm` file even to read a WAL database), but the guarantee lives in the
connection flag, not the mount. What changed is that the dashboard now also
_writes_, in one narrow way: buttons on the overview, jobs, topics
and post pages queue an operator action (`POST /api/actions`) that the daemon
executes, rather than mutating anything itself. Fast actions include topic
reject/requeue, library approve, run digest, post mark/unmark, and **Delete**.
Delete is the only job/video removal operation on Jobs, job details, and Post;
the former Discard action and `library reject` CLI command have been removed.
Delete removes an inactive job from the dashboard and posting queue and stops
retries; running jobs cannot be deleted. Recorded
spend, daily production counts, and local artifacts are retained.

`produce next` starts the next eligible topic from `/jobs`; `resume` appears on
each failed or blocked job's row and detail page, alongside its stages and errors.
`scout now` is on `/topics`. Custom-topic production is available through the
CLI, without a topic input on the dashboard. Posting uses the paste-and-click
`/post` workflow; marking a platform posted requires no live-link input.

The CLI also provides the seven-day costs breakdown, `resume --force`, and
`run`. No dashboard action uploads to a platform.

### The dashboard queues renders and spends money

The dashboard queues operator actions (`POST /api/actions`) that the daemon
executes. It has **no authentication**. The only things standing between a web
page you visit and your production pipeline are:

1. the loopback binding (`127.0.0.1:8787` in `docker-compose.yml`), and
2. the same-origin + CSRF-token check in `dashboard/lib/csrf.ts`.

Nothing wired to the dashboard posts publicly anymore — there is no upload
adapter left to call. Three of the wired actions **render a video and spend
real provider money**: `produce next` and custom-topic `produce` (available through
the CLI) each run the whole pipeline —
an Anthropic call for the script, ElevenLabs narration using `[voice]`,
and a full Remotion render — and `resume` re-runs
whichever of those stages the job has not finished. `scout now` also
spends real provider money without rendering anything, on topic scoring.
Delete changes workflow state without spending: it retires the job and removes
its library and posting records while keeping costs and local files. Existing
previously discarded videos remain visible under the Discarded review filter;
use Delete to remove those jobs too.

`produce next`, custom-topic `produce`, and `post unmark` retain their
confirmation screen. Delete uses the same confirmation modal on Jobs, job
details, and Post. Resume queues immediately, as do Approve,
Mark posted, and Scout now. A resume or scout click can spend without a prompt;
existing budget enforcement still applies.
`produce next`, `produce` and `resume` each have a job to meter against, so
they clear the full chain — per-video, channel-day, and global-day. `scout
now` has no job row: its cost is ledgered under a sentinel `scout:<channel>`
id that the channel-day query can't see and there's no video to hang a
per-video cap on, so only the global-day cap backs it. Either way the cap is
enforced in the pipeline rather than at this endpoint: it's the backstop, not
the gate.
A separate risk
is workflow state, not spend: `library reject` ("discard") pulls rejected
videos out of the posting queue but keeps their local files.

Five actions route through a confirmation interstitial naming the
consequence: `produce next`, `produce` and `resume`, because they spend and
render; `library reject` and `post unmark`, because they change or remove
operator state (`post unmark` throws away a saved live link). The rest fire on one
click, `scout now` included — so a click can spend without a prompt. Spend
is checked before each paid call against the global daily cap and the channel's
optional daily cap. Video production and scouting share both limits. Scouting
costs use the existing `scout:<channel>` ledger entries and count toward that
channel. There are no per-video limits.

Set `CONTENTD_GLOBAL_DAILY_USD` in `.env` to override the $25 daily default.
Unset or blank uses the default; zero stops paid work. Invalid values fail
configuration validation. Recreate the Compose services after changing this
setting (or restart a host process); `.env` is not hot-reloaded for budgets.
The dashboard and daemon receive the same setting.

A channel may add a lower daily limit:

```toml
[budget]
per_day_usd = 10.0
```

Omit the section or field for global-only enforcement. A declared channel
limit must be positive and strictly lower than the effective global limit;
equal or higher values are configuration errors, not silently clamped.
Channel TOMLs retain their normal live reload behavior. Remove the obsolete
`per_video_usd` field from older files; it now produces a migration error.

Both limits reset at UTC midnight. Checks compare recorded spend plus the
next call's estimate with the limit; equality is allowed. Reported spend
includes estimates, especially ElevenLabs character costs, and is not an
invoice. Actual costs and concurrent calls already running can overshoot a
limit; subsequent calls stop once they no longer fit. There is no reservation
system or separate daemon-wide per-channel default.
Delete changes workflow state without spending: it retires the job and removes
its library and posting records while keeping costs and local files. Existing
previously discarded videos remain visible under the Discarded review filter;
use Delete to remove those jobs too.

`produce next`, custom-topic `produce`, and `post unmark` retain their
confirmation screen. Delete uses the same confirmation modal on Jobs, job
details, and Post. Resume queues immediately, as do Approve,
Mark posted, and Scout now. A resume or scout click can spend without a prompt;
existing budget enforcement still applies.
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
docker compose build contentd whisperx
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
docker compose exec contentd pnpm contentd jobs
```

Host CLI/dashboard entrypoints require an explicit `--root`/`CONTENTD_ROOT`;
omission fails before creating a database. Tests pass a disposable root. Do not
set a persistent host root in `.env`; Compose supplies `/app/state` itself.

### Operating the database

All persistent state — jobs, library, topics, costs, leases and
posts — lives in the `contentd-data` **named volume**,
not under `data/`. `docker-compose.yml`'s mount comment carries the full
reasoning; the short version is that SQLite's WAL mode needs coherent shared
memory across every process that opens the file, a macOS bind mount reaches
the Linux VM over virtiofs, and a host CLI plus the containerised daemon are
then two different kernels sharing one file — the configuration SQLite
documents WAL as unsupported on. It did not fail loudly: transactions went
missing while the pipeline logged success and published for real.

Read-only inspection needs no downtime — the daemon can keep running:

```bash
docker compose exec contentd pnpm contentd jobs
docker compose exec contentd pnpm contentd costs
docker compose exec contentd pnpm contentd topics list
```

Back it up with `VACUUM INTO` rather than `cp`: it takes a crash-consistent
snapshot of a live database, where copying a file mid-write does not.

```bash
docker compose exec contentd node -e "
  new (require('better-sqlite3'))('/app/state/db/contentd.db')
    .exec(\"VACUUM INTO '/app/state/db/backup.db'\")"
docker run --rm -v contentd-system_contentd-data:/d -v "$PWD":/out alpine \
  sh -c 'mv /d/backup.db /out/contentd-backup.db'
```

`docker volume rm contentd-data` destroys the entire posting record along with
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
is refused before startup recovery changes any rows. Startup probes the previous
daemon's private Unix socket beside the database and immediately reclaims its
lease when the owner is gone, including after a container restart with reused
PIDs. Inconclusive probes and legacy leases without a socket identity still
wait for expiry. An expired owner cannot
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
Replaying an interrupted script or voice stage can repeat a paid call;
the warning explicitly reports possible duplicate charges and incomplete cost
accounting. Unknown provider charges cannot be reconstructed automatically.

An interrupted render action keeps its job link and recovery notice. A modern
action interrupted before committing a job link is requeued. Legacy actions
without a reliable job link are left failed rather than replayed; recovery of
their existing jobs is independent. If the linked job already finalized, the
action result is reconstructed from its library row.

Budget-blocked jobs persist the refused call's estimate and wait at least 60
seconds. Automatic resume requires that estimate to fit the current global
and optional channel daily limits. Both reset at UTC midnight. Historical
per-video refusals are readable but no longer enforce a lifetime cap.
Changed configuration allows a probe. Unknown/legacy refusals
get one probe, then wait for a configuration/day change. Job detail and digest
show the requirement and waiting reason. Explicit resume bypasses the retry
delay, but not budget checks or live ownership.

```bash
# A failed job can be resumed while the daemon runs, if produce is currently free.
docker compose exec contentd pnpm contentd resume <jobId>
```

For break-glass maintenance, stop the daemon and use a one-shot container:

```bash
docker compose stop contentd
docker compose run --rm --no-deps contentd pnpm contentd resume <jobId> --force
docker compose start contentd
```

SIGTERM/SIGINT stops polling and drains active work while renewing ownership.
After a forced container kill, startup reclaims the dead daemon's lease.
Production and scout leases still wait for expiry; do not delete them while an
owner might still run. When those leases expire, the next production tick reconciles
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

- **Actual Mac sleep pauses all work.** Install the optional host helper described
  under Start to prevent sleep while the daemon runs (configurable with
  `CONTENTD_CAFFEINATE`). Demand remains queued, but a sleep longer
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
  so `contentd`'s workers can start polling, including a `produce` unit that
  needs captions, before `whisperx`'s healthcheck reports healthy. Nothing
  crashes — the affected job just fails or blocks at the captions stage and
  is recoverable the normal way — but it means a reboot is not guaranteed to
  reproduce the startup ordering `docker compose up -d` gives you.

- **An undersized Docker VM kills work with an opaque error.** Colima's default
  2 GiB can let the kernel kill WhisperX during alignment (and ffmpeg/Node
  during rendering), leaving only a socket-closed fetch error. For Colima,
  stop the daemon gracefully, then resize and restart:

  ```bash
  docker compose stop -t 120 contentd
  colima stop
  colima start --memory 3
  docker compose start contentd
  ```

  In Docker Desktop, set the VM memory under Settings → Resources instead.
  A healthy WhisperX probe only checks liveness; it does not load the model.
  If alignment closes the socket, inspect sidecar logs and VM kernel OOM logs
  (`colima ssh -- sudo dmesg`). A global VM OOM kill may leave Docker's
  `OOMKilled` flag false after restart.

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

## Migrating an existing installation after the rename

The project is `contentd-system`; the daemon service and CLI are `contentd`.
Environment settings use the `CONTENTD_` prefix. Update existing `.env` keys
and any external scripts before starting the renamed services. The database
is now `/app/state/db/contentd.db` in `contentd-system_contentd-data`.

To preserve an existing installation's state:

1. Using the previous checkout and its Compose configuration, stop all services
   and uninstall its host sleep helper with `pnpm daemon:caffeinate uninstall`.
   Record the old database volume name with `docker volume ls`. Keep that volume
   as a backup; do not run `docker compose down -v`.
2. Copy the stopped database volume's contents to the new named volume
   `contentd-system_contentd-data` using a temporary container with the old volume
   mounted read-only. Rename the database to `contentd.db`, and rename any matching
   `-wal` and `-shm` files to `contentd.db-wal` and `contentd.db-shm` together.
   Copy the entire set only after every old database writer and reader has stopped.
3. Keep the existing `docker/state/runs/`, `docker/state/channels/`, and `assets/`
   directories. If the checkout moved, update any absolute paths in channel config.
4. Run `docker compose up -d --build`; the initializer sets database ownership.
   Verify existing jobs with `docker compose exec contentd pnpm contentd jobs`
   and the dashboard before removing any backup. Reinstall the host helper with
   `pnpm daemon:caffeinate install` if desired.

Starting without copying the old database creates an empty installation.
Dashboard filter preferences use new browser storage keys and reset to defaults.
