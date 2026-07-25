# Containerizing the pipeline — design

Date: 2026-07-25
Status: approved design, pending implementation plan

## Goal

Run the whole scout → produce → publish system as a background container on
this Mac, with the working directory demoted to a local development copy that
has no influence on production until an explicit act promotes it.

Two properties define "done":

1. **Autonomous.** After `docker compose up -d`, the loop scouts, produces and
   publishes with no operator action and survives a reboot unattended.
2. **No hot reload.** The running system is a snapshot of the source at image
   build time. Editing `src/` changes nothing until a rebuild.

This replaces the launchd scheduling installed on 2026-07-24 (see
`2026-07-24-live-automation-design.md`), whose one recorded production
incident — `gui/<uid>` timer throttling suppressing ~10h of ticks — is a class
of failure a container does not have.

## Decisions

| Decision | Choice | Consequence |
|---|---|---|
| Host | This Mac, Docker Desktop, linux/arm64 | Bind-mounted `assets/`, CPU render, no registry |
| Scheduling | supercronic inside one long-lived container | Immune to launchd idle throttling; no catch-up firing across sleep |
| Container count | One app container + the existing sidecar | Leases already serialize work; per-loop containers buy nothing |
| Source | `COPY`'d into the image | Rebuild is the only deploy |
| Channel config | Bind-mounted read-only, live per tick | Preserves the loop's existing fresh-read-per-tick behavior |
| Dev/prod split | Separate dirs + DB, enforced by env defaults | A bare host `pnpm brainrot` cannot reach production |
| Promotion | `cp` + re-run `auth youtube` | The auth step already validates the production channels dir |
| Operator commands | `docker compose exec`, except OAuth | Identical runtime for anything that renders |
| Logs | supercronic → stdout → Docker `json-file` | One stream, rotation for free; `logs/` and `MAILTO` retired |

## Non-goals

- No change to the pipeline, stage list, loop state machine, or approval paths.
- No multi-arch build, no registry, no remote host. Moving off this Mac is a
  separate design.
