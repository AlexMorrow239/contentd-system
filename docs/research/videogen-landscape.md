# Automated Short-Form Video Production — Tooling Landscape (July 2026)

Survey for an automated short-form (TikTok/Shorts/Reels) video pipeline. Focus on Higgsfield, plus video-gen APIs, supporting components, and MCP servers.

---

## 1. Higgsfield (higgsfield.ai)

**What it is:** An all-in-one AI video/image generation platform ("infrastructure for AI video & image gen") that aggregates 30+ top models under one workspace and credit system. It is a *front-end aggregator over other models*, not a single proprietary model shop — it resells Sora, Veo, Kling, Seedance, MiniMax/Hailuo, Flux, Seedream, WAN, plus its own Soul (character consistency) and Cinema Studio.

**Products / capabilities:**
- **Text-to-video & image-to-video** — animate a still or prompt; camera-motion controls (dolly, crane, crash zoom, bullet time, FPV); export up to 4K.
- **Talking avatars** — "Speak" mode + Kling Avatar 2.0: hyper-realistic consistent avatars up to ~5 min from one image + long-form audio, industry-leading lip-sync. AI Avatar Generator: 40+ stock avatars or custom from prompt for UGC/product-demo/talking-head ads.
- **Soul ID** — train reusable consistent characters.
- **UGC & Product builders, Draw-to-Video** — guided templates for ad-style short content.
- Images up to 4K; models include Soul 2.0, Kling 3.0, Seedance 2.0, Cinema Studio 3.0, Veo 3.1.

**MCP server — YES, official.**
- Endpoint: `https://mcp.higgsfield.ai/mcp` (hosted, remote).
- Auth: OAuth via your Higgsfield account — **no API keys to manage**. Billed against your existing Higgsfield plan credits.
- Shipped **April 30, 2026**. Exposes 30+ models: image gen, video creation, Soul character training, video analysis, content editing.
- Clients: Claude (web, Cowork, Claude Code), OpenClaw, Hermes Agent, NemoClaw, any MCP client.
- Video output through MCP: **up to 15 seconds**, multiple cinematic styles; images up to 4K.
- Higgsfield also ships a **CLI** (higgsfield.ai/cli).

**Community MCP server (alternative):** `geopopos/higgsfield_ai_mcp` (GitHub, ~38 stars, Python/FastMCP, Python 3.10+). Tools: `generate_image` (Soul), `generate_video` (img2vid), `create_character`, `get_generation_status`, `list_characters`. Wraps the REST **Cloud API** using `HF_API_KEY` + `HF_SECRET` from cloud.higgsfield.ai/api-keys. Last fix noted Nov 2025. Use only if you want self-hosted/local control; otherwise the official hosted MCP is simpler.

**Direct API (Higgsfield Cloud API — cloud.higgsfield.ai):**
- REST; API keys at cloud.higgsfield.ai/api-keys.
- Pricing ~**$0.10 per second** of generated video.
- Up to **1080p**, ~45s average generation time (varies by duration/resolution/queue).
- Text-to-video + image-to-video POST endpoints. Also resold via aggregators (Pixazo, VideoGenAPI).

**Consumer/credit pricing (annual):** Starter $15/mo (200 credits), Plus $39/mo (1,000), Ultra $99/mo (3,000). Credit cost per generation scales with model + resolution. The MCP and consumer platform share this credit pool.

**Assessment for a pipeline:** Higgsfield's edge is the *single-credit, single-auth aggregation* of many premium models + strong avatar/lip-sync + camera controls — good for a "one integration, many models" strategy and for talking-head shorts. Downsides: 15s cap via MCP, credit accounting is opaque vs. raw per-second APIs, and you pay a markup over calling Veo/Kling/fal directly. The official hosted MCP is the fastest way to wire it into an agent.

---

## 2. AI Video-Generation APIs (pipeline subcomponents)

