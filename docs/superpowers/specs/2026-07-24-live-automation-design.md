# Live automation on the `test` channel — design

Date: 2026-07-24
Status: approved design, pending implementation plan

## Goal

Run the existing pipeline unattended against real providers and the real
YouTube channel already authed as `test`: scout fills a topic queue on a
schedule, one premium-visual video is produced per day with free local voice,
and it uploads to YouTube on a daily slot — with no human in the loop for the
happy path.

This is a soak test. Its purpose is to find out what actually breaks when the
loop runs by itself, at real cost, before any of it is public.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| YouTube privacy | `private` | Real upload, real quota, real OAuth; zero public exposure |
| Cadence | 1 premium video/day, 0 volume | ~$3-5/day expected |
| Voice | kokoro/edge-tts (free), not ElevenLabs | Makes the WhisperX sidecar load-bearing |
| Scout sources | Evergreen-leaning astronomy | Timeless facts survive the produce→publish lag |
| Scheduler | launchd | A slot missed while asleep still fires on wake |
| QC failure | Manual gate retained | A QC-failed video publishes nothing until reviewed |
| Self-healing | None beyond config | A failed job stops production until an operator acts |

The last two are deliberate. On a first unattended run the failures are the
product — auto-recovering them would hide the thing we are trying to observe.

## Non-goals

- No code changes to the pipeline, loop state machine, or approval paths.
- No auto-retry of `failed` jobs, no auto-requeue of stranded topics.
- No `runs/` pruning.
- No public publishing, no second channel.

## Design

### 1. `channels/test.toml`

Four edits. Full resulting file:

```toml
name = "test"
niche = ["space facts", "astronomy"]
script_model = "claude-sonnet-5"
bg_dir = "assets/bg"
bgm_dir = "assets/bgm"

[tier_mix]
volume = 0
premium = 1

[voice]
volume = "af_heart"

[scout]
subreddits = ["space", "astronomy", "askscience", "cosmology"]
rss = [
  "https://phys.org/rss-feed/space-news/",
  "https://earthsky.org/feed/",
]
min_score = 60
per_source_limit = 25
auto_premium = true

[premium]
image_model = "fal-ai/flux/dev"
video_model = "fal-ai/kling-video/v3/standard/image-to-video"
style_prefix = "vivid digital illustration, cinematic lighting"
scene_concurrency = 3

[caption_style]
font = "Inter"
font_size_px = 72
active_color = "#FFD700"
inactive_color = "#FFFFFF"
stroke_px = 8

[budget]
per_video_usd = 0.5
premium_per_video_usd = 8.0
per_day_usd = 10.0

[publish]
slots = ["10:00", "14:00", "19:00"]
platforms = ["youtube"]
privacy = "private"
category_id = 24
made_for_kids = false
```

Rationale for each change:

- **`volume = 0`** — `plan-tick.ts:89` gates on `volumeToday < tierMix.volume`,
  so `0 < 0` permanently closes the volume slot. Safe: `filledFraction`
  divides by `volume + premium = 1`; the NaN case its comment warns about
  requires *both* fields to be zero.
- **`[voice.premium]` deleted** — `voice.ts:180-184` selects ElevenLabs only
  when the table is present. Absent, it warns and falls through to
  `synthKokoro` → `synthEdge` (`voice.ts:225-240`), the identical chain volume
  tier uses. The schema wraps the whole sub-object in `.optional()`
  (`channel.ts:97-103`). `[voice]` and `voice.volume` remain required.
- **`[scout]` added** — without it, `scout.ts:234-236` skips the channel
  entirely (`sourceCount === 0` → `continue`), which is why `topics` is empty
  today. `auto_premium = true` is mandatory: with the default `false`,
  `topics.ts:246-248` restricts the premium tier to `approved` topics only, so
  an unattended premium-only channel would never produce anything.
  Format is load-bearing — subreddits are **bare names** (`reddit.ts:81`
  interpolates raw after `r/`, so `"r/space"` requests `/r/r/space/.rss`), RSS
  entries must be **full URLs** (`rss.ts:5` runs `new URL(...)` at
  construction). Reddit works keyless via public `.rss` feeds.
- **`premium_per_video_usd = 8.0`** — the honest worst case (8 scenes × 10s,
  one keyframe retry) is ~$7.4-7.5, above the current $7.0 cap, which would
  block legitimately long videos mid-render. The $10 channel-day cap remains
  the real ceiling.

### 2. `.env`

```
LOG_LEVEL=info
BRAINROT_GLOBAL_DAILY_USD=12
```

`LOG_LEVEL` is currently unset, and `runner.ts:65` defaults pino to `silent` —
so every in-job warning (the voice downgrade, kokoro→edge fallback, rejected
keyframes, lease-heartbeat failures) is invisible. Under launchd that would
leave the one JSON line per tick as the only signal. This is the single
highest-value line in the whole change.

The global cap drops from $25 to $12: a hard operator-level stop at roughly one
bad day, still comfortably above channel-day ($10) plus scout (≤$0.06/day).

### 3. `docker-compose.yml`

Add `restart: unless-stopped` to the `whisperx` service. There is no `restart`
key anywhere in the repo today, so Docker's default of `no` applies and the
sidecar does not return after a reboot or a Docker Desktop restart. Combined
with free voice making WhisperX mandatory, a reboot would otherwise fail every
job at the captions stage. Also enable Docker Desktop's start-at-login, and
re-run `docker compose up -d whisperx` once so the policy takes effect.

### 4. launchd agents

Four agents in `~/Library/LaunchAgents/`, plus `mkdir -p logs` in the repo.

