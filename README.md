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

## Inspect

```bash
pnpm brainrot jobs    # last 20 jobs
pnpm brainrot costs   # per-day USD totals, last 7 days
```

## Publishing (YouTube)

`ready` library videos upload to YouTube Shorts automatically via the
`publish-next` tick (see Automation below), on a per-channel schedule
of local-time slots.

### One-time setup (per Google Cloud project, not per channel)

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

5. Generate a token-encryption key and add it too. Refresh tokens are
   stored AES-256-GCM-encrypted in the database — this key never leaves
   `.env`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   ```
   BRAINROT_TOKEN_KEY=<paste the 64-hex-char output>
   ```

### Per-channel auth

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

### Channel config

Add a `[publish]` table to a channel's TOML to opt it into the publish
pool — channels without one never publish:

```toml
[publish]
slots = ["10:00", "14:00", "19:00"]  # machine-local HH:MM, unique
platforms = ["youtube"]              # only valid value in v1
privacy = "public"                   # 'public' | 'unlisted' | 'private'
category_id = 24                     # YouTube category; 24 = Entertainment
made_for_kids = false
```

A slot missed while the machine was asleep fills late the same day; a
slot still open at local midnight lapses with no makeup post — the
digest reports lapsed slots so cadence can be adjusted.

### Quota

YouTube's upload quota is per Google Cloud **project**, not per channel:
10,000 units/day at 1,600 units/upload works out to roughly **6 uploads
a day, project-wide, across every channel sharing that project**.
`publish-next` enforces this with a hard pre-upload gate
(`BRAINROT_YT_UPLOADS_PER_DAY`, default 6). If six a day isn't enough
headroom for your channel count, request a quota increase at
<https://support.google.com/youtube/contact/yt_api_form>.

## Automation

The production loop is four commands, scheduled inside the container by
supercronic — there is no host cron and no launchd agent anymore. `scout`
fills the topic queue, `produce-next` performs one unit of work per tick
(resume one blocked job or produce one video), `publish-next` uploads one
`ready` video per tick into its channel's next due slot (see Publishing
(YouTube) above), and `digest` prints a daily report.

No API keys are needed for scouting: reddit subreddits and RSS sources are
both read through their public feeds. Reddit's feed carries no `stickied`
flag, so mod stickies are indistinguishable from real posts and simply score
low.

### Start

```bash
docker compose up -d --build
```

Use `--build`, not a bare `up -d`: Compose will happily start a stale local
`project-brainrot-brainrot:latest` image instead of rebuilding it, which
means "start" can silently run old code. `--build` makes it always build (or
confirm current) first.

This brings up both services: `whisperx` (the caption-alignment sidecar) and
`brainrot` (supercronic running the schedule below), which waits on
`whisperx`'s healthcheck before its own ticks begin. There is one log
stream for everything the loop does:

```bash
docker compose logs -f brainrot
```

Each tick prints one JSON line, and a `noop` line is normal, not a failure —
`produce-next` noops with `lease-held`, `no-eligible-work`, `claim-conflict`
(an operator command won a topic or job mid-tick), or `config-error`;
`publish-next` with `lease-held`, `no-due-slot`, `platform-quota`,
`no-ready-video`, `no-video-file` (the `ready` row's file was pruned from
`runs/`), `no-auth`, `claim-conflict`, `bad-env` (a malformed
`BRAINROT_TOKEN_KEY` or `BRAINROT_YT_UPLOADS_PER_DAY`), or `config-error`
(the channels dir would not load — the message also goes to stderr); `scout`
with `lease-held` or that same `config-error`. All of those exit `0`. Exit
`1` means real work failed: a `failed`/`blocked` produce, a `publish-failed`
upload attempt, or a scout run whose every channel died.

### Schedule

| Command | Cadence |
|---|---|
| `scout` | 07:05, 12:05, 17:05 — staggered 5 min off the hour so it never co-fires with `produce-next` |
| `produce-next` | every 25 min |
| `publish-next` | every 15 min — deliberately not staggered off `produce-next`; the two touch disjoint rows and WAL plus the `busy_timeout=5000` pragma make a same-minute co-fire safe |
| `digest` | 08:00 — printed to the log stream only, nothing else delivers it |

Times are container-local (`TZ=America/Chicago`, set in
`deploy/docker/Dockerfile`), regardless of the host Mac's own timezone. The
schedule itself is `deploy/docker/crontab`, baked into the image — changing
it means editing that file and running `docker compose build brainrot`,
same as any other source change. There is no hot reload.

### Development vs. production

|  | Production (container) | Development (host) |
|---|---|---|
| channels | `channels/` | `channels-dev/` |
| db | `data/brainrot.db` | `data/dev.db` |
| runs | `runs/` | `runs-dev/` |
| voice | real chain | `--dev` / `[voice] dev = true` |

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
loop first — `publish-next` reads `oauth_tokens` from inside the container
every 15 minutes, and this writes that table from the host:

