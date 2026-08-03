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

The working directory this creates is a **development copy**: `.env.example`
sets `BRAINROT_ROOT=local`, pointing at the development root (unset also
resolves to `local`, the built-in default), so a bare `pnpm brainrot ...` on
the host never touches production state. See Development vs. production
below for how the container overrides this.

Keys in `.env`:

- `ANTHROPIC_API_KEY` — script generation
- `ELEVENLABS_API_KEY` — premium voice (optional; unset falls back to kokoro/edge-tts)
- `BRAINROT_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (default 25)
- `BRAINROT_DEV_VOICE` — set to 1 to force the cheap voice chain, skipping ElevenLabs (see below)

## Seed background footage

Drop vertical-friendly clips into the channel's background folder(s) (default
`assets/bg/`) and royalty-free music into `assets/bgm/`. The visuals stage picks
a clip at random from the pool, avoiding the 5 most recently used per channel.

```bash
cp ~/footage/*.mp4 assets/bg/
cp ~/music/*.mp3  assets/bgm/
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
pnpm brainrot produce --channel local/channels/example.toml --topic "Why is Venus so hot?"
# host default: --root local
```

Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
`1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

A channel that sets `[voice.premium]` (ElevenLabs voiceId/modelId) gets that
narration provider automatically, with word-level timings (no WhisperX
dependency on the happy path) — no separate flag or tier needed. It falls back
to kokoro/edge-tts on failure or when unconfigured. This requires
`ELEVENLABS_API_KEY` in `.env`.

To skip ElevenLabs on purpose — for a local test run of a channel that has
`[voice.premium]` configured — pass `--dev` to `produce` or `resume`, set
`BRAINROT_DEV_VOICE=1` in the environment, or add `dev = true` to the
channel's `[voice]` table to force it for every job on that channel. Forcing
the volume chain this way reinstates the WhisperX dependency for captions:
since the audio no longer comes from ElevenLabs, captions need the WhisperX
sidecar running (`docker compose up -d whisperx`), same as any non-premium
channel.

## Where outputs land

Paths below are the **container's** (production) defaults. A host command
writes into the development copy instead — `local/runs/` and
`local/db/brainrot.db` — unless you override `--root`/`BRAINROT_ROOT`.
See Development vs. production below.

- Per-job artifacts: `/app/state/runs/<jobId>/<stage>/` (`script.json`,
  `narration.wav`, `words.json`, `background.mp4`, `final.mp4`, `qc.json`) —
  `local/runs/<jobId>/<stage>/` on the host
- Finished video: `/app/state/runs/<jobId>/assemble/final.mp4` —
  `local/runs/<jobId>/assemble/final.mp4` on the host
- State + library + cost ledger: SQLite at `/app/state/db/brainrot.db`
  (override the root with `--root` or `BRAINROT_ROOT`) — `local/db/brainrot.db`
  on the host

**`runs/<jobId>/` is a disposable local cache, not the durable copy.** Once a
job's `store` stage completes, the finished video also lives in the object
store (see Object storage below) and `library_objects` records its key —
`rm -rf prod/runs/<jobId>` on the host for production, or `rm -rf
local/runs/<jobId>` for development, is then safe. Nothing deletes `runs/`
for you automatically; reclaiming disk is a manual operator call, and it's only safe
for jobs whose `store` stage actually finished (check `pnpm brainrot jobs` or
the dashboard first).

## Inspect

```bash
pnpm brainrot jobs    # last 20 jobs
pnpm brainrot costs   # per-day USD totals, last 7 days
```

## Object storage

**Object storage is optional.** Finished videos can be uploaded to Cloudflare
R2 by the `store` stage, which runs last in the pipeline. With the
`BRAINROT_S3_*` keys unset, `store` simply no-ops and logs it — `produce`
still finishes with a normal `ready`/`needs-review` job, the CLI prints a
warning to stderr rather than refusing, and the video lives only under
`runs/`. What you lose without it: no cloud archive, no
`library backfill-store` recovery path, and `runs/<jobId>/` becomes the only
copy — reclaiming disk by deleting it is then a real, unrecoverable deletion
of that video, not just clearing a cache of a durable copy.

Configure it if you want a durable copy independent of the machine's local
disk, or if you plan to post from a different machine than the one that
rendered:

1. In the Cloudflare dashboard, create an **R2 bucket** named exactly `brainrot-videos` —
   the name is pinned as a literal in `docker-compose.yml`.
2. Create an **R2 API token** scoped to that bucket with **Object Read & Write**.
3. Fill the `BRAINROT_R2_*` keys in `.env` (endpoint, access key id, secret access key).
   The endpoint is `https://<account-id>.r2.cloudflarestorage.com`. `docker-compose.yml`
   maps these onto `BRAINROT_S3_*` inside the production container only — the host CLI's
   own `BRAINROT_S3_*` keeps pointing at local MinIO, see "Local development" below.

Videos finished before object storage was configured have no stored object.
Back-fill them:

```bash
pnpm brainrot library backfill-store
```

### Local development

MinIO stands in for R2. It is a `dev`-profile Compose service, so a normal
`docker compose up -d` does not start it:

```bash
docker compose --profile dev up -d minio
```

Console at http://localhost:9101 (user/password `brainrotdev`), S3 API on
port 9100. Point `.env`'s `BRAINROT_S3_*` at it — this is what the host CLI reads
directly, separate from the container-only `BRAINROT_R2_*` above:

```
BRAINROT_S3_ENDPOINT=http://localhost:9100
BRAINROT_S3_BUCKET=brainrot-videos
BRAINROT_S3_ACCESS_KEY_ID=brainrotdev
BRAINROT_S3_SECRET_ACCESS_KEY=brainrotdev
```

Then run the storage test tier, which creates the bucket if it is missing:

```bash
pnpm test:storage
```

**A MinIO presigned URL is `localhost`,** which is fine for the object-store
conformance tests (they only need content-type and completeness) but is not
reachable from anywhere off-machine — irrelevant to posting now that posting
is a manual download-and-upload from `/post`, but worth knowing if you build
against the stored object for anything else.

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
marked. Once it is, its stored object (if any) is freed automatically on the
next produce tick's reclaim sweep — see Object storage above.

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
`produce` performs one unit of work per pass (resume one blocked job or
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

No API keys are needed for scouting: reddit subreddits and RSS sources are
both read through their public feeds. Reddit's feed carries no `stickied`
flag, but it does name the submitting account, so AutoModerator's recurring
scheduled threads ("Basic cosmology questions weekly thread" and friends) are
dropped before scoring and counted as `droppedAutomated`. Each week's instance
is a new post id, so dedupe alone would let them cost a scoring slot forever.
A sticky posted by a human mod still reaches the scorer and simply scores low.

A third source trades a feed for a fee: `[scout] generate_topics = N` has an
LLM (haiku) invent up to `N` candidate topics per scout attempt instead of
reading one. There's no external feed to depend on, but unlike reddit/RSS
each scout attempt that uses it spends a small Anthropic fee — self-limited
by the same queue-full depth gate as every other source — a channel already
holding
enough queued candidates never generates. Two traps: keep `rss` (or
`subreddits`) declared alongside it, since a budget breach on an
llm-only channel makes generation the channel's _only_ source, and a single
degraded call then reads as a total scouting outage rather than one skipped
source; and keep `generate_topics` at or below `per_source_limit` — the
generator's request is clamped to `min(generate_topics, per_source_limit)`
silently, not rejected.

Reddit rate-limits the public feed to roughly one request per window, so a
tick that fetched several subreddits back-to-back used to lose every source
after the first. Each feed fetch now backs off once on a 429 and retries.

Image submissions are dropped before scoring. The scorer only ever sees
titles, so an astrophotography post reads as a strong topic and scores high,
producing a video with a picture where its story should be. The feed names the
submission target in each entry's `[link]` anchor, which is enough to drop the
unambiguous cases (reddit-hosted media, imgur, galleries, image file
extensions) without paying to score them. Hosts that are less clear-cut — an
astrophotography site with no file extension, a YouTube explainer — are not
guessed at: the target host goes into the scoring prompt so the model can weigh
it. Each tick reports how many it dropped as `droppedMedia`.

To clean image-sourced topics scouted before this existed, run `topics
prune-media`. It re-fetches each candidate's permalink and rejects the ones
whose target is an image. A host process can no longer open the production
database at all, so run it inside the container:

```bash
docker compose exec brainrot pnpm brainrot topics prune-media --dry-run
```

Drop `--dry-run` once the verdicts look right. Reddit rate-limits this endpoint
hard, so it paces itself at ~20s per row and retries a 429 once — budget
roughly _20 seconds per reddit candidate_, and watch the per-row progress on
stderr. Any row it cannot resolve is left untouched and reported; re-running
picks those up. Like the other manual commands it runs outside the scout lease,
so stop the daemon first if a unit of scout work may be live.

### Start

```bash
docker compose up -d --build
```

Use `--build`, not a bare `up -d`: Compose will happily start a stale local
`project-brainrot-brainrot:latest` image instead of rebuilding it, which
means "start" can silently run old code. `--build` makes it always build (or
confirm current) first.

This brings up both services: `whisperx` (the caption-alignment sidecar) and
`brainrot` (the daemon: `brainrot run`, five workers polling for demand),
which waits on `whisperx`'s healthcheck before its workers start. There is
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

Times that matter are container-local (`TZ=America/Chicago`, set in
`deploy/docker/Dockerfile` and pinned again in `docker-compose.yml`'s
`environment:` block — an `env_file` value of the same name would otherwise
override the image's `ENV`), regardless of the host Mac's own timezone.
Changing any of the constants above means editing the source and running
`docker compose build brainrot`, same as any other source change. There is
no hot reload.

### Dashboard

A web view of the production database, served by the `dashboard` compose
service:

```bash
docker compose up -d dashboard
open http://127.0.0.1:8787
```

Seven pages: `/post`, the manual posting queue described above; an overview
(job health, spend against all three budget caps, held leases); jobs with a
per-stage timeline and the raw error text; the library with inline video
playback; `/posts`, a reverse-chronological log of what has actually gone
out (posted-at, channel, platform, topic, link); the scout topic queue; and
an action history page (`/actions`) listing every operator action that has
been queued, with its status, result and error.

The dashboard serves whichever root it is given, like every other entrypoint —
there is no in-page database switcher, and the footer names the root being
served. The compose service reads production. To view development state, run a
second dashboard against the dev root:

```bash
BRAINROT_ROOT=local pnpm exec tsx src/dashboard/server.ts
```

Every page it *reads* still opens the database through a read-only connection
— the `brainrot-data` mount is read-write on purpose (SQLite must create the
`-shm` file even to read a WAL database), but the guarantee lives in the
connection flag, not the mount. What changed is that the dashboard now also
*writes*, in one narrow way: buttons on the overview, jobs, library, topics
and post pages queue an operator action (`POST /actions`) that the daemon
executes, rather than mutating anything itself. Ten actions are wired today.
Seven are fast — `topics reject/requeue`, `library approve`, `run digest`,
`post mark/unmark` and `library reject` (discard) — and three are slow,
meaning they can run for seconds or minutes: `produce next` (`/jobs`),
per-job `resume` (`/jobs`), and `scout now` (`/topics`). Nothing wired to the
dashboard uploads to a platform — posting is the paste-and-click `/post`
workflow above, not a queued action. The mutating commands still CLI-only
are `produce` with an explicit topic, `topics prune-media` and
`library backfill-store`. That is a scope
boundary, not a structural limit.

### The dashboard queues renders and spends money

The dashboard queues operator actions (`POST /actions`) that the daemon
executes. It has **no authentication**. The only things standing between a web
page you visit and your production pipeline are:

1. the loopback binding (`127.0.0.1:8787` in `docker-compose.yml`), and
2. the same-origin + CSRF-token check in `src/dashboard/csrf.ts`.

Nothing wired to the dashboard posts publicly anymore — there is no upload
adapter left to call. Two of the wired actions **spend real provider money**
on a click, though: `produce next` runs the whole pipeline — an Anthropic
call for the script, ElevenLabs if the channel configures `[voice.premium]`,
and a full Remotion render — and `resume` re-runs whichever of those stages
the job has not finished. `scout now` also spends, on topic scoring plus,
where `generate_topics` is set, topic generation.

Four actions route through a confirmation interstitial naming the
consequence: `produce next` and `resume`, because they spend and render, plus
two that lose data rather than money — `library reject` ("discard", which
frees stored bytes and pulls a video out of the posting queue for good) and
`post unmark` (which throws away a saved live link). The rest fire on one
click, `scout now` included — so a click can spend without a prompt. Spend
still lands under a budget cap, but which one depends on the action.
`produce next` and `resume` each have a job to meter against, so they clear
the full chain — per-video, channel-day, and global-day. `scout now` has no
job row: its cost is ledgered under a sentinel `scout:<channel>` id that the
channel-day query can't see and there's no video to hang a per-video cap on,
so only the global-day cap backs it. Either way the cap is enforced in the
pipeline rather than at this endpoint: it's the backstop, not the gate.

**Do not put the dashboard behind a tunnel, reverse proxy, or `0.0.0.0`
binding.** Doing so turns it into remote code execution against your channels
and your provider budgets — it can still trigger real renders and real
provider spend, even with no upload path left. If you need remote access,
use an SSH port-forward to loopback on both ends — never a published port.

Actions run inside the daemon under the same leases its workers take, so unlike
the equivalent CLI commands they never race a live render. The daemon
must be running for a queued action to execute: the dashboard shows a banner
and disables the buttons when it is not, and `POST /actions` itself answers
409 rather than queue work nothing would drain.

### Development vs. production

|                        | root         | db                     | runs                     | channels                     |
| ---------------------- | ------------ | ---------------------- | ------------------------ | ---------------------------- |
| development (host)     | `local/`     | `local/db/brainrot.db` | `local/runs/`            | `local/channels/`            |
| production (container) | `/app/state` | `brainrot-data` volume | `prod/runs/` on the host | `prod/channels/` on the host |

`BRAINROT_ROOT` is the only knob, and **unset means `local`** — a bare
`pnpm brainrot ...` on this machine cannot read or write production state even
with no `.env` at all. `docker-compose.yml` pins the container to `/app/state`.
Every command takes `--root <path>` to override it for one invocation.

A bare `pnpm brainrot ...` on the host reads and writes only the development
root — the host's `.env` sets `BRAINROT_ROOT=local`, and unset also resolves
to `local`. The same command run inside the container reads and writes only
production, because `docker-compose.yml`'s `environment:` block pins
`BRAINROT_ROOT=/app/state` no matter what the host's `.env` says:

```bash
pnpm brainrot jobs                               # host: reads local/db/brainrot.db
docker compose exec brainrot pnpm brainrot jobs  # container: reads /app/state/db/brainrot.db
```

This is what makes local iteration safe: a half-finished channel's jobs are
invisible to the production `produce-next` loop, and its spend never enters
the ledger the production budget caps read.

### Promotion

Once a channel developed under `local/channels/` is ready to go live, copy
its TOML into `prod/channels/`:

```bash
cp local/channels/<name>.toml prod/channels/<name>.toml   # edit as needed
```

There is no credential grant to run — nothing in this codebase authenticates
against a platform, so promoting a channel is just getting its TOML into the
production channels directory with the right `platforms` declared.
`loadChannelsDir()` validates it the same way it validates every other
channel: the basename-equals-`name` invariant and no duplicate declared
names, so a malformed promotion fails at the next daemon tick's config load,
reported as `config-error`, rather than corrupting state. The daemon does
not need to be stopped for this — copying a file into `prod/channels/` is
picked up by the next unit's fresh `tryLoadChannelsDir` read, no restart
required.

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

Everything else that renders or mutates job state goes through the
container, not the host — same binary, same filesystem layout, no drift.
Manual commands take no lease of their own, so a hand-run invocation can
execute concurrently with a live daemon worker and both may act on the same
job/topic — `produce-next` holds the `produce` lease, but a manual command
never does. Stop the daemon first, then run the command as a one-shot
container: `docker compose exec` requires a running service, and `stop` just
took it down, so recovery commands use `docker compose run --rm --no-deps`
instead — it starts a fresh container from the same image, with the same env
and mounts, and `--no-deps` keeps it from pulling `whisperx` back up as a
side effect.

```bash
docker compose stop brainrot
docker compose run --rm --no-deps brainrot pnpm brainrot resume <jobId>
docker compose run --rm --no-deps brainrot pnpm brainrot library approve <jobIds...>
docker compose start brainrot
```

The same pattern covers `produce` and `library reject`. Restart the daemon
(`docker compose start brainrot`) once recovery is done — its workers stay
paused until you do.

- **A stranded topic can be returned to the queue.** A topic stays `claimed`
  for as long as its job might still run, so a job abandoned for good leaves
  its topic bound forever. `pnpm brainrot topics requeue <id>` returns it to
  `candidate` and unbinds the dead job; it refuses only while a `queued` or
  `running` job still holds the topic. A `blocked` job's topic can be
  requeued — that job sits out the resume pass until an operator repairs the
  config behind it, and unbinding is safe because a later resume of that job
  keys its `used` flip on `job_id`, which by then matches nothing.

- **A stranded `running` job is still a per-deploy risk, not just a crash
  scenario.** The daemon (`src/loop/daemon.ts`) does handle SIGTERM/SIGINT:
  a `process.once` handler aborts a controller, `abortableSleep` ends an
  idle worker's sleep in milliseconds instead of waiting out the full 30s,
  and no worker starts a new unit once the signal fires. (A clean stop still
  reports **exit 143** in `docker compose ps`/`logs`: `tsx` re-raises SIGTERM
  after the process unwinds, and 128+15 is what Docker records. That is the
  expected shape of a graceful stop, not a failure, and the restart policy
  does not treat it as one.) But the abort is
  not threaded into `runJob` itself, so a unit already mid-render keeps
  rendering — `docker compose stop`/`restart`/`down`, and every
  rebuild-deploy since that's a stop-then-recreate, still fall back to
  Docker's stop grace period (10s default, no `stop_grace_period` override
  in `docker-compose.yml`) and can kill it mid-stage. What heals that is
  stage-resume — `runJob` skips any stage already `done`, so a later
  `resume` picks up where the render died instead of redoing it — but
  getting there is not automatic here: that leaves `jobs.status='running'`,
  the current stage
  `running`, and the topic still `claimed`, and nothing auto-recovers it:
  `planTick` only resumes `blocked` jobs, the repair sweep only heals topics
  whose job already reached `library`, `topics requeue` refuses while a
  `running` job holds the topic, and plain `resume` refuses a `running` job.
  Recover it explicitly, after confirming no container is actually still
  rendering it:

  ```bash
  docker compose stop brainrot
  docker compose run --rm --no-deps brainrot pnpm brainrot resume <jobId> --force
  docker compose start brainrot
  ```

### Operational caveats

- **A sleeping Mac pauses the daemon, but nothing is "missed" — there is no
  schedule to fall behind on.** The old cron loop fired at specific wall-clock
  times; a machine asleep at one of those moments lost that firing outright,
  and supercronic never made it up. The daemon has no firings to lose:
  triggers are demand-based, not scheduled, so a slept-through period is
  simply picked up at the next wake. The instant the machine wakes and the
  container resumes, each worker's next poll sees whatever demand piled up
  (topics to scout, videos to produce) and acts on it right away,
  subject to the same gates as always — `videos_per_day`, `backlog_days`. A
  channel that stayed under its `videos_per_day` count while the machine
  slept simply stays due; there is still no makeup once that count is met
  for the day.
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
  pinned to `America/Chicago` in `docker-compose.yml`'s `environment:` block
  regardless of the host Mac's own timezone): it fires once per local day at
  or after `DIGEST_HOUR` (08:00). Posting has no clock at all anymore — it
  happens whenever the operator gets to `/post`.
  A `{"worker":"produce","action":"noop","reason":"lease-held"}` line is
  normal while a long render from an earlier unit is still running — `scout`
  takes a lease of its own (30 min) and prints the same shape of line if a
  previous scout run is still going.

## Tests

```bash
pnpm test           # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract  # real paid calls, a few cents total (ElevenLabs synth, one LLM call)
pnpm test:storage   # object-store conformance against real MinIO (see Object storage above)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