| Provider / model | API | Rough price | Max clip | Strengths | MCP |
|---|---|---|---|---|---|
| **Google Veo 3.1** (Gemini API / Vertex) | Yes, official | Fast **$0.15/s** (w/ audio); Standard **$0.40/s**; Lite $0.03/s (720p, no audio); 4K ~$0.60/s | 8s native (extendable) | Best-in-class realism + **native synced audio**; strong prompt adherence | Via fal/Replicate/aggregator MCPs; no dedicated official MCP |
| **OpenAI Sora 2** | Yes (launched Oct 2025) | Standard **$0.10/s** (720p; $0.05 batch); Pro $0.30–0.70/s by res | 10s+ | Physics/coherence, cameo/character; **API sunsets Sep 24 2026** — risk | No official MCP |
| **Kling 3.0 / O3** (kling.ai/dev) | Yes, official | **$0.075–0.42/s** (6–12 credits/s; +2/s voice ctrl) | 5–10s | Best price/quality; strong motion; **Kling Avatar 2.0** lip-sync | Via VidMCP/fal MCP |
| **Runway Gen-4 / 4.5** (dev.runwayml.com) | Yes, official | **$0.12/s** (Gen-4.5 ~12 credits/s; plans from $12/mo) | ~10s | Pro editing/act-two, motion control, ecosystem | Via VidMCP |
| **Luma Dream Machine / Ray 2** | Yes, official | Ray 2 ~**$0.19/s** (5s 1080p = $0.95); Ray 2 Flash ~1/3 that | 5–10s | Fast, smooth; Luma bundles Veo/Kling/Seedance + ElevenLabs under one pool | Community MCPs |
| **MiniMax / Hailuo (Video-01)** | Yes | **$0.02–0.05/video** (cheapest) | ~6s | Cheapest, fast, decent quality; great for volume | Via fal/aggregators |
| **Pika** | Limited API | from **$0.03/generation** | short | Effects/templates, social-native | — |
| **fal.ai** (aggregator) | Yes, official | Video **$0.04–0.30/s**; ~985 endpoints; typically 20–40% cheaper than Replicate | model-dep. | Best price + speed, one API for Veo/Kling/Hailuo/Seedance/FLUX; **official + community MCP** | **Yes** |
| **Replicate** (aggregator) | Yes, official | pay-per-run | model-dep. | Widest model variety, community models, easy | Community MCP |

**Top-3 picks for a cost-conscious auto-pipeline:** (1) **fal.ai** — one API, cheapest video, MCP, model choice; (2) **Google Veo 3.1 Fast** ($0.15/s w/ audio) for hero quality + native sound; (3) **Kling 3.0** ($0.075/s) for cheap high-quality b-roll + avatar lip-sync. MiniMax/Hailuo is the budget volume option. Avoid building critical path on **Sora 2** given the Sep 2026 API sunset.

---

## 3. Supporting Components

### TTS (voiceover)
- **ElevenLabs** — best quality/expressiveness; official MCP (`uvx elevenlabs-mcp`). ~$0.12–0.30 per 1K chars depending on plan (Creator overage $0.30/1K → Business $0.12/1K). Premium tier (~$103–206/1M chars). Also ships ElevenMusic + SFX.
- **OpenAI TTS** — ~$15/1M chars, good quality-per-dollar, simple.
- **Kokoro-82M** (open source) — self-host ~$0.70/1M chars but needs GPU. Great for free/local high-quality.
- **edge-tts** (free, unofficial MS Edge voices) — zero cost, decent, good for prototyping/volume; ToS-gray for production.
- Budget hosted newcomers: Inworld TTS (~$10/1M), Hume, Deepgram Aura-2.
- **Recommended:** ElevenLabs (quality, has MCP) for hero VO; Kokoro or edge-tts for zero-cost volume.

### Word-level subtitle alignment (karaoke captions)
- **WhisperX** — faster-whisper + wav2vec2 forced alignment → **<100ms (±50ms) word timestamps** + pyannote diarization. Best for local karaoke-style captions. **Recommended default.**
- **faster-whisper** — CTranslate2-optimized Whisper, 4x faster, INT8/FP16; the transcription engine WhisperX builds on.
- **AssemblyAI** — hosted API, word timestamps + diarization (Universal model); no local inference, pay per audio-hour. Use if you don't want to run GPUs.

### Stock footage / b-roll
- **Pexels API** — free, ~150k videos, commercial use, no attribution. Simple REST + key.
- **Pixabay API** — free, royalty-free images+videos, no attribution.
- Both ideal free b-roll sources.

### Music
- **Suno API** — full songs/instrumentals any genre (used in production pipelines). Best AI music option.
- **ElevenLabs Music + SFX** — integrated with the ElevenLabs MCP/API.
- Royalty-free libraries (Pixabay music) for zero-cost background beds.