```bash
docker compose stop brainrot

cp channels-dev/<name>.toml channels/<name>.toml   # edit as needed

BRAINROT_DB=data/brainrot.db BRAINROT_CHANNELS_DIR=channels \
  pnpm brainrot auth youtube --channel <name>

docker compose start brainrot
```

`auth youtube` is the one command that still runs on the host instead of
through a container, and the explicit `BRAINROT_DB`/`BRAINROT_CHANNELS_DIR`
above is what points it at production rather than the host's own dev
defaults. Two things force it out of the container: `src/publish/oauth-flow.ts:14`
shells out to macOS `open` to launch the consent screen, which does not exist
in the Debian image, and the flow binds an ephemeral loopback port that
Compose has no way to publish in advance (the port isn't chosen until the
flow starts). Because `data/` is a bind mount shared with the container, the
AES-256-GCM-encrypted refresh token still lands in the production DB
regardless of which side wrote it. Running on the host costs nothing in
validation: `auth youtube` still calls `loadChannelsDir()` against the
directory it's pointed at, which enforces the basename-equals-`name`
invariant and rejects duplicate declared names — a malformed promotion fails
at promotion time, not at the next tick.

### Recovery

Everything else that renders or mutates job state goes through the
container, not the host — same binary, same filesystem layout, no drift.
Manual commands take no lease of their own, so a hand-run invocation can
execute concurrently with a live tick and both may act on the same
job/topic — `produce-next` holds a `produce` lease and `publish-next` holds
its own separate `publish` lease, but neither one covers a manual command.
Stop the loop first, then run the command as a one-shot container:
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
mark-done`. Restart the loop (`docker compose start brainrot`) once recovery
is done — ticks stay paused until you do.

- **A stranded topic can be returned to the queue.** A topic stays `claimed`
  for as long as its job might still run, so a job abandoned for good leaves
  its topic bound forever. `pnpm brainrot topics requeue <id>` returns it to
  `candidate` and unbinds the dead job; it refuses only while a `queued` or
  `running` job still holds the topic. A `blocked` job's topic can be
  requeued — that job sits out the resume pass until an operator repairs the
  config behind it, and unbinding is safe because a later resume of that job
  keys its `used` flip on `job_id`, which by then matches nothing.

- **A stranded `running` job is now a per-deploy event, not just a crash
  scenario.** There is no SIGTERM handling in `src/` and no
  `stop_grace_period` in `docker-compose.yml`, so Docker's 10-second default
  grace period applies: `docker compose stop`/`restart`/`down` — and every
  rebuild-deploy, since that's a stop-then-recreate — can kill a render
  mid-stage. That leaves `jobs.status='running'`, the current stage
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

- **A sleeping Mac drops ticks, with no catch-up firing.** launchd used to
  coalesce missed runs after the machine woke up; supercronic does not. A
  missed publish slot simply stays due for the rest of the local day and
  fills on the next tick; a slept-through `scout` window is skipped until its
  next scheduled firing.
- **Docker Desktop must be set to start at login**, or nothing runs after a
  reboot and there is no alarm that fires — the failure looks identical to an
  idle day.
- **`depends_on: service_healthy` only gates a `compose up`.** It does not
  survive a Docker Desktop restart: on reboot the engine starts every
  `restart: unless-stopped` container independently of the dependency graph,
  so `brainrot` can start ticking, including a `produce-next` that needs
  captions, before `whisperx`'s healthcheck reports healthy. Nothing crashes
  — the affected job just fails or blocks at the captions stage and is
  recoverable the normal way — but it means a reboot is not guaranteed to
  reproduce the startup ordering `docker compose up -d` gives you.

### Timezones: two different clocks

- **Budget caps and the daily video quota roll over at UTC midnight;
  publishing rolls over at local midnight.** The spend caps and the
  per-channel `videos_per_day` quota both key off the cost ledger /
  `jobs.created_at`, which is UTC, so "today" for those flips at midnight
  UTC — 7 pm EST / 8 pm EDT, i.e. late afternoon/early evening US-Eastern —
  not at local midnight. Expect a fresh quota slot and budget headroom in the
  early evening. Publish slots and the YouTube per-day upload counter are the
  opposite: they key off the **container's** local wall-clock day (`TZ` is
  pinned to `America/Chicago` in `docker-compose.yml`'s `environment:` block
  regardless of the host Mac's own timezone), so they roll
  over at local midnight, not UTC midnight.
  A `{"action":"noop","reason":"lease-held"}` tick is normal while a long
  render from the previous firing is still running — `scout` takes a lease of
  its own (30 min) and prints the same line if a previous run is still going.

## Tests

```bash
pnpm test           # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract  # real paid calls, a few cents total (ElevenLabs synth, one LLM call)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
