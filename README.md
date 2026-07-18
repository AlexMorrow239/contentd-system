# Brainrot Machine

Automated short-form video pipeline. `brainrot produce` turns a topic into a
finished, QC-checked, word-captioned 9:16 MP4 in the library.

## Prerequisites

- Node >= 22 and [pnpm](https://pnpm.io)
- [ffmpeg](https://ffmpeg.org) + ffprobe on `PATH` (`brew install ffmpeg`)
- Docker (for the WhisperX caption-alignment sidecar)

## Setup

```bash
pnpm install
cp .env.example .env          # fill in provider keys (ANTHROPIC_API_KEY, ...)
docker compose up -d whisperx # caption alignment sidecar
```

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
# options: --tier volume  --db data/brainrot.db  --runs-root runs
```

Prints the `JobResult` as one JSON line; exit code `0` on `ready`/`needs-review`,
`1` on `failed` or `blocked` (a `blocked` status means a budget cap was hit).

## Where outputs land

- Per-job artifacts: `runs/<jobId>/<stage>/` (`script.json`, `narration.wav`,
  `words.json`, `background.mp4`, `final.mp4`, `qc.json`)
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
pnpm test             # unit + integration (mocked providers; real ffmpeg/Remotion)
pnpm test:contract    # one real paid call per provider (manual, excluded by default)
```

Media/render tests shell out to ffmpeg and run a real Remotion render; the first
render downloads a headless Chrome shell.
