# Development and release audit — 2026-09-28

## Result

Keep one maintained channel directory: `docker/state/channels/`. Develop against
short-lived fixtures and run production through Compose. The pipeline already
has useful module boundaries; replacing those with a second operational
installation adds state and provider spend without adding repeatable coverage.

The retired `local/` tree and its backup have been deleted as requested.
Production database volumes, run artifacts, channel values, and provider
credentials were preserved. No deployment was performed.

## Changes made

- Removed the implicit `local` runtime root. CLI/dashboard operations require
  `--root` or `BRAINROT_ROOT`; Compose supplies `/app/state`, tests supply temp
  roots. No host database is created just because an operator omitted a flag.
- Removed the local-channel smoke check, `--dev`, the development voice
  environment switch, and `[voice] dev`. Voice behavior comes from the channel;
  module tests mock the providers and test both the premium and fallback paths.
- Removed retired host-root and development overrides from this
  checkout's `.env`. Compose explicitly maps supported production variables;
  it no longer forwards the entire host environment file. Daemon and dashboard
  read the same daily-budget setting, preserving this checkout's $12 cap.
- Added `pnpm test:config`, `pnpm test:scout`, and `pnpm test:pipeline` as focused
  selections of existing suites. Added regression coverage for required roots,
  and retired voice settings.
- Added `pnpm check`: formatting, lint, both TypeScript projects, and the full
  default test suite. Normalized existing source-format drift and excluded
  ignored agent reports from formatting so the gate is usable.
- Replaced channel-copy promotion instructions with test, build, and restart
  instructions. A release builds both `brainrot` and `whisperx`; the dashboard
  shares the Node image.

## Existing tests worth keeping

| Concern               | Existing coverage                                                                 | Why it replaces an operational dev channel                                                             |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Channel configuration | `src/config/channel.test.ts`, `channels.smoke.test.ts`                            | Validates fixtures and every maintained TOML without starting workers.                                 |
| Scouting              | `src/scout/test/`, `src/scout/sources/test/`                                      | Exercises source parsing, filtering, scoring, budgets, and deduplication with controlled inputs.       |
| Daemon decisions      | `src/loop/test/`, `src/jobs/test/golden-path-loop.test.ts`                        | Exercises leases, demand limits, claims, resumptions, and action workers against disposable databases. |
| Finished video        | `src/jobs/test/golden-path.test.ts`, `src/stages/test/`, `integrations/remotion/` | Uses mocked paid providers and real media tools to validate actual artifacts.                          |
| Operator interface    | `dashboard/lib/**/test/`, `src/cli.test.ts`                                       | Exercises rendering, commands, actions, CSRF, and filesystem containment without production state.     |
| External boundaries   | `*.contract.test.ts`, `integrations/whisperx/test_app.py`                         | Keeps paid calls and infrastructure requirements explicit and independently runnable.                  |

## Recommended next changes, in order

### 1. Make restarts safe for in-flight jobs

`src/loop/daemon.ts` aborts polling and waits for workers, but does not pass
cancellation through a running pipeline. `docker-compose.yml` has no
`stop_grace_period`, so a long render can outlast Docker's default stop window.
`src/loop/plan-tick.ts` resumes blocked jobs, not orphaned running jobs; the
operator must recover those manually.

Start with an explicit drain procedure and a measured stop grace period. Then
add narrowly scoped recovery for jobs whose producing process is demonstrably
gone, respecting leases. Test interruption around stage completion and the
final database transaction. A longer timeout alone does not guarantee recovery.
This has more operational value than adding another staging daemon.

### 2. Put the same checks in CI, including a reproducible sidecar tier

There is no `.github/workflows/` pipeline. `pnpm check` now provides the Node
entrypoint for one, but a local pass alone does not protect subsequent changes.
Use a clean install, the same check command, and a separate sidecar job. Keep
paid provider contracts manually triggered.

The eight Python endpoint tests run successfully in this checkout's existing
virtual environment, but `integrations/whisperx/requirements.txt` describes runtime
dependencies and does not declare pytest or the HTTP test client. The local
interpreter is Python 3.14 while the image uses 3.11. Add explicit test
dependencies and run the sidecar tests with the image's Python version before
calling that tier reproducible. `pnpm check` currently covers Node/TypeScript,
not Python or a Docker image build.

### 3. Pin build inputs and promote the image that passed validation

`package.json` has no `packageManager` pin while the Dockerfile selects
`pnpm@11.12.0`; host and image installs can use different package managers.
The Node/Python base tags can also move. Pin the package
manager and choose an explicit update policy for image tags/digests. Build
once per release and record an immutable image tag so rollback does not mean
reconstructing a previous environment from today's base images.

Production TOMLs are bind-mounted and reload every tick. Editing them is already
a live change, before any image deployment. The README now says to stop the
daemon before unvalidated edits. If uninterrupted config releases become useful,
validate in a clean checkout and apply the final files atomically; do not
reintroduce a permanent dev channels directory.

### 4. Shorten agent instructions and operational comments

`CLAUDE.md` is over 1,000 lines and mixes current invariants with migration
history, performance measurements, and explanations of deleted subsystems.
The channel TOML and Compose file also contain substantial historical prose.
This increases the chance that a future change follows obsolete instructions.

Keep commands, current architecture, and safety invariants in the agent guide;
move history to a few focused documents. Retain the reasons for SQLite named
volumes, dashboard credential isolation, CSRF/Host checks, and lease ownership.
Those constraints solve concrete failures and should not be simplified away.
This change updates stale development instructions but does not rewrite the
whole architecture guide.

### 5. Remove unused operator settings after confirming ownership

The host `.env` still contains YouTube/Instagram OAuth and token-encryption
settings from the deleted publishing system (`YT_CLIENT_*`, `IG_APP_*`, and
`BRAINROT_TOKEN_KEY`). The current application has no upload adapter or token
store. Compose now excludes those settings, but the unused secrets remain on
disk. Confirm they are not shared with another application, then remove them
and retire the corresponding external credentials. They were left intact here
because removing the local development environment does not establish ownership
of those external applications.

Keep the existing dependency-injection seams and fixture builders. Most of the
replacement coverage already existed; a second test framework, long-running
development daemon, or bespoke release orchestrator would recreate the
complexity being removed.

## Verification

- `pnpm check`: passed, including 1,180 tests across 86 files.
- `pnpm test:config`: 53 tests passed; `pnpm test:scout`: 180 tests passed.
- `integrations/whisperx/.venv/bin/python -m pytest integrations/whisperx/test_app.py -q`:
  eight tests passed in the existing local virtual environment.
- `docker compose config --quiet` and `git diff --check`: passed.
- Read-only review found a missing WhisperX image build in the proposed release
  command; it was corrected. No runtime regression was identified in review.

## Validation limits

Production was not restarted. Docker is not running on this machine, so this
change can validate Compose configuration but cannot build/run the images.
Paid provider contracts were not invoked.
The default suite needs permission to bind localhost ports and launch Chrome;
its first sandboxed run failed on those restrictions and was rerun outside
the sandbox. Python tests emitted dependency deprecation warnings.
