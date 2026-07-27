import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import {
  instagramOptionsSchema,
  normalizeInstagramOptions,
  normalizeYoutubeOptions,
  youtubeOptionsSchema,
} from '../publish/platforms/options.js'
import { PLATFORM_QUOTAS } from '../publish/platforms/quota.js'
import { PUBLISH_PLATFORMS } from '../publish/types.js'
import type { PublishChannelConfig, PublishTargetConfig } from '../publish/types.js'

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

export interface ScoutConfig {
  subreddits: string[]
  rss: string[]
  minScore: number
  perSourceLimit: number
}

export interface ChannelConfig {
  name: string
  niche: string[]
  videosPerDay: number
  voice: { volume: string; premium?: PremiumVoiceConfig; dev?: boolean }
  captionStyle: CaptionStyle
  bgDir: string[]
  bgmDir: string
  budget: { perVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
  scout: ScoutConfig
  publish: PublishChannelConfig | null
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
}) as ScoutConfig

const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'

// A now-removed key that used to be load-bearing. zod's own strict-object
// error ("Unrecognized key: slots") tells the operator nothing about where the
// setting went, and a live channel TOML that silently stops controlling
// cadence is the worst possible outcome — so it is named explicitly, at every
// level it used to be allowed. The field is declared purely so that .strict()
// lets it through to this check; nothing ever reads it.
const REMOVED_SLOTS_MESSAGE = 'slots were removed; daily volume now comes from videos_per_day'

function rejectStaleSlots(slots: unknown, ctx: z.RefinementCtx): void {
  if (slots !== undefined) {
    ctx.addIssue({ code: 'custom', message: REMOVED_SLOTS_MESSAGE, path: ['slots'] })
  }
}

// .strict() is applied AFTER .extend() (not on the base options schema): a
// non-strict base can be extended freely, and strictness on the final,
// per-platform shape is what makes an unknown key (e.g. category_id under
// [publish.instagram]) a load error naming that platform's own field set.
// superRefine comes last so it sees the parsed shape.
const youtubeTargetSchema = youtubeOptionsSchema
  .extend({ slots: z.unknown().optional() })
  .strict()
  .superRefine((val, ctx) => rejectStaleSlots(val.slots, ctx))
const instagramTargetSchema = instagramOptionsSchema
  .extend({ slots: z.unknown().optional() })
  .strict()
  .superRefine((val, ctx) => rejectStaleSlots(val.slots, ctx))

// .strict() at this level rejects any undeclared platform sub-table (e.g.
// [publish.tiktok]) and the removed `platforms = [...]` key — zod's default
// unknown-key behavior on a strict object covers them without extra code.
// superRefine enforces the two rules the static shape cannot express: a stale
// `slots` key gets a message naming its replacement, and at least one platform
// must be declared.
const publishSchema = z
  .object({
    slots: z.unknown().optional(),
    youtube: youtubeTargetSchema.optional(),
    instagram: instagramTargetSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    rejectStaleSlots(val.slots, ctx)
    const declared = PUBLISH_PLATFORMS.filter((p) => val[p] !== undefined)
    if (declared.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a [publish] table must declare at least one platform sub-table (e.g. [publish.youtube])',
      })
    }
  })
  .optional()
type RawPublish = z.infer<typeof publishSchema>

const rawSchema = z.object({
  name: z.string(),
  niche: z.array(z.string()),
  script_model: z.string().default('claude-sonnet-5'),
  videos_per_day: z
    .number()
    .int('videos_per_day must be a whole number of videos')
    .positive('videos_per_day must be greater than 0'),
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
  scout: z
    .object({
      subreddits: z.array(z.string()).default([]),
      rss: z.array(z.string()).default([]),
      min_score: z.number().int().min(0).max(100).default(DEFAULT_SCOUT.minScore),
      per_source_limit: z.number().int().min(1).max(100).default(DEFAULT_SCOUT.perSourceLimit),
    })
    .optional(),
  publish: publishSchema,
  caption_style: z.object({
    font: z.string(),
    font_size_px: z.number(),
    active_color: z.string(),
    inactive_color: z.string(),
    stroke_px: z.number(),
  }),
  // Every cap must be strictly positive. A zero cap is a misconfiguration that
  // reads as a legitimate one everywhere downstream — plan-tick's resume floor
  // becomes 0, `0 < 0` is false, and the job livelocks instead of parking —
  // so it fails loudly here rather than quietly at 3am.
  budget: z.object({
    per_video_usd: z.number().positive('per_video_usd must be greater than 0'),
    per_day_usd: z.number().positive('per_day_usd must be greater than 0'),
  }),
  bg_dir: z.preprocess(
    (v) => (Array.isArray(v) ? (v as unknown[]) : [v]),
    z.array(z.string()).min(1),
  ),
  bgm_dir: z.string(),
})

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

// Each target — and its options object — is frozen individually, not just the
// outer targets array (loadChannelConfig also freezes `publish` and
// `publish.targets`). Defense against accidental mutation of shared config
// state across jobs/ticks: `channel.publish.targets[0].options.privacy = ...`
// must fail loudly, not silently corrupt config every subsequent tick reads.
function buildTargets(raw: NonNullable<RawPublish>): PublishTargetConfig[] {
  const targets: PublishTargetConfig[] = []
  if (raw.youtube) {
    targets.push(
      Object.freeze({
        platform: 'youtube',
        options: Object.freeze(normalizeYoutubeOptions(raw.youtube)),
      }),
    )
  }
  if (raw.instagram) {
    targets.push(
      Object.freeze({
        platform: 'instagram',
        options: Object.freeze(normalizeInstagramOptions(raw.instagram)),
      }),
    )
  }
  return targets.sort((a, b) => (a.platform < b.platform ? -1 : 1))
}

