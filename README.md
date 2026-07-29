# Brainrot Machine

Automated short-form video pipeline. `brainrot produce` turns a topic into a
finished, QC-checked, word-captioned 9:16 MP4 in the library.

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
points `BRAINROT_DB`/`BRAINROT_CHANNELS_DIR`/`BRAINROT_RUNS_ROOT` at
`data/dev.db`, `channels-dev/`, and `runs-dev/`, so a bare `pnpm brainrot ...`
on the host never touches production state. See Development vs. production
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
pnpm brainrot produce --channel channels/example.toml --topic "Why is Venus so hot?"
# host defaults (from .env, dev copy): --db data/dev.db  --runs-root runs-dev
# production equivalents, used only inside the container: --db data/brainrot.db --runs-root runs
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
writes into the development copy instead — `runs-dev/` and `data/dev.db` —
unless you override `--db`/`--runs-root`/`BRAINROT_DB`/`BRAINROT_RUNS_ROOT`.
See Development vs. production below.

- Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
  `words.json`, `background.mp4`, `final.mp4`, `qc.json`) — `runs-dev/...` on
  the host
- Finished video: `runs/<jobId>/assemble/final.mp4` — `runs-dev/...` on the host
- State + library + cost ledger: SQLite at `data/brainrot.db` (override with
  `--db` or `BRAINROT_DB`) — `data/dev.db` on the host

**`runs/<jobId>/` is a disposable local cache, not the durable copy.** Once a
job's `store` stage completes, the finished video also lives in the object
store (see Object storage below) and `library_objects` records its key —
`rm -rf runs/<jobId>` is then safe. Nothing deletes `runs/` for you
automatically; reclaiming disk is a manual operator call, and it's only safe
for jobs whose `store` stage actually finished (check `pnpm brainrot jobs` or
the dashboard first).

## Inspect

```bash
pnpm brainrot jobs    # last 20 jobs
pnpm brainrot costs   # per-day USD totals, last 7 days
```

## Object storage

Finished videos are uploaded to Cloudflare R2 by the `store` stage. Instagram
publishing requires this: `graph.instagram.com` rejects direct uploads with
`The parameter video_url is required` — Meta's servers fetch the video from a
URL you provide, so a finished video must be reachable over the public internet.

**Object storage is required to produce, including for a YouTube-only setup.**
The uploaded copy is the durable one — `runs/` is a disposable cache you can
reclaim at any time — so there is no fallback to local-only storage and no
"skip the upload" switch: one that silently wrote videos nowhere durable would
be a worse failure than refusing. With the `BRAINROT_S3_*` keys unset,
`produce` exits 1 and `produce-next` no-ops with `"reason":"bad-env"`, both
_before_ rendering rather than after.

1. In the Cloudflare dashboard, create an **R2 bucket** (e.g. `brainrot-videos`).
2. Create an **R2 API token** scoped to that bucket with **Object Read & Write**.
3. Fill the `BRAINROT_S3_*` keys in `.env`. The endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.

Verify before going live — this fetches the stored object back and checks it is
a well-formed, correctly-typed, complete MP4:

```bash
pnpm brainrot publish preflight <jobId>
```

Videos finished before object storage existed have no stored object and are
YouTube-only until uploaded:

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
port 9100. Point `.env` at it:

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

**A MinIO presigned URL is not reachable by Meta.** It is `localhost`, so it
proves content-type and completeness but nothing about public reachability.
Real Instagram publishing always needs real R2.

## Publishing

`ready` library videos upload automatically via the `publish` worker (see
Automation below), one channel-day's `videos_per_day` quota at a time, paced
only by a fixed 10-minute anti-burst cooldown between attempts — not by any
pace derived from `videos_per_day` — to every platform a channel declares. A
video is not "done" until every declared platform has taken it.

### YouTube

#### One-time setup (per Google Cloud project, not per channel)

