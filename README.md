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

Drop vertical-friendly clips into the channel's background folder (default
`assets/bg/`) and royalty-free music into `assets/bgm/`. The volume tier picks
a clip at random, avoiding the 5 most recently used per channel.

```bash
cp ~/footage/*.mp4 assets/bg/
cp ~/music/*.mp3  assets/bgm/
```

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

## Automation (cron)

The production loop is three cron-invoked commands: `scout` fills the topic
queue, `produce-next` performs one unit of work per tick (resume one blocked
job or produce one video), and `digest` prints a daily report. Paste into
`crontab -e`, adjusting the paths:

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

# Daily digest at 08:00 — stdout goes to MAILTO; nothing else delivers it.
0 8 * * * cd /Users/alex/code/project-brainrot && pnpm brainrot digest
```

- **`cd` into the repo, absolute paths only.** Every entry `cd`s to the repo
  root first so `.env` (dotenv), `channels/`, `data/brainrot.db`, `runs/`,
  and `logs/` all resolve. Replace `/Users/alex/code/project-brainrot` with
  your absolute repo path and run `mkdir -p logs` in the repo once before
  the first firing. If you would rather not set `PATH`, use the absolute
  binary path from `which pnpm` in each entry instead.
- **The quota/cap day is UTC.** Daily tier quotas and the spend caps share
  the cost ledger's UTC day boundary, so "today" flips at midnight UTC —
  7 pm EST / 8 pm EDT, i.e. late afternoon/early evening US-Eastern — not at
  local midnight. Expect fresh quota slots and budget headroom in the early
  evening.
- **Premium stays gated.** `produce-next` only claims premium topics you
  have approved (`pnpm brainrot topics approve <id>`) unless the channel
  TOML sets `auto_premium = true` under `[scout]`; volume flows unattended.
  A `{"action":"noop","reason":"lease-held"}` tick is normal while a long
  render from the previous firing is still running.
- **Manual runs take no lease.** `produce` and `resume` run outside the
  produce-next lease, so a hand-run invocation can execute concurrently with a
  live tick and both may act on the same job/topic. Stop the produce-next cron
  line (or wait for `lease-held` ticks to clear) before running `produce` or
  `resume` by hand.

## Tests

```bash
pnpm test                   # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract          # real paid calls, ~$0.20 total (FLUX image $0.05, MiniMax clip ~$0.10, ElevenLabs synth ~$0.01, one LLM call)
pnpm test:contract:premium  # additionally renders one real Kling clip (~ $0.40 total)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