### Video assembly / rendering
- **FFmpeg** — max control, scriptable, the universal backbone (everything wraps it).
- **MoviePy** (Python) — programmatic edits/compositing/overlays; natural fit if pipeline is Python.
- **Remotion** (React/TSX) — programmatic video via components; bundles FFmpeg since v4; great for animated captions, templated shorts, timeline compositing. Strong for design-system-consistent output.
- **editly** — JSON-spec Node video editor (simpler, less active than Remotion).
- **Recommended:** Remotion for templated captioned shorts; MoviePy/FFmpeg for glue and quick concatenation.

### Auto-publishing (official APIs)
- **YouTube Data API v3** — upload = **1,600 quota units**; default **10,000/day = ~6 uploads/day**. Free quota increase via Google Cloud Console (needs use-case + ToS compliance + often audit). Shorts = 9:16, <60s, `#Shorts`.
- **TikTok Content Posting API** — OAuth; **6 req/min per user**; ~**25 videos/account/day** cap; unaudited apps restricted to private/SELF_ONLY posts until app audit approves public "Direct Post." Most approved apps ~100 posts/day across accounts. Requires TikTok developer app + review.
- **Instagram Reels** — via Instagram Graph API (Business/Creator accounts, requires Facebook app + review); rate-limited, no free-form personal posting.
- **Reality check:** publishing is the hardest/most gated step — all three require app review/audit, low daily quotas, and OAuth per creator account. Budget for manual review cycles; third-party relays (Postproxy, Blotato, Zernio) exist but add cost/ToS risk.

---

## 4. Relevant MCP Servers

**Video generation**
- **Higgsfield (official)** — `https://mcp.higgsfield.ai/mcp`, 30+ models, OAuth, credit-billed. (See §1.)
- **Higgsfield community** — `geopopos/higgsfield_ai_mcp` (Python/FastMCP, BYO API key/secret).
- **VidMCP** (`aparna162/vidmcp`) — smart multi-provider "intelligence layer," BYOK for Kling/Runway/fal.ai/ElevenLabs; you pay providers directly, VidMCP charges only for orchestration.
- **fal.ai video generator MCP** (el-el-san, on PulseMCP) — wraps fal video models.
- **vidmcp / mcp-video (KyaniteLabs "Kinocut")** — guardrailed local video-editing MCP over FFmpeg with preflight validation + "Video Receipt" provenance + release checkpoints; local, free.

**TTS / audio**
- **ElevenLabs MCP (official)** — `uvx elevenlabs-mcp`; TTS, voice clone, transcription, SFX/music as products expand. Works in Claude/Cursor/Windsurf.
- **MeloTTS MCP** — local TTS with FFmpeg merge, multilingual.

**Media processing (FFmpeg)**
- **`misbahsy/video-audio-mcp`** — FFmpeg-powered editing (convert, trim, overlays, transitions, audio).
- **FFmpeg MCP servers** (video-creator, ZizoTheDev, ffmpeg-micro) — ~17 tools: convert, compress, watermark, extract audio, merge. Multiple on Glama/PulseMCP/mcpmarket.
- **Kinocut** (above) — the most production-safe FFmpeg MCP (guardrails + provenance).

**Notable non-MCP but highly relevant**
- **OpenMontage** (`calesthio/OpenMontage`, AGPLv3, very popular) — open-source *agentic video production system* (pipeline YAML + director skills + Python tools, not an MCP). Integrates 15 video providers (Kling, Runway, Veo 3, HeyGen, WAN/Hunyuan/CogVideo local, Pexels/Pixabay/Wikimedia stock), 11 image gens, 5 TTS (ElevenLabs, Google, OpenAI, Piper), Suno music, and Remotion/HyperFrames/FFmpeg composition. Has dedicated **shorts/social-repurposing pipelines** (9:16, word-level captions). Strong reference architecture / possible base to fork.

---

## Bottom-line pipeline recommendation
- **Model access:** fal.ai (cheap, MCP, many models) as primary; Veo 3.1 Fast for hero clips with audio; Kling for cheap quality + avatars. Consider Higgsfield's official MCP if you want avatars/lip-sync + camera controls under one auth (accept 15s cap + markup).
- **VO:** ElevenLabs (has MCP) or Kokoro/edge-tts for free volume.
- **Captions:** WhisperX (local, <100ms word timestamps).
- **Assembly:** Remotion (templated captioned shorts) + FFmpeg glue.
- **Music:** Suno API / Pixabay royalty-free.
- **Publish:** YouTube Data API + TikTok Content Posting API — expect app audits, ~6 YT uploads/day and ~25 TikTok/day quotas; hardest step.
- **Reference:** study/fork OpenMontage.
