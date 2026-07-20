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

## Tests

```bash
pnpm test                   # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract          # real paid calls, ~$0.20 total (FLUX image $0.05, MiniMax clip ~$0.10, ElevenLabs synth ~$0.01, one LLM call)
pnpm test:contract:premium  # additionally renders one real Kling clip (~ $0.40 total)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
