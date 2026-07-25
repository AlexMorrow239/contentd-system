# Brainrot Machine

Automated short-form video pipeline. `brainrot produce` turns a topic into a
finished, QC-checked, word-captioned 9:16 MP4 in the library.

## Prerequisites

- Node >= 22 and [pnpm](https://pnpm.io)
- [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
- Docker (for the WhisperX caption-alignment sidecar — volume tier and premium
  voice-fallback runs; a premium run whose ElevenLabs synth succeeds never
  touches it)

## Setup

```bash
pnpm install
cp .env.example .env          # fill in provider keys (see below)
docker compose up -d whisperx # caption alignment sidecar
```

Keys in `.env`:

- `ANTHROPIC_API_KEY` — scripts (both tiers), premium vision checks
- `FAL_KEY` — premium visuals (FLUX keyframes, Kling/MiniMax image-to-video)
- `ELEVENLABS_API_KEY` — premium voice (unset: premium falls back to kokoro/edge-tts)
- `BRAINROT_GLOBAL_DAILY_USD` — cross-channel daily spend cap in USD (default 25)

## Seed background footage

Drop vertical-friendly clips into the channel's background folder(s) (default
`assets/bg/`) and royalty-free music into `assets/bgm/`. The volume tier picks
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
# options: --tier volume|premium  --db data/brainrot.db  --runs-root runs
```

Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
`1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

## Premium tier

`--tier premium` swaps library footage for AI-generated visuals: per scene, a
FLUX keyframe is generated, vision-checked by Claude, then animated with Kling
image-to-video (all via fal.ai). Narration comes from ElevenLabs with
word-level timings (no WhisperX dependency on the happy path), and QC adds
scene-coverage and vision spot checks.

```bash
pnpm brainrot produce --channel channels/example.toml \
  --topic "Why is Venus so hot?" --tier premium
```

Requires `ANTHROPIC_API_KEY`, `FAL_KEY`, and `ELEVENLABS_API_KEY` in `.env`.

Cost envelope: a typical ~35s premium video runs **typically $3.00–6.00** (5s
scenes ~$0.42/clip, 10s scenes ~$0.84/clip; ElevenLabs + keyframes + vision
checks add ~$0.15–0.40); the **$7.00** default per-video cap
(`premium_per_video_usd` in the channel TOML) absorbs retries — long narrations
(>~14 words) force 10s clips, so shorter scenes are cheaper. A breach parks the
job `blocked` before the overspending call fires. Per-channel (`per_day_usd`)
and global (`BRAINROT_GLOBAL_DAILY_USD`, default $25/day) daily caps stack on top.

## Where outputs land

- Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
  `words.json`, then `background.mp4` for volume or `scene-NN.png` /
  `scene-NN.mp4` + `scenes.json` for premium, `final.mp4`, `qc.json`)
- Finished video: `runs/<jobId>/assemble/final.mp4`
- State + library + cost ledger: SQLite at `data/brainrot.db` (override with
  `--db` or `BRAINROT_DB`)

## Inspect

```bash
pnpm brainrot jobs    # last 20 jobs
pnpm brainrot costs   # per-day USD totals, last 7 days
```

## Publishing (YouTube)

`ready` library videos upload to YouTube Shorts automatically via the
`publish-next` cron tick (see Automation below), on a per-channel schedule
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

## Automation (cron)

The production loop is four cron-invoked commands: `scout` fills the topic
queue, `produce-next` performs one unit of work per tick (resume one blocked
job or produce one video), `publish-next` uploads one `ready` video per tick
into its channel's next due slot (see Publishing (YouTube) above), and
`digest` prints a daily report.

No API keys are needed for scouting: reddit subreddits are read through their
public `.rss` feeds and RSS sources through their own. Reddit's Data API is an
optional upgrade — if you get a script app approved under its Responsible
Builder Policy, set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` in `.env` and
the scout switches to app-only OAuth (richer JSON, mod stickies filtered out,
100 requests/min). Without them the feed path applies, where stickied posts
are indistinguishable from real ones and simply score low.

Paste into `crontab -e`, adjusting the paths:

```cron
# cron runs with a bare PATH (/usr/bin:/bin): pnpm, node, and ffmpeg do not
# resolve without this line. Find your dirs with `which pnpm` / `which ffmpeg`.
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

# Digest delivery is operator wiring: cron mails each job's output to MAILTO
# (needs working local mail), or replace the digest line with a pipe into
# your notifier of choice.
MAILTO=you@example.com

# Scout trends into the topic queue, 3x/day at 07:05 / 12:05 / 17:05. Staggered
# 5 minutes off the hour so it never co-fires with the produce-next tick at :00
# — defense in depth on top of the DB busy_timeout, since scout and produce-next
# are two processes writing one SQLite file.
5 7,12,17 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot scout >> logs/scout.log 2>&1

