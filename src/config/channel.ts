import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

export interface CaptionStyle {
  font: string
  fontSizePx: number
  activeColor: string
  inactiveColor: string
  strokePx: number
}

export interface PremiumVoiceConfig {
  provider: 'elevenlabs'
  voiceId: string
  modelId: string
}

export interface PremiumConfig {
  imageModel: string
  videoModel: string
  stylePrefix?: string
  sceneConcurrency: number
}

export interface ScoutConfig {
  subreddits: string[]
  rss: string[]
  minScore: number
  perSourceLimit: number
  autoPremium: boolean
}

export interface ChannelConfig {
  name: string
  niche: string[]
  tierMix: { volume: number; premium: number }
  voice: { volume: string; premium?: PremiumVoiceConfig }
  premium: PremiumConfig
  captionStyle: CaptionStyle
  bgDir: string
  bgmDir: string
  budget: { perVideoUsdMicros: number; premiumPerVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
  scout: ScoutConfig
}

/**
 * Defaults for the [premium] TOML table: applied whole when the table is
 * absent, per-field (via the zod defaults below) when it is partial.
 * Endpoint ids follow the plan's Interface Contract; FAL_PRICE_TABLE in
 * src/providers/fal.ts (Task 8) is the source of truth for verified live
 * ids and prices — if verification changes an id, update it here too.
 */
export const DEFAULT_PREMIUM: PremiumConfig = {
  imageModel: 'fal-ai/flux/dev',
  videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
  sceneConcurrency: 3,
}

/**
 * Defaults for the [scout] TOML table: applied whole when the table is
 * absent, per-field (via the zod defaults below) when it is partial. Empty
 * source lists mean the scout skips this channel; manual produce still works.
 *
 * Shared singleton — frozen so accidental mutation fails loudly instead of
 * leaking across channels/test runs. Callers that need per-config arrays
 * (loadChannelConfig's absent-[scout] branch) must copy subreddits/rss
 * fresh rather than spreading this object's array references.
 */
export const DEFAULT_SCOUT: ScoutConfig = Object.freeze({
  subreddits: Object.freeze([] as string[]),
  rss: Object.freeze([] as string[]),
  minScore: 60,
  perSourceLimit: 25,
  autoPremium: false,
}) as ScoutConfig

const DEFAULT_PREMIUM_PER_VIDEO_USD = 7.0
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'

const rawSchema = z.object({
  name: z.string(),
  niche: z.array(z.string()),
  script_model: z.string().default('claude-sonnet-5'),
  tier_mix: z.object({
    volume: z.number(),
    premium: z.number(),
  }),
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
  premium: z
    .object({
      image_model: z.string().default(DEFAULT_PREMIUM.imageModel),
      video_model: z.string().default(DEFAULT_PREMIUM.videoModel),
      style_prefix: z.string().optional(),
      scene_concurrency: z.number().default(DEFAULT_PREMIUM.sceneConcurrency),
    })
    .optional(),
  scout: z
    .object({
      subreddits: z.array(z.string()).default([]),
      rss: z.array(z.string()).default([]),
      min_score: z.number().int().min(0).max(100).default(DEFAULT_SCOUT.minScore),
      per_source_limit: z.number().int().min(1).max(100).default(DEFAULT_SCOUT.perSourceLimit),
      auto_premium: z.boolean().default(DEFAULT_SCOUT.autoPremium),
    })
    .optional(),
  caption_style: z.object({
    font: z.string(),
    font_size_px: z.number(),
    active_color: z.string(),
    inactive_color: z.string(),
    stroke_px: z.number(),
  }),
  budget: z.object({
    per_video_usd: z.number(),
    premium_per_video_usd: z.number().default(DEFAULT_PREMIUM_PER_VIDEO_USD),
    per_day_usd: z.number(),
  }),
  bg_dir: z.string(),
  bgm_dir: z.string(),
})

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

export function loadChannelConfig(path: string): ChannelConfig {
  const text = readFileSync(path, 'utf8')
  const raw = rawSchema.parse(parseToml(text))
  return {
    name: raw.name,
    niche: raw.niche,
    tierMix: { volume: raw.tier_mix.volume, premium: raw.tier_mix.premium },
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
    premium: raw.premium
      ? {
          imageModel: raw.premium.image_model,
          videoModel: raw.premium.video_model,
          stylePrefix: raw.premium.style_prefix,
          sceneConcurrency: raw.premium.scene_concurrency,
        }
      : { ...DEFAULT_PREMIUM },
    captionStyle: {
      font: raw.caption_style.font,
      fontSizePx: raw.caption_style.font_size_px,
      activeColor: raw.caption_style.active_color,
      inactiveColor: raw.caption_style.inactive_color,
      strokePx: raw.caption_style.stroke_px,
    },
    bgDir: raw.bg_dir,
    bgmDir: raw.bgm_dir,
    budget: {
      perVideoUsdMicros: usdToMicros(raw.budget.per_video_usd),
      premiumPerVideoUsdMicros: usdToMicros(raw.budget.premium_per_video_usd),
      perDayUsdMicros: usdToMicros(raw.budget.per_day_usd),
    },
    scriptModel: raw.script_model,
    scout: raw.scout
      ? {
          subreddits: raw.scout.subreddits,
          rss: raw.scout.rss,
          minScore: raw.scout.min_score,
          perSourceLimit: raw.scout.per_source_limit,
          autoPremium: raw.scout.auto_premium,
        }
      : { ...DEFAULT_SCOUT, subreddits: [], rss: [] },
  }
}

/**
 * Loads every channel TOML in a directory — the scout/loop enumeration.
 * Sorted by channel name (code-unit order, locale-independent) so tick
 * planning is deterministic. An unparseable file throws, naming the file:
 * a broken channel config is a config error, not a channel to skip.
 */
export function loadChannelsDir(dir: string): ChannelConfig[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.toml'))
    .sort()
  const configs = files.map((file) => {
    const path = join(dir, file)
    try {
      return loadChannelConfig(path)
    } catch (err) {
      throw new Error(`failed to load channel config ${path}: ${(err as Error).message}`)
    }
  })
  return configs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
