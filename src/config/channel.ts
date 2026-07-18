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

export interface ChannelConfig {
  name: string
  niche: string[]
  tierMix: { volume: number; premium: number }
  voice: { volume: string }
  captionStyle: CaptionStyle
  bgDir: string
  bgmDir: string
  budget: { perVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
}

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
  }),
  caption_style: z.object({
    font: z.string(),
    font_size_px: z.number(),
    active_color: z.string(),
    inactive_color: z.string(),
    stroke_px: z.number(),
  }),
  budget: z.object({
    per_video_usd: z.number(),
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
    voice: { volume: raw.voice.volume },
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
      perDayUsdMicros: usdToMicros(raw.budget.per_day_usd),
    },
    scriptModel: raw.script_model,
  }
}