- No self-healing beyond what exists. A `failed` job is still terminal.
- No `runs/` pruning (still unbounded, still the operator's problem).
- No digest delivery mechanism. It prints to the log stream and stops there.

## Design

### 1. Services

Both live in the existing `docker-compose.yml`.

**`whisperx`** — unchanged but for readiness. `sidecar/whisperx/app.py` exposes
only `POST /align` today, so nothing can distinguish "container started" from
"can serve". Add a `GET /health` liveness route, a compose `healthcheck`
against it, and `depends_on: { whisperx: { condition: service_healthy } }` on
the app service.

This matters because the sidecar is load-bearing: with free voice
(kokoro/edge-tts) there are no word timings, so every job aligns through it. A
start-order race after reboot would otherwise spend script + voice money and
consume the day's `tier_mix` quota slot before hard-failing at captions.

`get_align_model()` (`app.py:58`) is lazy, so `/health` proves liveness, not
model readiness — a first-request stall after boot remains possible. Accepted;
warming the model in the healthcheck would trade a known small stall for a
slow, opaque startup.

The published `8585` port stays, so host-side development still reaches it.

**`brainrot`** — new. `node:22-bookworm-slim`, running as the non-root `node`
user so headless Chrome keeps its sandbox rather than needing `--no-sandbox`.

Image contents, each for a verified reason:

- **`ffmpeg` + `ffprobe`** (apt). `src/media/ffmpeg.ts:23,47,58` and
  `src/stages/qc.ts:93,132,144` invoke them by bare name through execa.
- **Chrome headless shell**, installed at build via `remotion browser ensure`
  plus Remotion's Debian library set. Remotion caches it under `node_modules/`,
  so it becomes an image layer rather than a first-run download.
- **Inter, vendored as a TTF** in `deploy/docker/fonts/`, installed to
  `/usr/share/fonts/truetype/` and `fc-cache`'d. `remotion/Root.tsx:12`
  defaults `font: 'Inter'` and `remotion/Captions.tsx:54` passes it to Chrome as
  a CSS `fontFamily`. **A missing font is a silent fallback to generic sans, not
  an error** — QC checks frames and duration, not typeface, so every video would
  render with the wrong font and nothing would report it. Vendoring the file
  (OFL-licensed) rather than trusting a distro package keeps this deterministic.
- **The kokoro model, warmed at build.** `src/stages/voice.ts:165` calls
  `KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' })`, which caches
  under `node_modules/`. Running one synth during the build bakes the weights in,
  so a fresh container is not one network fetch away from failing its first job.
- **`node_modules` installed in-image** via `pnpm install --frozen-lockfile`,
  including devDependencies: `better-sqlite3` and onnxruntime are native (the
  host's darwin-arm64 builds cannot load here), and the app runs through `tsx`,
  which is a devDependency. There is no emit step to replace it — `pnpm build`
  is `tsc --noEmit`.
- **`TZ=America/Chicago`** + `tzdata`. `src/publish/slots.ts` computes due slots
  in local wall-clock time and deliberately never calls `toISOString()`; an
  unset TZ would silently shift every publish slot by five hours.
- **Source `COPY`'d in**, last, after the dependency layers.

`shm_size: 1gb`. Docker's default 64 MB `/dev/shm` is the standard cause of
headless Chrome renderer crashes.

A **`.dockerignore`** excluding `assets/`, `runs/`, `data/`, `logs/`,
`node_modules/`, `.git/` is mandatory: `assets/` alone is 21 GB and would
otherwise be streamed to the daemon on every build.

### 2. Mounts and environment

| Path | Mode | Why |
|---|---|---|
| `assets/` | ro | 21 GB of footage; never copy, never let the container write it |
| `channels/` | ro | Production config, live per tick, but the container is not what edits it |
| `data/` | rw | The SQLite file, shared with host-side OAuth |
| `runs/` | rw | Per-job artifacts, inspectable from the host |

`.env` is passed with `env_file:`, not mounted — so the container never sees
the host's dev-pointing values on disk, and compose `environment:` entries
override cleanly. Production overrides: `WHISPERX_URL=http://whisperx:8585`
(service DNS, not `localhost`), plus the production path triple below.

### 3. Development copy and promotion

The working directory becomes a development environment whose defaults cannot
reach production.

| | Production (container) | Development (host) |
|---|---|---|
| channels | `channels/` | `channels-dev/` |
| db | `data/brainrot.db` | `data/dev.db` |
| runs | `runs/` | `runs-dev/` |
| voice | real chain | `--dev` / `[voice] dev = true` |
| invoked by | `docker compose exec brainrot pnpm brainrot …` | `pnpm brainrot …` |

`channels-dev/` and `runs-dev/` are gitignored (`data/` and `runs/` already are).

**One code change makes this structural rather than a habit.** `--db` already
resolves `flag ?? process.env.BRAINROT_DB ?? default` (`src/cli.ts:76`), but
`--channels-dir` and `--runs-root` are declared with literal commander defaults
(`src/cli.ts:96,120,171,…`), which means an env fallback can never be consulted.
Drop those literals and add `BRAINROT_CHANNELS_DIR` / `BRAINROT_RUNS_ROOT`
resolvers mirroring `resolveDb`. Host `.env` then carries the dev triple and the
compose service carries the production triple, so a bare `pnpm brainrot produce`
on the host cannot write the production DB and a container tick cannot see
`channels-dev/`.

The separate dev DB is what makes dev work safe: a half-finished channel's jobs
are invisible to `produce-next`, and its spend never enters the production
ledger the budget caps read.

**Promotion is a copy plus the auth step:**

```bash
cp channels-dev/<name>.toml channels/<name>.toml   # edit as needed
BRAINROT_DB=data/brainrot.db BRAINROT_CHANNELS_DIR=channels \
  pnpm brainrot auth youtube --channel <name>
```

The auth step runs on the host for the reasons in §5 (macOS `open`, ephemeral
loopback port), which is why the production paths are named explicitly here.

No new command. `auth youtube` already calls `loadChannelsDir()` on the
production dir (`src/cli.ts:415`), which enforces the basename==name invariant
that `resumeJob` depends on (`src/config/channel.ts:187`) and rejects duplicate
declared names — so a malformed promotion fails at promotion time, and the
YouTube refresh token lands in the production DB in the same step.

Residual gap, accepted: editing a channel that is *already* promoted and authed
involves no auth step, so that edit is unvalidated until a tick prints
`config-error`. The loop degrades to a noop rather than throwing, so the cost is
lost production time, not corruption.

### 4. Scheduling

`supercronic` (pinned version, sha256-verified) is the container's entrypoint,
reading a repo-committed `deploy/docker/crontab`:

```
5 7,12,17 * * *   pnpm brainrot scout
*/25 * * * *      pnpm brainrot produce-next
*/15 * * * *      pnpm brainrot publish-next
0 8 * * *         pnpm brainrot digest
```

Same cadence as the README's cron block, minus the `PATH` / `MAILTO` / `cd`
preamble that existed only to compensate for cron's bare environment. Times are
container-local, hence the explicit `TZ`.

Supercronic's default no-overlap behavior means a 40-minute render blocks the
next `produce-next` firing rather than stacking one behind the lease — the lease
still exists and still wins, but fewer ticks are wasted printing `lease-held`.

`restart: unless-stopped` plus Docker Desktop's start-at-login covers reboot.

**`deploy/launchd/` is uninstalled and deleted.** This is correctness, not
tidiness: once host `.env` points at the dev triple, a surviving agent would keep
firing `pnpm brainrot produce-next` on the host and silently manufacture *dev*
jobs against `data/dev.db` indefinitely while appearing healthy. Git history
retains the plists.

### 5. Logs and operations

Supercronic writes each job's output to stdout tagged with its command, so
`docker compose logs -f brainrot` is the single stream and the `json-file`
driver rotates it (`max-size: 10m`, `max-file: 5`). The `logs/` directory and
`MAILTO` digest delivery are retired; `digest` becomes a daily JSON line in that
stream.

**OAuth runs on the host**, the one sanctioned exception:

```bash
BRAINROT_DB=data/brainrot.db BRAINROT_CHANNELS_DIR=channels \
  pnpm brainrot auth youtube --channel <name>
```

`src/publish/oauth-flow.ts:14` shells out to macOS `open`, which does not exist
in a Debian image, and binds an ephemeral loopback port that compose cannot
publish in advance. Because `data/` is a bind mount, the AES-GCM-encrypted
refresh token reaches the production DB regardless of which side wrote it. The
exception is safe precisely because auth writes one row and renders nothing —
none of the host-vs-container runtime drift that motivated containerizing
operator commands applies. An in-container flow would need a print-URL path, a
`--listen-port` flag, and a published port to avoid a one-line env prefix.

Everything that renders or mutates job state goes through the container:

```bash
docker compose stop brainrot
docker compose exec brainrot pnpm brainrot resume <jobId>   # etc.
docker compose start brainrot
```

The stop is still required: manual commands take no lease and can race a live
tick. That constraint is unchanged from the launchd design; only the command
spelling differs.

## Validation sequence

Ordered; each step gates the next. Steps 4 and 5 are where the real unknowns
are — no render has ever happened in a Linux container in this project.

1. `pnpm build && pnpm test` on the host, after the CLI resolver change.
2. `docker compose build brainrot` — proves the native modules, the Chrome
   fetch, and the kokoro warm-up all succeed on linux/arm64. Confirm the build
   context is megabytes, not gigabytes (`.dockerignore` working).
3. Bring up `whisperx`; confirm the healthcheck reports healthy and `/health`
   answers.
4. **First container render**, loop not yet started:
   `docker compose run --rm brainrot pnpm brainrot produce --channel channels/test.toml --topic "<scouted topic>" --dev`
   `--dev` keeps the voice chain free, so this validates the container without
   premium spend. If GL/ANGLE selection fails headless, add
   `chromiumOptions: { gl: 'swangle' }` to `renderMedia`
   (`src/stages/assemble.ts:89`).
5. **Inspect the rendered frames for typeface**, not just for success. This is
   the only check that catches a missing Inter, because nothing in QC will.
6. Verify the dev/prod boundary directly: a bare host `pnpm brainrot jobs` must
   read `data/dev.db` and must not list the job from step 4.
7. Uninstall the launchd agents (`./deploy/launchd/agents.sh uninstall`) and
   confirm no host-side ticks remain before starting the container loop.
8. `docker compose up -d`; watch `docker compose logs -f brainrot` for one full
   cycle — a scout firing, a `produce-next` tick, a `publish-next` tick.
9. Reboot the Mac and confirm both services return with no operator action.

## Accepted risks

- **Sleep loses ticks.** A frozen container's cron firings are dropped with no
  coalesced catch-up, which launchd did provide. Harmless for the 15/25-minute
  loops (a missed publish slot stays due for the rest of the local day); a
  slept-through `scout` window is simply skipped.
- **Docker Desktop is now a dependency of production.** If it fails to start at
  login, nothing runs, and there is no alarm that fires — the failure looks
  identical to an idle day.
- **Docker Desktop VM sizing is manual.** Remotion and the sidecar's torch runtime
  share one VM; ~10-12 GB is realistic and compose cannot declare it.
- **A rebuild is required for every code change**, by design. The cost is that
  an urgent production fix is a ~minutes-long rebuild, not an edit.
- **A `failed` job remains terminal** and production stops silently until the
  digest is read. Unchanged, and deliberately still unsolved.
- **`runs/` still grows unbounded**, now written by a container into a bind
  mount. Nothing prunes it.

## Follow-ups (not in this change)

- Digest delivery to something that notifies (the log stream is not a monitor).
- A WhisperX preflight in `produce-next`, so a sidecar that is up but unable to
  align noops the tick instead of burning spend and a quota slot.
- `README.md` still documents host cron and launchd as the automation story;
  it needs rewriting around compose once this lands.
