# Dev Voice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a channel, a single job, or a standalone script force the voice stage onto the cheap kokoro/edge-tts chain, skipping ElevenLabs entirely even when `[voice.premium]` is configured.

**Architecture:** One boolean computed inside `voiceStage` — `ctx.channel.voice.dev === true || process.env.BRAINROT_DEV_VOICE === '1'` — that, when true, makes the stage treat `channel.voice.premium` as absent. Three ways to set the inputs to that boolean: a new optional `[voice] dev` TOML field (channel level), a `--dev` CLI flag on `produce`/`resume` that sets the env var for that process (job level), and the env var itself, settable directly for any code that constructs a `JobContext` (component level).

**Tech Stack:** TypeScript, zod (config schema), commander (CLI), vitest.

## Global Constraints

- Naming is **dev**, not **test** — avoids collision with `channels/test.toml`, every `*.test.ts` file, and the `CONTRACT=1` real-API suite.
- Dev mode is voice-tier only — no effect on `channel.scriptModel` or any other paid call.
- No new `jobs` table column and no persistence of "this job ran in dev mode" anywhere. The legacy `tier` column in `jobs` (see `src/jobs/runner.ts`, `createJob`) stays untouched and unrepurposed.
- Env var name: `BRAINROT_DEV_VOICE` (value `'1'` to activate — matches how `CONTRACT=1` is checked elsewhere in this repo).
- `resume` gets the same `--dev` flag as `produce`, for the reason documented in the spec's Resume caveat: dev-ness set only via `--dev` on the original `produce` call is not persisted, so resuming a dev job needs `--dev` passed again unless the channel TOML itself sets `[voice] dev = true`.

Full design: [docs/superpowers/specs/2026-07-25-dev-voice-mode-design.md](../specs/2026-07-25-dev-voice-mode-design.md)

---

### Task 1: `[voice] dev` channel config field

**Files:**
- Modify: `src/config/channel.ts:16-41` (interface), `:63-77` (zod schema), `:126-142` (loadChannelConfig mapping)
- Test: `src/config/channel.test.ts`

**Interfaces:**
- Produces: `ChannelConfig.voice.dev?: boolean` — always a concrete `boolean` (`false` when the TOML omits the key) once produced by `loadChannelConfig`; optional in the type only because hand-built fixtures (e.g. `testChannel()` overrides) may omit it.

- [ ] **Step 1: Write the failing tests**

Add to `src/config/channel.test.ts`, inside (or right after) the existing `describe('loadChannelConfig', ...)` block:

```ts
  it('defaults [voice] dev to false when absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.voice.dev).toBe(false)
  })

  it('parses [voice] dev = true', () => {
    const lines = PLAN1_LINES.flatMap((l) =>
      l === 'volume = "af_heart"' ? [l, 'dev = true'] : [l],
    )
    const cfg = loadChannelConfig(writeToml(lines))
    expect(cfg.voice.dev).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/config/channel.test.ts -t "voice] dev"`
