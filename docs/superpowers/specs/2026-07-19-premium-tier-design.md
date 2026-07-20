# Brainrot Machine — Plan 2 Design: Premium Tier + Hardening

**Date:** 2026-07-19
**Status:** Draft for review
**Parent spec:** [2026-07-18-brainrot-machine-design.md](2026-07-18-brainrot-machine-design.md)
**Prior plan:** Plan 1 (walking skeleton + volume pipeline) — executed and merged to main.

## 1. Purpose

Make `pnpm brainrot produce --tier premium` work end-to-end: AI-generated visuals per scene, premium voice, and premium QC — landing a finished vertical video in the library at a known, capped cost. Also retire the hardening backlog Plan 1's reviews deferred.

## 2. Decisions of record

| Question | Decision |
|---|---|
| Plan scope | Premium tier + backlog hardening only. Scout loop → Plan 3; publishing → Plan 4 |
| Video-gen backend | fal.ai only. Higgsfield MCP deferred (opt-in anyway; adds OAuth + credit billing) |
| Scene→clip architecture | Image-first: FLUX keyframe → vision check → Kling image-to-video. Not direct text-to-video |
| Premium voice | ElevenLabs, with Kokoro → edge-tts fallback chain |
| Budget caps | Global daily cap (env, operator safety net) + per-channel daily cap (TOML) + per-tier per-video caps |
| Higgsfield / Sora 2 | Out (deferred / avoided per parent spec) |

## 3. Architecture principle

Premium is a flow through the existing pipeline, not a second pipeline. Same `STAGE_ORDER` (`script → voice → captions → visuals → assemble → qc`), same `JobContext`, same artifact conventions, same resume semantics. Tier branching happens inside three stages (script, voice, visuals); the runner, DB schema, and budget checkpoint machinery stay tier-agnostic beyond passing the value through.

The existing stage order is already correct for image-first premium: captions run before visuals, and scene time windows are computed from word timings.

New provider adapters, alongside the existing ones:

- `src/providers/fal.ts` — `generateImage(prompt, aspect) → file` and `animateImage(imageFile, motionPrompt, durationSec) → file`, model-parameterized (FLUX for images; Kling 3.0 default, MiniMax for cheap runs)
- `src/providers/elevenlabs.ts` — TTS with timestamps

Every paid call (image, video, TTS, vision) goes through the existing pre-call budget checkpoint and lands in the costs ledger (`fal/image`, `fal/video`, `elevenlabs/tts`, `anthropic/vision`).

## 4. Stage changes

### 4.1 Script — `scenes` format

Premium jobs use a new structured-output format (same `structuredCompletion` forced-tool pattern):

- `hook` — opening line
- `styleBlock` — one paragraph defining the video's consistent visual identity (palette, medium, mood), generated per video, optionally seeded by `style_prefix` from channel config. Prepended to every keyframe prompt.
- `scenes[]` (5–8) — each: `narration` (1–2 sentences, prompt-constrained to ≤ ~18 words so the spoken scene fits inside a 10s clip), `visualPrompt` (what the keyframe shows), `motionPrompt` (how it moves)
- `platformMeta` — unchanged from Plan 1

Volume jobs keep the existing `story` format untouched.

### 4.2 Voice — ElevenLabs + per-tier config

