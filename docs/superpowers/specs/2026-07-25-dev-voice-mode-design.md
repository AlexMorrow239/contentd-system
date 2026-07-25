# Dev voice mode

## Problem

The voice stage currently picks between two tiers implicitly: if a channel's
TOML declares `[voice.premium]`, `voiceStage` tries ElevenLabs first and falls
back to the kokoro/edge-tts chain only on failure. There is no way to force
the cheap chain on purpose — for a single manual run, for a channel under
local end-to-end testing, or from a standalone script exercising the voice
stage directly — without editing the channel's TOML to remove `premium`.

## Goal

Add a "dev mode" that, when active, makes `voiceStage` behave exactly as if
`channel.voice.premium` were absent: no ElevenLabs call, no budget
reservation against it, straight into kokoro → edge-tts. Nothing else in the
pipeline changes.

Naming: **dev**, not **test** — "test" collides with `channels/test.toml`,
every `*.test.ts` file, and the `CONTRACT=1` real-API suite. Using it here
would make logs, flags, and greps ambiguous against that existing vocabulary.

## Design

### Single check, three triggers

`voiceStage` computes one boolean and uses it wherever it currently reads
`ctx.channel.voice.premium`:

```ts
const devMode = ctx.channel.voice.dev === true || process.env.BRAINROT_DEV_VOICE === '1'
const premiumVoice = devMode ? undefined : ctx.channel.voice.premium
```

Three independent ways to set that boolean, matching the three levels asked
for:

1. **Channel level** — new optional TOML field `[voice] dev = true`,
   parsed into `ChannelConfig.voice.dev: boolean` (zod default `false` when
   the key is absent, same pattern as `premium`). Lets an operator flip an
   entire channel — including one that already has `[voice.premium]`
   configured for production — into cheap-only mode for local end-to-end
   testing (`produce`, `produce-next`, `resume`), without touching or
   removing its premium block.

2. **Job level** — a `--dev` flag on `brainrot produce`, and the same flag
   on `brainrot resume` for consistency (see Resume caveat below). The flag
   sets `process.env.BRAINROT_DEV_VOICE = '1'` for that process before
   `runJob`/`resumeJob` is invoked. This is sugar over trigger 3 — it does
   not add a second code path in `voiceStage`.

3. **Component level** — setting `BRAINROT_DEV_VOICE=1` directly in the
   environment before invoking any code that builds a `JobContext` and calls
   `voiceStage.run()`, including outside the CLI (a standalone debug
   script). Since this is the exact env var `voiceStage` checks, no CLI
   wiring or `ChannelConfig` construction is required to exercise it.

### Resume caveat (explicit, not hidden)

Dev-ness is not persisted anywhere — not in the `jobs` table, not in any
artifact. A job produced with `--dev` (trigger 2, env-var-only for that
process) leaves no record that it was in dev mode; if it later fails and
needs `brainrot resume`, that command reloads the channel TOML fresh by
filename and starts a new process with its own environment. If `--dev` is
not passed to `resume` too, and the channel's TOML doesn't itself set
`[voice] dev = true`, the resumed run will use the channel's real
`[voice.premium]` config. This is intentional: `--dev` is a per-invocation
switch, not a job property. It's flagged here so it's a known, documented
behavior rather than a surprise.

Channel-level dev mode (trigger 1) has no such gap, since `resumeJob`
reloads the same TOML the original run used.

### Explicitly out of scope

- **No new `jobs` table column.** The existing `tier` column is dead code —
  `runner.ts` already documents it as a legacy `NOT NULL CHECK` left over
  from a removed tier concept, with every insert writing the literal
  `'volume'`. This feature does not revive or repurpose it. After-the-fact
  evidence that a job ran in dev mode is already visible in its
  `voice.json` (`provider: 'kokoro' | 'edge-tts'`).
- **No effect on `channel.scriptModel`** or any other paid call. Dev mode is
  voice-tier-only.
- **No effect on `produce-next`/`publish-next` beyond normal TOML loading.**
  These loops already re-read `channels/*.toml` every tick via
  `tryLoadChannelsDir`; a channel with `[voice] dev = true` is picked up
  the same way any other config change is — no new wiring needed there.

## Testing

- `src/stages/voice.test.ts`: dev mode (via `channel.voice.dev` and via the
  env var) skips the ElevenLabs call and its `assertBudget` reservation even
  when `channel.voice.premium` is configured; falls through to kokoro/edge-tts
  exactly as the no-premium case does today.
- `src/config/channel.test.ts`: `[voice] dev` parses to `true`; absent key
  defaults to `false`.
- `src/cli.test.ts`: `--dev` on `produce` and on `resume` sets
  `BRAINROT_DEV_VOICE=1` before the job runs.

## Docs

- `.env.example`: document `BRAINROT_DEV_VOICE` alongside the existing
  `BRAINROT_*` vars.
- `README.md` (wherever `[voice.premium]` is documented): note the sibling
  `[voice] dev` field and the `--dev` flag.