Expected: FAIL — `cfg.voice.dev` is `undefined`, not `false`/`true` (the field doesn't exist yet).

- [ ] **Step 3: Add the field to the `ChannelConfig` interface**

In `src/config/channel.ts`, change:

```ts
  voice: { volume: string; premium?: PremiumVoiceConfig }
```

to:

```ts
  voice: { volume: string; premium?: PremiumVoiceConfig; dev?: boolean }
```

- [ ] **Step 4: Add the field to the zod schema**

In `src/config/channel.ts`, inside `rawSchema`'s `voice: z.object({...})`, change:

```ts
  voice: z.object({
    volume: z.string(),
    premium: z
      .object({
        provider: z.literal('elevenlabs'),
        voice_id: z.string(),
        model: z.string().default(DEFAULT_ELEVENLABS_MODEL_ID),
      })
      .optional(),
  }),
```

to:

```ts
  voice: z.object({
    volume: z.string(),
    premium: z
      .object({
        provider: z.literal('elevenlabs'),
        voice_id: z.string(),
        model: z.string().default(DEFAULT_ELEVENLABS_MODEL_ID),
      })
      .optional(),
    dev: z.boolean().default(false),
  }),
```

- [ ] **Step 5: Map the field in `loadChannelConfig`**

In `src/config/channel.ts`'s `loadChannelConfig`, change:

```ts
    voice: {
      volume: raw.voice.volume,
      premium: raw.voice.premium
        ? {
            provider: raw.voice.premium.provider,
            voiceId: raw.voice.premium.voice_id,
            modelId: raw.voice.premium.model,
          }
        : undefined,
    },
```

to:

```ts
    voice: {
      volume: raw.voice.volume,
      dev: raw.voice.dev,
      premium: raw.voice.premium
        ? {
            provider: raw.voice.premium.provider,
            voiceId: raw.voice.premium.voice_id,
            modelId: raw.voice.premium.model,
          }
        : undefined,
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/config/channel.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 7: Type-check**

Run: `pnpm build`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/config/channel.ts src/config/channel.test.ts
git commit -m "feat: add [voice] dev channel config field"
```

---

### Task 2: `voiceStage` dev-mode gate

**Files:**
- Modify: `src/stages/voice.ts:220-224` (inside `voiceStage.run`)
- Test: `src/stages/voice.test.ts`

**Interfaces:**
- Consumes: `ChannelConfig.voice.dev?: boolean` (Task 1). `process.env.BRAINROT_DEV_VOICE`.
- Produces: no new exports — this is a behavior change inside the existing `voiceStage.run`. Later tasks (CLI) rely on `process.env.BRAINROT_DEV_VOICE === '1'` being the exact activation condition.

- [ ] **Step 1: Write the failing tests**

Add to `src/stages/voice.test.ts`. First, add `afterEach` to the vitest import at the top of the file:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```

Then add this new describe block, right after the existing `describe('voiceStage with [voice.premium] configured (elevenlabs)', ...)` block (i.e. at the end of the file, before the final closing of the file):

```ts
describe('voiceStage dev mode', () => {
  afterEach(() => {
    delete process.env.BRAINROT_DEV_VOICE;
  });

  it('channel.voice.dev=true skips elevenlabs and its budget check even when premium is configured', async () => {
    const channel = premiumChannel();
    channel.voice = { ...channel.voice, dev: true };
    // Cap set below the mocked 40_000 elevenlabs estimate: if dev mode did not
    // skip the premium branch entirely, this would throw BudgetExceededError
    // instead of falling through to kokoro.
    channel.budget = { ...channel.budget, perVideoUsdMicros: 10_000 };
    const ctx = await premiumCtx(SCRIPT, channel);
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(vi.mocked(estimateTtsCostMicros)).not.toHaveBeenCalled();
    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled();
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.provider).toBe('kokoro');
  });

  it('BRAINROT_DEV_VOICE=1 skips elevenlabs even when the channel has no dev flag set', async () => {
    process.env.BRAINROT_DEV_VOICE = '1';
    const ctx = await premiumCtx();
    const generate = vi.fn(async (t: string) => chunkAudio(t));
    vi.mocked(KokoroTTS.from_pretrained).mockResolvedValue({ generate } as never);

    await voiceStage.run(ctx);

    expect(vi.mocked(synthWithTimestamps)).not.toHaveBeenCalled();
    const meta = JSON.parse(await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'));
    expect(meta.provider).toBe('kokoro');
  });

  it('leaves premium behavior untouched when BRAINROT_DEV_VOICE is unset or not "1"', async () => {
    process.env.BRAINROT_DEV_VOICE = '0';
    const ctx = await premiumCtx();
    vi.mocked(synthWithTimestamps).mockResolvedValue(elevenSynthResult());

    await voiceStage.run(ctx);

    expect(vi.mocked(synthWithTimestamps)).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/stages/voice.test.ts -t "dev mode"`
Expected: FAIL — `channel.voice.dev` / the env var have no effect yet, so `synthWithTimestamps`/`estimateTtsCostMicros` ARE called (or, in the first test, `BudgetExceededError` is thrown instead of the stage completing).

- [ ] **Step 3: Add the dev-mode gate**

In `src/stages/voice.ts`, inside `voiceStage.run`, change:

```ts
    const premiumVoice = ctx.channel.voice.premium;
    if (premiumVoice) {
```

to:

```ts
    // Dev mode (channel-level `[voice] dev = true` or BRAINROT_DEV_VOICE=1)
    // forces the volume chain regardless of [voice.premium] — see
    // docs/superpowers/specs/2026-07-25-dev-voice-mode-design.md.
    const devMode = ctx.channel.voice.dev === true || process.env.BRAINROT_DEV_VOICE === '1';
    const premiumVoice = devMode ? undefined : ctx.channel.voice.premium;
    if (premiumVoice) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/stages/voice.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Type-check**

Run: `pnpm build`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/stages/voice.ts src/stages/voice.test.ts
git commit -m "feat: add dev-mode gate to voiceStage"
```

---

### Task 3: `--dev` CLI flag on `produce` and `resume`

**Files:**
- Modify: `src/cli.ts` (add `applyDevFlag` helper near `resolveDbPath`; add `--dev` option + call it in the `produce` and `resume` actions)
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: `process.env.BRAINROT_DEV_VOICE` contract from Task 2 (`'1'` activates).
- Produces: `export function applyDevFlag(dev?: boolean): void` — exported the same way `parsePublishDays`/`parseTopicIds` are, so `cli.test.ts` can assert the wiring in-process without spawning a subprocess.

- [ ] **Step 1: Write the failing tests**

Add near the bottom of `src/cli.test.ts`, alongside the other in-process describe blocks (after `describe('parsePublishDays (in-process)', ...)`), first adding `applyDevFlag` to the existing import from `./cli.js`:

```ts
import { applyDevFlag, parsePublishDays, parseTopicIds, pipelineStages } from './cli.js'
```

```ts
describe('applyDevFlag (in-process)', () => {
  const ORIGINAL = process.env.BRAINROT_DEV_VOICE

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BRAINROT_DEV_VOICE
    else process.env.BRAINROT_DEV_VOICE = ORIGINAL
  })

  it('sets BRAINROT_DEV_VOICE=1 when dev is true', () => {
    applyDevFlag(true)
    expect(process.env.BRAINROT_DEV_VOICE).toBe('1')
  })

  it('leaves BRAINROT_DEV_VOICE untouched when dev is falsy', () => {
    delete process.env.BRAINROT_DEV_VOICE
    applyDevFlag(undefined)
    expect(process.env.BRAINROT_DEV_VOICE).toBeUndefined()
    applyDevFlag(false)
    expect(process.env.BRAINROT_DEV_VOICE).toBeUndefined()
  })
})
```

Also add `afterEach` to the top-level vitest import in `src/cli.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it } from 'vitest'
```

And add two `--help` subprocess tests, right after the existing `` it('`produce --help` prints usage with --channel/--topic', ...) `` test:

```ts
  it('`produce --help` lists --dev', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'produce', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--dev')
  }, 60000)

  it('`resume --help` lists --dev', async () => {
    const result = await execa('pnpm', ['exec', 'tsx', 'src/cli.ts', 'resume', '--help'], {
      reject: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--dev')
  }, 60000)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/cli.test.ts -t "applyDevFlag|--dev"`
Expected: FAIL — `applyDevFlag` is not exported from `./cli.js` yet (import error), and `--dev` does not appear in either `--help` output.

- [ ] **Step 3: Add `applyDevFlag` and wire it into `produce`/`resume`**

In `src/cli.ts`, add the helper right after `resolveDbPath`:

```ts
function resolveDbPath(flagDb?: string): string {
  return flagDb ?? process.env.BRAINROT_DB ?? 'data/brainrot.db'
}

/**
 * Sets BRAINROT_DEV_VOICE for the current process when --dev is passed, so
 * voiceStage treats [voice.premium] as absent. Exported so cli.test.ts can
 * assert the wiring in-process instead of spawning a subprocess.
 */
export function applyDevFlag(dev?: boolean): void {
  if (dev) process.env.BRAINROT_DEV_VOICE = '1'
}
```

Then change the `produce` command:

```ts
program
  .command('produce')
  .requiredOption('--channel <path>', 'path to channel TOML')
  .requiredOption('--topic <text>', 'topic text')
  .option('--db <path>', 'sqlite db path')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .option(
    '--dev',
    'force the cheap voice chain (kokoro/edge-tts), skipping ElevenLabs even if [voice.premium] is configured',
  )
  .action(async (opts: { channel: string; topic: string; db?: string; runsRoot: string; dev?: boolean }) => {
    applyDevFlag(opts.dev)
    const channel = loadChannelConfig(opts.channel)
    const db = openDb(resolveDbPath(opts.db))
    const jobId = createJob(db, channel, { topic: opts.topic })
    const result = await runJob(db, channel, jobId, pipelineStages(), { runsRoot: opts.runsRoot })
    // better-sqlite3 is synchronous, so close the handle now; nothing else keeps the
    // event loop alive, letting the process drain stdout and exit on its own.
    db.close()
    process.stdout.write(JSON.stringify(result) + '\n')
    // Set exitCode (not process.exit) so a piped stdout flushes fully before exit —
    // process.exit can truncate the JSON line mid-write. exit 0 for ready/needs-review;
    // exit 1 for failed AND blocked (the JSON line carries the finer distinction).
    process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
  })
```

And the `resume` command:

```ts
program
  .command('resume')
  .argument('<jobId>', 'job id to resume (failed or blocked; running needs --force)')
  .option('--db <path>', 'sqlite db path')
  .option('--runs-root <path>', 'runs root directory', 'runs')
  .option('--channels-dir <dir>', 'channel TOML directory', 'channels')
  .option('--force', 'resume a job stuck in running (asserts no live process holds it)')
  .option(
    '--dev',
    'force the cheap voice chain (kokoro/edge-tts), skipping ElevenLabs even if [voice.premium] is configured',
  )
  .action(
    async (
      jobId: string,
      opts: { db?: string; runsRoot: string; channelsDir: string; force?: boolean; dev?: boolean },
    ) => {
      applyDevFlag(opts.dev)
      const db = openDb(resolveDbPath(opts.db))
      try {
        const result = await resumeJob(db, jobId, {
          runsRoot: opts.runsRoot,
          channelsDir: opts.channelsDir,
          force: opts.force,
        })
        process.stdout.write(JSON.stringify(result) + '\n')
        // Mirror produce: 0 for ready/needs-review, 1 for failed AND blocked.
        // A ResumeError skips the write and reaches the parseAsync catch (exit 1).
        process.exitCode = result.status === 'failed' || result.status === 'blocked' ? 1 : 0
      } finally {
        db.close()
      }
    },
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/cli.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Type-check**

Run: `pnpm build`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: add --dev flag to produce and resume"
```

---

### Task 4: Docs

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

No tests — documentation only.

- [ ] **Step 1: Document the env var in `.env.example`**

In `.env.example`, change:

```
# ElevenLabs API key — premium voice; unset or failing falls back to kokoro/edge-tts
ELEVENLABS_API_KEY=
```

to:

```
# ElevenLabs API key — premium voice; unset or failing falls back to kokoro/edge-tts
ELEVENLABS_API_KEY=
# Set to 1 to force the cheap voice chain (kokoro/edge-tts) for local runs,
# skipping ElevenLabs even when a channel's [voice.premium] is configured.
# `produce --dev` / `resume --dev` set this for you; a channel's own
# [voice] dev = true does the same without touching the environment.
BRAINROT_DEV_VOICE=
```

- [ ] **Step 2: Document `--dev` and `[voice] dev` in `README.md`**

In `README.md`, change:

```
A channel that sets `[voice.premium]` (ElevenLabs voiceId/modelId) gets that
narration provider automatically, with word-level timings (no WhisperX
dependency on the happy path) — no separate flag or tier needed. It falls back
to kokoro/edge-tts on failure or when unconfigured. This requires
`ELEVENLABS_API_KEY` in `.env`.
```

to:

```
A channel that sets `[voice.premium]` (ElevenLabs voiceId/modelId) gets that
narration provider automatically, with word-level timings (no WhisperX
dependency on the happy path) — no separate flag or tier needed. It falls back
to kokoro/edge-tts on failure or when unconfigured. This requires
`ELEVENLABS_API_KEY` in `.env`.

To skip ElevenLabs on purpose — for a local test run of a channel that has
`[voice.premium]` configured — pass `--dev` to `produce` or `resume`, set
`BRAINROT_DEV_VOICE=1` in the environment, or add `dev = true` to the
channel's `[voice]` table to force it for every job on that channel.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document dev voice mode"
```

---

## Final check

- [ ] Run the full suite once all four tasks are committed: `pnpm test` — expect all tests PASS.
- [ ] Run `pnpm build` once more — expect no errors.
