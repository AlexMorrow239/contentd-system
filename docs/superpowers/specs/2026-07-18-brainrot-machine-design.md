# Brainrot Machine — Design Spec

**Date:** 2026-07-18
**Status:** Draft for review
**Research inputs:** [MoneyPrinterTurbo teardown](../../research/moneyprinterturbo-teardown.md), [Video-gen landscape survey](../../research/videogen-landscape.md)

## 1. Purpose

A personal, fully automated short-form content machine: it discovers trending topics in configured niches, produces finished vertical videos in two quality tiers, and auto-publishes them to YouTube Shorts, TikTok, and Instagram Reels on a schedule. Single operator (Alex), no multi-tenancy, no hosted product ambitions.

Success criteria:
- Runs unattended for days: topics in → published videos out, with a daily digest.
- Cost per video is known before and after production; hard budget caps prevent surprises.
- Output quality is visibly modern (word-level animated captions, AI visuals on premium tier) — not 2020-era stock-footage montage.
- Portable: runs on the Mac via Docker Compose today, lifts to a VPS unchanged.

## 2. Decisions of record

| Question | Decision |
|---|---|
| Audience | Personal content machine (own channels) |
| Formats | AI-generated visuals (premium tier) + story/BG-loop (volume tier) |
| Publishing | Full auto-publish |
| Platforms | YouTube Shorts, TikTok, Instagram Reels |
| Volume/budget | Mixed portfolio: cheap volume videos daily + occasional premium; per-video quality tiers |
| Topic source | Trend-driven (scraped sources scored per niche) |
| Runtime | Local Mac now, cloud VPS later (Docker-portable) |
| Architecture | Hybrid: deterministic pipeline core, LLM-powered creative stages, provider adapters |
| Core language | TypeScript (Remotion-native); WhisperX as Python sidecar container |

## 3. System architecture

Single repo: pipeline daemon + CLI (`brainrot`), Docker Compose, SQLite state, artifacts on disk. Three decoupled cron-driven loops, so a failure in one never blocks the others:

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│ SCOUT LOOP   │ →  │ PRODUCTION LOOP   │ →  │ PUBLISH LOOP   │
│ trends → LLM │    │ topic → video     │    │ library →      │
│ → topic queue│    │ → library         │    │ platforms      │
└─────────────┘     └──────────────────┘     └───────────────┘
        (SQLite queue/state between loops; artifacts in runs/<job-id>/)
```

- **Scout loop** (a few times/day): scrapes trend sources (Google Trends, Reddit, niche RSS), an LLM scores candidates against each channel's niche, deduplicates against topic history, enqueues.
- **Production loop**: claims queued topics, runs the stage pipeline (§4), lands finished mp4 + per-platform metadata in the library.
- **Publish loop**: drains the library per channel cadence and platform quota budgets, uploads, records post IDs/URLs.

**Channels are config files** (one TOML per channel in `channels/`): niche keywords + trend sources, tier mix (e.g. `2 volume + 1 premium per day`), voice, caption style, BGM folder, posting cadence and times, platform targets. The DB holds state only; config lives in files (versionable, portable).

**Every job carries a `tier`:**
- `volume` — story/BG-loop format. Local TTS, curated BG footage library, captions. Marginal cost ≈ LLM cents.
- `premium` — AI-generated visuals per scene. ~$3–7/video depending on model (§5).

## 4. Production pipeline

Stages are idempotent; each writes artifacts to `runs/<job-id>/<stage>/` and records status in SQLite. A failed job resumes from its last good stage. Stage list:

1. **Script** — Claude API (Sonnet default, model configurable per channel) with structured output: hook, narration segments each carrying a visual direction, plus per-platform title/description/hashtags. Format templates: `story` (narrative arc) and `scenes` (scene list with visual prompts).
2. **Voice** — tier-dependent with fallback chain: premium → ElevenLabs; volume → Kokoro (local, free); last resort → edge-tts. Output: narration audio (+ provider timestamps when available).
3. **Caption timing** — dual-mode: use TTS-provider word/char timings if present (ElevenLabs), else align via **WhisperX sidecar** (word-level timestamps). Output: word-timed transcript JSON.
4. **Visuals** —
   - *volume:* select from local curated BG library (`assets/bg/`), avoiding recent reuse per channel; crop 9:16; loop to narration length.
   - *premium:* per scene, call video-gen adapter `(prompt, durationSec, aspect) → clipFile`. Scenes generate in parallel with per-clip retry.
5. **Assembly** — **Remotion** composition per format template: 9:16, visuals track, word-by-word animated captions (per-channel style), narration, auto-ducked BGM from royalty-free folder. Rendered via Remotion renderer to H.264 mp4. No MoviePy.
6. **QC gate** — automated: duration within platform bounds, audio present and levels sane, no black/frozen-frame segments, captions rendered, file size OK. Premium adds a vision-model spot check (sampled frames vs. scene intent). Fail → video parked `needs-review`, never auto-published.
7. **Metadata** — per-platform title/description/hashtags packaged with the mp4 into the library.

## 5. Provider adapters

All external capabilities sit behind narrow interfaces so providers are swappable per channel/tier without touching pipeline logic.

**Video generation** — `generateClip(prompt, durationSec, aspect) → file`
- **Primary: fal.ai** (single API + JS client over many models): Kling 3.0 default (~$0.075–0.42/s, best price/quality), Veo 3.1 Fast for hero videos (~$0.15/s, native audio), MiniMax/Hailuo for cheap experiments (~$0.02–0.05/video).
- **Optional: Higgsfield MCP** (official hosted server, `https://mcp.higgsfield.ai/mcp`, OAuth) — same adapter interface; enables Soul styles / avatar models. Constraints: clips ≤15s (fine — scenes are shorter), credit-based billing at a markup over raw APIs, so it is a per-channel opt-in, not the default.
- Avoided: Sora 2 API (announced sunset Sep 2026).