Premium resolves to the ElevenLabs adapter: synthesize with timestamps, write `voice/narration.wav` + `voice/voice.json` (provider recorded), and `voice/timings.json` with word-level timings (the adapter groups ElevenLabs' character-level timings into words; provider quirks stay in the adapter).

Fallback chain: ElevenLabs → Kokoro → edge-tts. The provider actually used is recorded in `voice.json`, so a downgraded premium video is visible.

This retires the known backlog gap: `ChannelConfig.voice` becomes per-tier (`[voice.volume]` / `[voice.premium]` TOML tables). The current flat shape keeps parsing (backward compatible; `channels/example.toml` stays valid).

### 4.3 Captions — dual-mode

One rule: if `voice/timings.json` exists, transform it to `captions/words.json` (identical shape to today) and skip WhisperX entirely — a premium run whose ElevenLabs synth succeeded has no sidecar dependency. Otherwise (volume jobs, or a premium job that fell back to Kokoro/edge-tts) the existing WhisperX path runs unchanged.

### 4.4 Visuals — image-first premium path

Inputs: `script.json` (scenes + styleBlock), `words.json`. Steps:

1. **Scene windows** — match each scene's narration text against the word timeline to get `startMs/endMs` per scene. Deterministic; no LLM.
2. **Per scene** (parallel, concurrency cap `scene_concurrency`, default 3, bounding peak spend-in-flight):
   1. **Keyframe** — FLUX: `styleBlock + visualPrompt`, 9:16 → `visuals/scene-NN.png` (~$0.003–0.03)
   2. **Keyframe check** — one Claude vision call: matches scene intent, coherent, no mangled anatomy/text. Fail → regenerate with the critique appended to the prompt; max 2 retries, then the scene fails.
   3. **Animate** — Kling image-to-video: keyframe + motionPrompt; duration = smallest native length (5s/10s) covering the scene window → `visuals/scene-NN.mp4`. One retry on provider error.
3. **Manifest** — `visuals/scenes.json`: per scene — window, keyframe path, clip path, attempts, per-scene cost.

Failure semantics: a scene exhausting retries fails the stage → job `failed`, resumable. Resume regenerates only missing scenes — per-scene artifacts on disk are the checkpoint, one level below Plan 1's stage-level idempotency. A budget-cap breach before any paid call parks the job `blocked`, exactly as in Plan 1.

The volume visuals path (BG library) is untouched.

### 4.5 Assembly — multi-clip timeline

`ShortVideoProps` grows a `scenes` variant: a sequenced track of `{src, trimStartMs, durationMs, playbackRate}` rendered with `OffthreadVideo`. Clips are copied into the bundle's `public/<jobId>/` with the same cleanup semantics as Plan 1. Clip audio is always muted — narration owns the audio track. Captions, narration, and auto-ducked BGM are unchanged. Volume jobs keep the single-background variant.

Fitting rule: clip trimmed to the scene window. If a window slightly exceeds its clip, playback slows to no less than 0.75× to cover; windows beyond that violate script-stage constraints and are caught by QC's duration/coverage checks.

### 4.6 QC — premium additions

The existing 9 checks run for both tiers. Premium adds:

- **Scene coverage** (free, deterministic): `scenes.json` windows tile the narration span without gaps or overlaps; every referenced clip exists with sane duration.
- **Vision spot check** (one Claude call): 3 sampled frames from `final.mp4` judged against scene intents — catches assembly-level faults the keyframe check cannot (wrong ordering, corrupted encode, captions obscuring the subject).

Any failure → `needs-review`, never auto-published (enforced when publishing lands in Plan 4).

## 5. Config and budget

Channel TOML additions (all with backward-compatible parsing):

```toml
[voice.volume]   # provider = "kokoro", voice_id = "af_heart"
[voice.premium]  # provider = "elevenlabs", voice_id = "...", model = "..."

[premium]
image_model = "flux"          # fal model id, default
video_model = "kling-3.0"     # fal model id, default; "minimax" for cheap runs
style_prefix = ""             # optional seed for the styleBlock
scene_concurrency = 3

[budget]
per_video_usd = 0.50          # existing — now explicitly the volume cap
premium_per_video_usd = 7.00  # default
per_day_usd = 10.00           # now explicitly per-channel
```

The global daily cap is an environment variable — `BRAINROT_GLOBAL_DAILY_USD` (default 25) — an operator-level safety net, not channel identity. Both caps are enforced at the same pre-call checkpoint; either breach parks the job `blocked` with a reason. All amounts remain integer micro-USD internally.

`.env.example` gains `FAL_KEY` and `ELEVENLABS_API_KEY`.

Cost envelope sanity check: ~35s premium video at 6 scenes ≈ $2.30–4.50 (Kling standard + FLUX keyframes + ElevenLabs + vision checks) — inside the parent spec's $3–7 envelope with retry headroom.

## 6. Hardening backlog (from Plan 1 ledger)

1. **Sidecar streaming upload + size cap** — stream multipart to disk in bounded chunks; reject oversized uploads with 413 (deferred Codex major).
2. **Remotion bundle-memo poisoning** — a rejected `bundle()` promise stays memoized; reset on rejection.
3. **cwd-dependent Remotion entry path** — resolve via `import.meta.url`, not `process.cwd()`.
4. **Runner final-gate try/catch** — bare `readFileSync`/`JSON.parse` of `qc.json`/`script.json` can leave a job stuck `running`.
5. **Stale `job_stages.error`** — clear it when a stage succeeds on resume.
6. **Kokoro timing-tail investigation** — real tail run showed aligned words ending ~10.5s against 15.4s narration; determine whether Kokoro trailing silence or WhisperX truncation, then fix or document. (Captions vanishing for the last third of a video is highly visible.)

Budget semantics is core design (§5). onnxruntime mutex-teardown noise at process exit is cosmetic and documented as a Plan 3 daemon concern only.

## 7. Testing

- **Unit** (fixtures, no network): fal + ElevenLabs adapters against recorded responses; scene-window computation; duration-fitting rules; dual-mode caption selection; per-channel + global budget math.
- **Contract** (flag-gated, real calls): `CONTRACT=1` runs FLUX image + ElevenLabs short synth + one MiniMax video (< $0.10 total — validates all fal plumbing). A real Kling clip sits behind `CONTRACT_PREMIUM=1` (~$0.40).
- **Golden-path integration**: seeded `script.json` + `words.json` + tiny fixture clips → real multi-clip Remotion render → structural assertions via ffprobe (duration, scene sequencing, captions present). No network.
- **Branch-end proof**: one fully real premium produce, gated on `FAL_KEY`/`ELEVENLABS_API_KEY`/`ANTHROPIC_API_KEY` being present — same pattern as Plan 1's real tail run.

## 8. Out of scope

Scout loop and production-loop automation (Plan 3); publishing adapters and scheduler (Plan 4); Higgsfield MCP adapter (future, behind the same fal-style interface); web dashboard and analytics (v2+ per parent spec).

## 9. Risks

- **fal.ai model churn** — model ids and pricing shift; ids live in config, the adapter is model-parameterized, and the contract test catches breakage cheaply.
- **Keyframe→clip drift** — Kling can animate away from the approved keyframe. Mitigated by the final vision spot check; accepted residual risk at this budget.
- **Scene-window matching brittleness** — narration text vs word-timeline alignment must tolerate punctuation/normalization drift; it gets dedicated unit tests with adversarial fixtures.
- **ElevenLabs character→word grouping** — timing math must handle multi-word tokens and punctuation; covered by unit fixtures from real recorded responses.