1. Create (or reuse) a project at
   [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **YouTube Data API v3** for that project (APIs & Services →
   Enable APIs and Services → search "YouTube Data API v3" → Enable).
3. APIs & Services → Credentials → Create Credentials → OAuth client ID.
   **Application type: Desktop app** — Desktop-app clients accept a
   consent redirect to any loopback port, so the CLI's flow needs no
   redirect URI registered.
4. Add the client id/secret to `.env`:

   ```
   YT_CLIENT_ID=...
   YT_CLIENT_SECRET=...
   ```

5. Generate a token-encryption key and add it too. Credentials for every
   platform are stored AES-256-GCM-encrypted in the database under this one
   key — this key never leaves `.env`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   ```
   BRAINROT_TOKEN_KEY=<paste the 64-hex-char output>
   ```

#### Per-channel auth

Each YouTube channel is its own brand account and needs its own consent
grant — run once per channel, and again any time a grant expires or gets
revoked:

```bash
pnpm brainrot auth youtube --channel example
```

This opens the system browser to Google's consent screen. **Pick the
channel's YouTube brand account, not your personal Google account** —
the upload-only scope this flow requests can't read back which channel
you picked, so the CLI cannot warn you if you pick wrong. A wrong pick is
recoverable: re-run the command and pick correctly. The first published
URL in a wrong channel's digest is usually what surfaces the mistake.

### Instagram

#### One-time setup (per Meta app, not per channel)

1. Create an app at [developers.facebook.com](https://developers.facebook.com)
   and add the **Instagram** product (the "Instagram API" use case) — this
   provisions **Business Login for Instagram**, not Facebook Login for
   Business; don't add the Facebook Login product, its scopes
   (`instagram_content_publish`, `pages_show_list`, `business_management`)
   belong to a different login flow and Meta's consent screen rejects them
   as "Invalid Scopes" if this app requests them.
2. On the app's **Instagram → API setup with Instagram login** page: add
   yourself as an **Instagram tester** (no App Review needed for the
   operator's own accounts in development mode), note the **Instagram App
   ID/Secret** shown there — a different credential pair from the Facebook
   App ID at the top of the dashboard — and register
   **`https://localhost:51834/`** as a valid OAuth redirect URI (https, not
   http — Meta rejects a plain http redirect URI even for localhost; the
   Dashboard will likely save it with the trailing slash regardless of
   whether you type one — matching it is required, the code-exchange step
   validates the redirect URI as an exact string, unlike the more lenient
   consent screen). The flow terminates that TLS connection itself with a
   fresh self-signed certificate each run; your browser will show a
   one-time "connection not private" warning after you approve — click
   through it, that's expected, not a sign anything's wrong.
3. Add the Instagram app id/secret to `.env`:

   ```
   IG_APP_ID=...
   IG_APP_SECRET=...
   ```

4. `BRAINROT_TOKEN_KEY` from the YouTube setup above is reused as-is —
   Instagram's credential is encrypted with the same key, no second one to
   generate.

Each target account must be an Instagram **Business or Creator** account —
convert a personal account under Instagram settings if needed.

#### Per-channel auth

```bash
pnpm brainrot auth instagram --channel example
```

This opens the system browser to Instagram's consent screen. **Pick the
channel's Instagram account** — as with YouTube, a wrong pick is recoverable
by re-running the command.

### Channel config

Add a `[publish]` table to a channel's TOML to opt it into the publish
pool — channels without one never publish. Each platform the channel
publishes to gets its own `[publish.<platform>]` sub-table; declare both to
cross-post the same rendered video to both platforms:

```toml
videos_per_day = 3

[publish]

[publish.youtube]
privacy = "private"
category_id = 24
made_for_kids = false

[publish.instagram]
ig_user_id = "17841400000000000"
share_to_feed = true
```

`videos_per_day` is the only volume knob: the pipeline produces that many
videos a day and publishes each one to every platform the channel declares.
There is no posting window anymore — the daemon's publish worker checks
every channel continuously and fires the instant one is due. "Due" means two
things: under its `videos_per_day` count for the local calendar day, and
past a fixed 10-minute cooldown (`PUBLISH_COOLDOWN_MS`) since that channel's
last attempt. The cooldown is an anti-burst guard, not a schedule — a
platform seeing six uploads land in three minutes reads it as spam — so
nothing spreads a day's quota evenly; a channel with several videos ready at
once can post all of them back-to-back, ten minutes apart, rather than every
few hours. The count is still a same-day ceiling, not a guarantee: a channel
with nothing ready, or already at its daily count, simply stays idle until
there's more to do.

Platform limits are enforced for you at config load. YouTube's Data API
allows about 6 uploads/day per Google Cloud project shared across every
channel, and Instagram allows 50/day per account — so a channel set declaring
more than that fails to load with a message naming the offending channels.
Lower `videos_per_day`; there is nothing to set by hand.

A channel that falls short of its `videos_per_day` count on a given day —
the machine was asleep, a platform's quota was exhausted, credentials broke —
has no makeup post; the digest reports any channel that published fewer
videos than its `videos_per_day` yesterday, with a per-platform split, so the
shortfall is visible without hunting through logs.

`backlog_days` (default `2`) caps how many finished videos a channel may hold
before `produce-next` stops producing more for it. "Held" means every video
the channel has not finished with: awaiting review, awaiting its first
platform, and already live on one declared platform but still owed to
another. A video leaves the count once every platform the channel declares
has published it, given up on it after three rejections, or run out of time
for it.

That last case is the other half of the knob: `backlog_days` doubles as the
horizon a video is given to find a publish slot. Past it — and only once
another video actually published _while this one was waiting_, so neither a
publish outage nor the first upload that recovers from one ever counts — the
video is written off as aged out and its stored object is deleted. That includes a video still awaiting review: approve it within
`backlog_days` or its bytes are reclaimed, `library approve` refuses it, and
the daily digest tells you to reject it. `[scout]
queue_days` (default `3`) is the same idea one stage earlier: it caps how many
scored candidate topics a channel may hold queued before `scout` stops
fetching and scoring more for it.

### Quota

The two platforms' quotas are scoped differently and enforced for you at
config load — a channel set declaring more `videos_per_day` than a platform
allows fails to load with a message naming the offending channels, before
`produce` or any daemon worker unit can run at all. `publish-next` re-checks
the same cap per unit as a backstop.

- **YouTube** is per Google Cloud **project**, not per channel: 10,000
  units/day at 1,600 units/upload works out to roughly **6 uploads a day,
  project-wide, across every channel sharing that project**. If six a day
  isn't enough headroom for your channel count, request a quota increase at
  <https://support.google.com/youtube/contact/yt_api_form>, then raise
  `videos_per_day` accordingly.
- **Instagram** is per IG account, i.e. per channel: Meta's Content
  Publishing API allows **50 posts per rolling 24h per account** — a limit no
  realistic `videos_per_day` comes close to.

There is nothing to tune by hand: lower `videos_per_day` if a channel set
won't load. `BRAINROT_YT_UPLOADS_PER_DAY` / `BRAINROT_IG_UPLOADS_PER_DAY` env
overrides still exist, but only as a test escape hatch — they are not an
operator setting.

## Automation

Production is one long-running process: `brainrot run` is the container's
`CMD` and starts a daemon with four workers running concurrently — there is
no host cron, no launchd agent, and no per-worker container anymore. Each
worker polls in a tight loop: check demand, do one unit of work if there is
any, and re-check immediately; an idle worker sleeps 30 seconds before
checking again, and a worker whose unit throws logs the error and sleeps 60
seconds rather than taking the daemon down. `scout` fills the topic queue,
`produce` performs one unit of work per pass (resume one blocked job or
produce one video), `publish` picks one `ready` video from the channel
furthest behind its `videos_per_day` pace and fans it out to every platform
that channel declares (see Publishing above), and `digest` prints a daily
report once per local day. Because throughput now follows demand rather than
a clock, there's nothing scheduled to fall behind: a channel with videos
ready gets them produced and published as fast as its own gates (backlog
caps, cooldowns, quotas) allow, and a channel with nothing to do costs
nothing but an idle poll.

No API keys are needed for scouting: reddit subreddits and RSS sources are
both read through their public feeds. Reddit's feed carries no `stickied`
flag, but it does name the submitting account, so AutoModerator's recurring
scheduled threads ("Basic cosmology questions weekly thread" and friends) are
dropped before scoring and counted as `droppedAutomated`. Each week's instance
is a new post id, so dedupe alone would let them cost a scoring slot forever.
A sticky posted by a human mod still reaches the scorer and simply scores low.

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
whose target is an image. On the host it obeys the same dev defaults as every
other command, so name the production database explicitly or it will quietly
find nothing to do:

```bash
BRAINROT_DB=data/brainrot.db pnpm brainrot topics prune-media --dry-run
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
`brainrot` (the daemon: `brainrot run`, four workers polling for demand),
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
`bad-env` (object storage is not configured —
checked before the lease, so a full render is never paid for just to fail at
the `store` stage), or `config-error`; `publish` noops with `lease-held`,
`paced` (this channel attempted less than `PUBLISH_COOLDOWN_MS`, 10 minutes,
ago — an anti-burst guard, not a schedule), `daily-count-met` (this channel
already hit `videos_per_day` for the local calendar day), `no-publish-channel`
(no channel in the dir declares `[publish]`), `platform-quota`,
`no-ready-video`, `no-video-file` (the `ready` row's file was pruned from
`runs/`), `no-auth`, `bad-env` (a malformed `BRAINROT_TOKEN_KEY` or
`BRAINROT_YT_UPLOADS_PER_DAY`), or `config-error` (the channels dir would not
load); `scout` with `lease-held`, `queue-full`, `no-scout-sources` (a channel
was due for a recheck but none of the due ones declares a `[scout]` source),
or that same `config-error`. The `error` field of a `config-error` or
`bad-env` line carries the cause — under the daemon that JSON line is the
only report, deliberately: an unstructured stderr print would bypass the idle
dedupe and repeat every 30 seconds. The one-shot commands below still echo it
to stderr, where a human is watching. A worker whose unit throws instead
logs `{"worker":...,"action":"worker-error","error":...}` and backs off for
60 seconds rather than retrying immediately or taking the daemon down — that
line, not an exit code, is the daemon's failure signal, since the daemon
itself never exits under normal operation.

The standalone `pnpm brainrot produce-next` / `publish-next` / `scout` /
`digest` commands (useful for a manual, one-shot run outside the daemon)
keep the old exit-code contract: exit `0` for any noop or
successful action, exit `1` when real work failed — a `failed`/`blocked`
produce, a fan-out with any platform entry not `published` (a
`publish-failed` result, or a `published` one carrying a
`failed`/`unknown`/`skipped` leg), or a scout run whose every channel died.

### Cadence

There is no schedule to configure — throughput comes from the poll loop
itself (`src/loop/daemon.ts`). Each of the four workers checks demand, does
one unit of work if there is any, and re-checks immediately; an idle worker
sleeps 30 seconds (`IDLE_SLEEP_MS`) before its next check, and a worker whose
unit throws sleeps 60 seconds (`ERROR_SLEEP_MS`) instead. `scout` layers a
per-channel clock on top of that poll, `SCOUT_RECHECK_MS` (20 minutes), so a
channel isn't refetched on every 30-second idle poll even when nothing about
it changed — the clock is in-memory, so a daemon restart resets it and
re-scouts immediately, which is harmless. `digest` is the one worker still on
a real clock: it fires once per local day at or after 08:00 (`DIGEST_HOUR`),
printed to the log stream only — nothing else delivers it — and a restart
later the same day can re-fire it once.

Times that matter are container-local (`TZ=America/Chicago`, set in
`deploy/docker/Dockerfile` and pinned again in `docker-compose.yml`'s
`environment:` block — an `env_file` value of the same name would otherwise
override the image's `ENV`), regardless of the host Mac's own timezone.
Changing any of the constants above, or `PUBLISH_COOLDOWN_MS`
(`src/publish/schedule.ts`), means editing the source and running
`docker compose build brainrot`, same as any other source change. There is
no hot reload.

### Dashboard

A read-only web view of the production database, served by the `dashboard`
compose service:

```bash
docker compose up -d dashboard
open http://127.0.0.1:8787
```

Five views: an overview (job health, spend against all three budget caps,
held leases, YouTube quota), jobs with a per-stage timeline and the raw error
text, the library with inline video playback, the publish schedule as a
day-by-ordinal grid including attempts that never happened, and the scout
topic queue.

Every page takes `?db=dev` to view `data/dev.db` instead of the production
database; the header says which one you are looking at and dev shows a banner.

The dashboard **never writes**. Its connection opens read-only, so
`library approve/reject`, `topics requeue/reject/prune-media` and
`publish retry/mark-done`
remain CLI-only — those race a live daemon worker, and a button is not the right
affordance for that. The `brainrot-data` mount is read-write on purpose: SQLite
must create the `-shm` file to read a WAL database, so the read-only guarantee
lives in the connection flag rather than the mount.

Note the dashboard mounts that database from the same named volume the daemon
uses, so `?db=dev` now answers **503** in the container: `data/dev.db` is a
host-side file that lives outside the volume, and `BRAINROT_DEV_DB` points at
a path the container has no access to. To browse the dev database, run the
dashboard on the host (`pnpm exec tsx src/dashboard/server.ts`) instead.

The port is bound to `127.0.0.1` and there is no authentication. Do not
republish it on `0.0.0.0`.

### Development vs. production

|          | Production (container) | Development (host)             |
| -------- | ---------------------- | ------------------------------ |
| channels | `channels/`            | `channels-dev/`                |
| db       | `data/brainrot.db`     | `data/dev.db`                  |
| runs     | `runs/`                | `runs-dev/`                    |
| voice    | real chain             | `--dev` / `[voice] dev = true` |

A bare `pnpm brainrot ...` on the host reads and writes only the development
triple — the host's `.env` carries those defaults. The same command run
inside the container reads and writes only production, because
`docker-compose.yml`'s `environment:` block overrides all three no matter
what the host's `.env` says:

```bash
pnpm brainrot jobs                               # host: reads data/dev.db
docker compose exec brainrot pnpm brainrot jobs  # container: reads data/brainrot.db
```

This is what makes local iteration safe: a half-finished channel's jobs are
invisible to the production `produce-next` loop, and its spend never enters
the ledger the production budget caps read.

### Promotion

Once a channel developed under `channels-dev/` is ready to go live, stop the
daemon first — the `publish` worker reads `oauth_tokens` from inside the
container on every unit it does (immediately after work, at most every 30s
while idle), and this writes that table from the host:

```bash
cp channels-dev/<name>.toml channels/<name>.toml   # edit as needed

docker compose exec brainrot pnpm brainrot auth youtube --channel <name> --headless
# (and/or `auth instagram --channel <name> --headless`, for whichever
# platforms the channel's [publish] table declares)
```

`--headless` prints a consent URL instead of launching a browser. Open it on
your own machine, grant consent, and the redirect lands back in the container;
the command then prints its confirmation and exits. Instagram's callback is
HTTPS with a per-run self-signed cert, so the browser shows a
"connection not private" interstitial once — clicking through is expected.

The daemon does **not** need to be stopped. `auth` writes one `oauth_tokens`
row, and the publish worker reading that table concurrently is exactly what
WAL plus `busy_timeout` is for — unlike the recovery commands below, which
mutate job state a live worker may also be acting on.

Three things have to line up for the callback to arrive, which is why
`--headless` sets all three at once rather than leaving them as separate
flags (`authFlowTransport` in `src/publish/oauth-flow.ts`):

- **The listener binds `0.0.0.0`, not `127.0.0.1`.** A container-loopback
  listener is unreachable through a published port. Compose publishes to
  `127.0.0.1` on the _host_, so the callback still is not reachable
  off-machine.
- **The port is fixed**, since Compose must publish it before the flow starts
  and cannot learn an ephemeral one chosen at runtime — `YT_AUTH_DEFAULT_PORT`
  (51835) and `IG_AUTH_DEFAULT_PORT` (51834). `--port` overrides, but must
  then match `docker-compose.yml`, and Instagram's is additionally
  pre-registered with Meta so it cannot be renumbered unilaterally.
- **The consent URL is printed** rather than opened, because `open` is a macOS
  binary absent from the Debian image, and there is no browser in there to
  look at anyway.

Validation is unaffected: `auth <platform>` still calls `loadChannelsDir()`
against the directory it's pointed at, which enforces the
basename-equals-`name` invariant and rejects duplicate declared names — a
malformed promotion fails at promotion time, not at the next tick.

Note that `src/` is baked into the image, not mounted, so a code change to the
auth flow needs `docker compose build brainrot` before `exec` will run it.

### Operating the database

All persistent state — jobs, library, topics, costs, leases, publishes and
the encrypted `oauth_tokens` — lives in the `brainrot-data` **named volume**,
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
  new (require('better-sqlite3'))('data/brainrot.db')
    .exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker run --rm -v project-brainrot_brainrot-data:/d -v "$PWD":/out alpine \
  sh -c 'mv /d/backup.db /out/brainrot-backup.db'
```

`docker volume rm brainrot-data` destroys every OAuth grant along with the
run history — re-granting consent per channel per platform is the only way
back, so take a snapshot before anything that recreates volumes.

### Recovery

Everything else that renders or mutates job state goes through the
container, not the host — same binary, same filesystem layout, no drift.
Manual commands take no lease of their own, so a hand-run invocation can
execute concurrently with a live daemon worker and both may act on the same
job/topic — `produce-next` holds a `produce` lease and `publish-next` holds
its own separate `publish` lease, but neither one covers a manual command.
Stop the daemon first, then run the command as a one-shot container:
`docker compose exec` requires a running service, and `stop` just took it
down, so recovery commands use `docker compose run --rm --no-deps` instead —
it starts a fresh container from the same image, with the same env and
mounts, and `--no-deps` keeps it from pulling `whisperx` back up as a side
effect.

```bash
docker compose stop brainrot
docker compose run --rm --no-deps brainrot pnpm brainrot resume <jobId>
docker compose run --rm --no-deps brainrot pnpm brainrot library approve <jobIds...>
docker compose run --rm --no-deps brainrot pnpm brainrot publish retry <jobId>
docker compose start brainrot
```

The same pattern covers `produce`, `library reject`, and `publish
mark-done`. Restart the daemon (`docker compose start brainrot`) once
recovery is done — its workers stay paused until you do.

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
  (topics to scout, videos to produce or publish) and acts on it right away,
  subject to the same gates as always — `videos_per_day`,
  `PUBLISH_COOLDOWN_MS`, `backlog_days`. A channel that stayed under its
  `videos_per_day` count while the machine slept simply stays due; there is
  still no makeup once that count is met for the day.
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

- **Budget caps and the daily video quota roll over at UTC midnight;
  publishing rolls over at local midnight.** The spend caps and the
  per-channel `videos_per_day` quota both key off the cost ledger /
  `jobs.created_at`, which is UTC, so "today" for those flips at midnight
  UTC — 7 pm EST / 8 pm EDT, i.e. late afternoon/early evening US-Eastern —
  not at local midnight. Expect a fresh production quota and budget headroom
  in the early evening. The publish quota and cooldown
  (`src/publish/schedule.ts`) and both platforms' per-day upload counters
  (YouTube's project-wide one and Instagram's per-channel one) are the
  opposite: they key off the **container's** local wall-clock day (`TZ` is
  pinned to `America/Chicago` in `docker-compose.yml`'s `environment:` block
  regardless of the host Mac's own timezone), so they roll over at local
  midnight, not UTC midnight.
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