# One unit of production per tick (*/25 fires at :00, :25 and :50 each hour).
*/25 * * * * cd /Users/alex/code/project-brainrot && pnpm brainrot produce-next >> logs/produce-next.log 2>&1

# One publish attempt per tick, on whichever due slot is furthest behind its
# channel's cadence (*/15 keeps slots filling within ~15 min of their
# configured time). Unlike scout, this is deliberately NOT staggered off
# produce-next's :00/:25/:50 — the two touch disjoint rows (produce-next
# inserts new library rows; publish-next updates a ready row's state), and WAL
# journaling plus the busy_timeout=5000 pragma make a same-minute co-fire safe.
*/15 * * * * cd /Users/alex/code/project-brainrot && pnpm brainrot publish-next >> logs/publish.log 2>&1

# Daily digest at 08:00 — stdout goes to MAILTO; nothing else delivers it.
0 8 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot digest
```

- **`cd` into the repo, absolute paths only.** Every entry `cd`s to the repo
  root first so `.env` (dotenv), `channels/`, `data/brainrot.db`, `runs/`,
  and `logs/` all resolve. Replace `/Users/alex/code/project-brainrot` with
  your absolute repo path and run `mkdir -p logs` in the repo once before
  the first firing. If you would rather not set `PATH`, use the absolute
  binary path from `which pnpm` in each entry instead.
- **Budget caps and tier quotas roll over at UTC midnight; publishing rolls
  over at local midnight.** The spend caps and the per-channel tier_mix quota
  both key off the cost ledger / `jobs.created_at`, which is UTC, so "today"
  for those flips at midnight UTC — 7 pm EST / 8 pm EDT, i.e. late
  afternoon/early evening US-Eastern — not at local midnight. Expect fresh
  quota slots and budget headroom in the early evening. Publish slots and the
  YouTube per-day upload counter are the opposite: they key off the machine's
  local wall-clock day, so they roll over at local midnight, not UTC
  midnight.
- **Premium stays gated.** `produce-next` only claims premium topics you
  have approved (`pnpm brainrot topics approve <id>`) unless the channel
  TOML sets `auto_premium = true` under `[scout]`; volume flows unattended.
  A `{"action":"noop","reason":"lease-held"}` tick is normal while a long
  render from the previous firing is still running — `scout` takes a lease of
  its own (30 min) and prints the same line if a previous run is still going.
- **Every tick prints one JSON line, and a noop is not a failure.**
  `produce-next` noops with `lease-held`, `no-eligible-work`, `no-fal-key`,
  `claim-conflict` (an operator command won a topic or job mid-tick), or
  `config-error`; `publish-next` with `lease-held`, `no-due-slot`,
  `platform-quota`, `no-ready-video`, `no-video-file` (the `ready` row's file
  was pruned from `runs/`), `no-auth`, `claim-conflict`, `bad-env` (a
  malformed `BRAINROT_TOKEN_KEY` or `BRAINROT_YT_UPLOADS_PER_DAY`), or
  `config-error` (the channels dir would not load — the message also goes to
  stderr); `scout` with `lease-held` or that same `config-error`. All of those
  exit `0`. Exit `1` means real work failed: a `failed`/`blocked` produce, a
  `publish-failed` upload attempt, or a scout run whose every channel died.
- **A stranded topic can be returned to the queue.** A topic stays `claimed`
  for as long as its job might still run, so a job abandoned for good leaves
  its topic bound forever. `pnpm brainrot topics requeue <id>` returns it to
  `candidate` and unbinds the dead job; it refuses only while a `queued` or
  `running` job still holds the topic. A `blocked` job's topic can be
  requeued — that job sits out the resume pass until an operator repairs the
  config behind it, and unbinding is safe because a later resume of that job
  keys its `used` flip on `job_id`, which by then matches nothing.
- **Manual runs take no lease.** `produce` and `resume` run outside the
  produce-next lease, so a hand-run invocation can execute concurrently with a
  live tick and both may act on the same job/topic. Stop the produce-next cron
  line (or wait for `lease-held` ticks to clear) before running `produce` or
  `resume` by hand. The same applies on the publishing side: `publish-next`
  takes its own `publish` lease (separate from `produce`'s), but
  `brainrot auth youtube`, `library approve`/`reject`, and
  `publish retry`/`mark-done` all run outside it — stop the publish-next
  cron line before running any of those by hand against the same channel.

## Tests

```bash
pnpm test                   # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract          # real paid calls, ~$0.20 total (FLUX image $0.05, MiniMax clip ~$0.10, ElevenLabs synth ~$0.01, one LLM call)
pnpm test:contract:premium  # additionally renders one real Kling clip (~ $0.40 total)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