| Label | Trigger | Command |
|---|---|---|
| `com.brainrot.scout` | Calendar 07:05, 12:05, 17:05 | `pnpm brainrot scout` |
| `com.brainrot.produce-next` | Interval 1500s (25 min) | `pnpm brainrot produce-next` |
| `com.brainrot.publish-next` | Interval 900s (15 min) | `pnpm brainrot publish-next` |
| `com.brainrot.digest` | Calendar 08:00 | `pnpm brainrot digest` |

Every plist needs, per `README.md:217-222`:

- `WorkingDirectory` = `/Users/alex/code/project-brainrot`, so dotenv,
  `channels/`, `data/brainrot.db`, `runs/` and `logs/` resolve.
- An absolute `pnpm` path in `ProgramArguments` (from `which pnpm`), plus
  `PATH` in `EnvironmentVariables` covering homebrew and ffmpeg — launchd does
  not inherit a login shell.
- `StandardOutPath` / `StandardErrorPath` into `logs/<name>.log`.

`StartInterval` is used for the two loops rather than a calendar list because
launchd coalesces missed firings into a single run at wake, which is the
correct behavior for an idempotent one-unit-of-work tick.

**All three publish slots are retained** even though only one video exists per
day. The later two noop with `no-ready-video` at zero cost, and because
`slots.ts:28-32` keeps a missed slot due for the remainder of the local day,
three slots are free insurance against a lid closed at 10:00.

### 5. Timezone semantics (documentation, not a change)

The system is deliberately split and `README.md:224` describes it wrongly:

- **UTC** — budget caps (`costs.ts:46-57`) and the `tier_mix` quota
  (`plan-tick.ts:76-82`, via `strftime('%Y-%m-%d','now')`). Rolls over at
  8pm EDT / 7pm EST.
- **Local** — publish slots (`slots.ts:6-20`, explicitly commented "never
  toISOString()") and the YouTube per-day upload counter
  (`publish-next.ts:132` uses `localDay`).

Practical consequence for this configuration: the day's premium job is created
shortly after 8pm EDT when the UTC quota resets, renders that evening, and
publishes the following morning at the 10:00 local slot.

## Validation sequence

Ordered; each step gates the next.

1. `pnpm build && pnpm test` — confirms the TOML edits type-check and load.
2. `docker compose up -d whisperx`; confirm the container reports a restart
   policy and responds on `http://localhost:8585`.
3. `pnpm brainrot scout` once by hand (~$0.02). Confirm `sourceErrors` is empty
   and `pnpm brainrot topics list` shows candidates. **The feed URLs above are
   unverified** — no network check was performed while designing this, so this
   step is where they are proven.
4. **One manual premium produce, end-to-end** (~$3-5):
   `pnpm brainrot produce --channel channels/test.toml --topic "<a scouted topic>" --tier premium`
   This is the critical step: no premium job has ever completed in this
   environment. A prior run on 2026-07-20 had the keyframe judge reject 21/21
   images (`visuals-premium.ts:82-86`), so real fal spend has happened but no
   video has ever finished. Run this with no loops installed — manual commands
   take no lease and would race a live tick.
5. Inspect the resulting `qc.json`. If the library row is `needs-review`,
   understand which check failed before automating — `frozen-frames`
   (`qc.ts:298-306`, ≥2000ms freeze) is the expected hazard for near-static AI
   clips.
6. Publish that one video by hand and confirm it appears private on the channel.
7. Install and load the four launchd agents.
8. Watch `logs/*.log` and `pnpm brainrot digest` daily for three days.

## Operating procedure

Daily: read the digest. The pipeline is silent on failure, so this is the only
routine that catches a stall.

Recovery commands, all of which require stopping the relevant agent first
(`launchctl bootout gui/$UID/com.brainrot.<name>`) because manual commands run
outside the loop leases:

| Symptom | Action |
|---|---|
| Job `failed` | `pnpm brainrot resume <jobId>` |
| Topic stuck `claimed` behind a dead job | `pnpm brainrot topics requeue <id>` |
| Library row `needs-review` | Inspect, then `pnpm brainrot library approve <jobId>` |
| Publish row `interrupted` | `pnpm brainrot publish retry <jobId>` |

## Accepted risks

Explicitly chosen, not overlooked:

- **A `failed` job is terminal.** `plan-tick.ts:44-46` resumes only `blocked`
  jobs. Any stage failure kills the job, strands its topic as `claimed`, and
  burns the day's quota slot (`plan-tick.ts:73-82` counts rows regardless of
  outcome). Production stops silently until the digest is read.
- **QC failure stalls the day.** Expected to bite early given step 4 has never
  succeeded here.
- **`runs/` grows without bound.** Nothing prunes it; ~hundreds of MB/day at
  this cadence. Monitor disk. If a cleanup is ever added, never delete
  `assemble/final.mp4` for a library row still `ready`.
- **The ledger can understate spend.** `fal.ts:103` and `:139` throw bare
  errors after a billed `subscribe`, so a malformed fal response leaves that
  spend unrecorded (one image ~$0.05, one clip ~$0.42-0.84). Rare, and it
  matters only because the ledger is what the budget caps read.
- **Provider key validity is unproven** until the first real call. `FAL_KEY` is
  present but untested; the OAuth refresh token is untested since 2026-07-24.
- **`FAL_PRICE_TABLE` was last verified 2026-07-19.** If fal changed prices,
  every budget gate drifts from reality silently.

## Follow-ups (not in this change)

- `README.md:224` states the quota/cap day is UTC without noting that publish
  slots and the upload counter are local. Worth correcting.
- Consider a WhisperX preflight check in `produce-next` so a down sidecar
  noops the tick instead of burning script+voice spend and the day's quota.
- Consider making transient stage failures resumable rather than terminal.
