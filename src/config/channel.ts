import { readFileSync } from 'node:fs'
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
  }
}