**TTS** — ElevenLabs (premium), Kokoro local (volume), edge-tts (fallback).
**Alignment** — WhisperX sidecar container (Python, faster-whisper backend).
**LLM** — Claude API via SDK; model per stage in config.
**Trends** — per-source scrapers (Google Trends, Reddit JSON API, RSS) behind a `TrendSource` interface; easy to add sources later.

## 6. Publishing

One interface: `upload(video, metadata, auth) → postId`, three adapters:

| Platform | API | Constraints | v1 reality |
|---|---|---|---|
| YouTube Shorts | Data API v3, resumable upload, OAuth refresh token | ~6 uploads/day on default 10k-unit quota (1,600/upload); quota increase requestable | Ships first, day one |
| TikTok | Content Posting API | Developer app + **audit required for public posts**; unaudited = private/draft only | Adapter built in v1; public auto-posting activates when audit clears — apply immediately |
| Instagram Reels | Graph API | Requires Business/Creator account linked to a Facebook page; ~25 posts/day | Ships in v1 after one-time account setup |

**Publish scheduler:** drains library per channel cadence (e.g. posted 10:00/14:00/19:00), respects per-platform daily quotas, staggers platforms, records post IDs/URLs/status. Platform failure marks the publish attempt failed and retries next slot — production is unaffected.

## 7. Data model (SQLite)

- `topics` — candidate/used/rejected, source, score, channel, dedupe hash
- `jobs` — one per video: channel, tier, format, stage statuses, artifact paths, timestamps
- `library` — finished videos: file path, metadata JSON, QC result, state (`ready` / `needs-review` / `published` / `blocked`)
- `publishes` — job × platform: status, post ID, URL, error, attempt count
- `costs` — ledger: job, provider, operation, units, USD
- `oauth_tokens` — per-platform encrypted-at-rest tokens

Artifacts (audio, clips, renders) live on disk under `runs/<job-id>/`; the DB stores paths, not blobs.

## 8. Reliability & cost control

- **Retries with backoff** per provider call; **circuit breaker** per provider trips the fallback chain (Kling → MiniMax; ElevenLabs → Kokoro → edge-tts).
- **Resumable jobs**: stage idempotency + on-disk artifacts mean a crash resumes mid-job, MPT's best batch behavior generalized.
- **Cost ledger + hard caps**: config sets per-video and per-day USD caps. Every paid call checks the ledger first; a breach parks the job `blocked` with a reason. Caps are enforcement, not estimates.
- **Observability v1**: CLI (`brainrot status | jobs | costs | library`), structured logs, daily digest notification (produced/published/spent/failed). Web dashboard is v2.

## 9. Testing

- **Unit tests** on stage logic with recorded API fixtures (no network).
- **Contract tests** per provider adapter: one cheap real call each, manually triggered behind a flag.
- **Golden-path integration test**: fixed script + fixed assets → real Remotion render, asserting structure (duration, stream layout, caption count) — not pixel equality.
- **Dry-run modes**: publish adapters no-op with full logging; end-to-end `--dry-run` produces a real video but never uploads.

## 10. Scope

**v1:** everything above — three loops, both tiers, three platform adapters (TikTok public-posting pending audit), CLI, Docker Compose, cost caps, daily digest.

**Explicitly v2+ (not built now):** web dashboard; analytics feedback loop (pull view counts to score topics/formats and bias the scout); A/B hook/thumbnail testing; multi-language; Postgres migration.

## 11. Risks

- **TikTok audit** is external and slow; treat TikTok as best-effort until cleared.
- **YouTube quota** (~6/day) bounds volume-tier throughput per channel until an increase is granted.
- **Platform policy**: YouTube requires disclosure of realistic synthetic content, and all platforms police "inauthentic/mass-produced" content for monetization. Mitigations: disclosure flags set at upload where applicable; quality gates and per-channel curation over raw volume.
- **Provider churn** (e.g. Sora API sunset): adapter interfaces keep any single provider replaceable in one file.