export function loadChannelConfig(path: string): ChannelConfig {
  const text = readFileSync(path, 'utf8')
  const raw = rawSchema.parse(parseToml(text))
  return {
    name: raw.name,
    niche: raw.niche,
    videosPerDay: raw.videos_per_day,
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
    scout: raw.scout
      ? {
          subreddits: raw.scout.subreddits,
          rss: raw.scout.rss,
          minScore: raw.scout.min_score,
          perSourceLimit: raw.scout.per_source_limit,
        }
      : { ...DEFAULT_SCOUT, subreddits: [], rss: [] },
    publish: raw.publish
      ? (Object.freeze({
          targets: Object.freeze(buildTargets(raw.publish)),
        }) as PublishChannelConfig)
      : null,
  }
}

/**
 * Third load-time invariant, alongside duplicate-names and filename==name:
 * a channel set may not declare more videos per day than a platform can
 * actually accept. Driven off PLATFORM_QUOTAS as plain data, so a third
 * platform is covered without touching this function.
 *
 * A 'global' quota (YouTube: ~6 uploads/day per Google Cloud project) is
 * summed across every channel declaring it; a 'channel' quota (Instagram: per
 * IG account) is checked per channel. Because videos_per_day drives
 * production as well as publishing, this also stops the pipeline rendering
 * videos that could never be posted.
 *
 * Deliberately a hard error rather than a clamp: `videos_per_day = 4` must
 * never quietly mean 3. It surfaces at edit time via `brainrot produce`, and
 * as a `config-error` tick line via tryLoadChannelsDir — never silently.
 */
function assertQuotaHeadroom(channels: ChannelConfig[]): void {
  for (const platform of PUBLISH_PLATFORMS) {
    const quota = PLATFORM_QUOTAS[platform]
    const declaring = channels.filter(
      (c) => c.publish !== null && c.publish.targets.some((t) => t.platform === platform),
    )
    if (declaring.length === 0) continue
    const cap = quota.cap()
    if (quota.scope === 'global') {
      const total = declaring.reduce((sum, c) => sum + c.videosPerDay, 0)
      if (total > cap) {
        const breakdown = declaring.map((c) => `${c.name}(${c.videosPerDay})`).join(' + ')
        throw new Error(
          `${breakdown} declare ${total} ${platform} videos/day, exceeding ${platform}'s ` +
            `${cap}/day cap (shared across all channels) — lower videos_per_day`,
        )
      }
      continue
    }
    for (const c of declaring) {
      if (c.videosPerDay > cap) {
        throw new Error(
          `${c.name} declares ${c.videosPerDay} ${platform} videos/day, exceeding ` +
            `${platform}'s ${cap}/day per-channel cap — lower videos_per_day`,
        )
      }
    }
  }
}

/**
 * Loads every channel TOML in a directory — the scout/loop enumeration.
 * Sorted by channel name (code-unit order, locale-independent) so tick
 * planning is deterministic. An unparseable file throws, naming the file:
 * a broken channel config is a config error, not a channel to skip.
 *
 * Enforces the load-bearing filename==name invariant: planTick/produce-next
 * key on cfg.name, and resumeJob resolves the channel TOML as
 * <channelsDir>/<job.channel>.toml BY FILENAME. A basename/name mismatch (or a
 * name declared by two files) would wedge the loop — the resume pass would
 * throw every tick before ever reaching the claim pass — so both are rejected
 * loudly here at load time rather than silently at 3am in cron.
 */
export function loadChannelsDir(dir: string): ChannelConfig[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.toml'))
    .sort()
  const parsed = files.map((file) => {
    const path = join(dir, file)
    try {
      return { file, path, cfg: loadChannelConfig(path) }
    } catch (err) {
      throw new Error(`failed to load channel config ${path}: ${(err as Error).message}`)
    }
  })
  // Duplicate names first: two files claiming one name would make resume's
  // by-filename lookup ambiguous and let one channel's config silently shadow
  // the other. Checked before the basename guard so the operator sees the real
  // problem (both offending files) rather than one file's basename mismatch.
  const declaredBy = new Map<string, string>()
  for (const { file, cfg } of parsed) {
    const prior = declaredBy.get(cfg.name)
    if (prior !== undefined) {
      throw new Error(`duplicate channel name "${cfg.name}" declared by both ${prior} and ${file}`)
    }
    declaredBy.set(cfg.name, file)
  }
  for (const { file, path, cfg } of parsed) {
    const base = basename(file, '.toml')
    if (base !== cfg.name) {
      throw new Error(
        `channel config ${path}: filename basename "${base}" must equal channel name "${cfg.name}" (rename to ${cfg.name}.toml)`,
      )
    }
  }
  const configs = parsed
    .map((p) => p.cfg)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  // Last of the three invariants: needs every channel parsed, since a global
  // quota is a sum across all of them.
  assertQuotaHeadroom(configs)
  return configs
}

/**
 * loadChannelsDir for the unattended surfaces (both loop ticks and the daily
 * digest), where a throw is the worst outcome: it costs the tick its JSON line
 * (exit 1, silence, every firing) and the digest its whole report. One broken
 * TOML — or a channels dir that is missing entirely — is still a hard config
 * error here, never a channel to skip: callers get an EMPTY list plus the
 * underlying message, and each decides how to report it. `brainrot produce` and
 * the other operator-facing commands keep calling loadChannelsDir directly, so
 * a human at a terminal still gets the throw.
 */
export function tryLoadChannelsDir(dir: string): { channels: ChannelConfig[]; error?: string } {
  try {
    return { channels: loadChannelsDir(dir) }
  } catch (err) {
    return { channels: [], error: err instanceof Error ? err.message : String(err) }
  }
}
