import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { BrainrotError, errorMessage } from '../errors.js'
import { PLATFORMS, type Platform } from '../posts/types.js'

function configInvalid(message: string): BrainrotError {
  return new BrainrotError(message, { domain: 'config', kind: 'invalid' })
}

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
  perSourceLimit: number
  /**
   * How many days of scored candidate topics to keep queued before the scout
   * skips this channel. Deeper than backlogDays by default: the scorer rejects
   * a share of what it sees, and topics go stale.
   */
  queueDays: number
  /**
   * How many LLM-generated topics to request per scout attempt (0 disables
   * generation). scoutChannel builds the llm source only when this is > 0,
   * so a channel that never sets it pays nothing.
   */
  generateTopics: number
}

export interface ChannelConfig {
  name: string
  niche: string[]
  videosPerDay: number
  /**
   * How many days of finished, unconsumed video this channel may hold before
   * production stops (plan-tick.ts). The one knob for inventory depth.
   */
  backlogDays: number
  voice: { volume: string; premium?: PremiumVoiceConfig; dev?: boolean }
  captionStyle: CaptionStyle
  bgDir: string[]
  bgmDir: string
  budget: { perVideoUsdMicros: number; perDayUsdMicros: number }
  scriptModel: string
  scout: ScoutConfig
  /**
   * Non-null iff the channel declares a [story] table: it narrates reddit
   * self-posts verbatim rather than scripting niche topics. Presence gates the
   * behavior, matching [scout].
   */
  story: StoryConfig | null
  /**
   * The platforms this channel is posted to by hand. Empty means "not decided
   * yet": the channel still produces, but has no /post checklist, and
   * pendingInventory counts every unconsumed video (see jobs/library.ts).
   */
  platforms: Platform[]
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
  perSourceLimit: 25,
  queueDays: 3,
  generateTopics: 0,
}) as ScoutConfig

/**
 * Story mode's only channel dial. Everything else about splitting is a code
 * constant (STORY_WORDS_PER_PART, src/stories/split.ts) — max_parts is
 * per-channel because it is the one number that trades story completeness
 * against how long a single post occupies the channel.
 */
export const DEFAULT_STORY_MAX_PARTS = 4

export interface StoryConfig {
  maxParts: number
}

const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'

// min_score used to gate which scored topics got stored. It is now a
// constant in code (SCOUT_MIN_SCORE, in src/scout/scout.ts) rather than a
// per-channel dial, so a channel TOML that still sets it is a load error
// naming the replacement rather than a silently ignored key.
const REMOVED_MIN_SCORE_MESSAGE =
  'min_score was removed; the scout stores only topics scoring >= 80 (SCOUT_MIN_SCORE)'

// The platforms this channel is posted to BY HAND. Not a schedule and not a
// credential — just the checklist the /post page renders and the set
// pendingInventory measures "fully posted" against.
//
// z.array(z.string()) rather than z.array(z.enum(PLATFORMS)): zod's own
// invalid_value message for an enum lists the valid options but never the
// offending value, which reads as "unrecognized key" and sends an operator
// hunting for what they actually typed. superRefine names it. The cast at the
// call site below is safe because superRefine has already rejected anything
// not in PLATFORMS.
const platformsSchema = z
  .array(z.string())
  .default([])
  .superRefine((val, ctx) => {
    const seen = new Set<string>()
    for (const p of val) {
      if (!(PLATFORMS as readonly string[]).includes(p)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown platform "${p}" — expected one of ${PLATFORMS.join(', ')}`,
        })
      }
      if (seen.has(p)) {
        ctx.addIssue({ code: 'custom', message: `duplicate platform in platforms: ${p}` })
      }
      seen.add(p)
    }
  })

const rawSchema = z.object({
  name: z.string(),
  niche: z.array(z.string()),
  script_model: z.string().default('claude-sonnet-5'),
  videos_per_day: z
    .number()
    .int('videos_per_day must be a whole number of videos')
    .positive('videos_per_day must be greater than 0'),
  backlog_days: z
    .number()
    .int('backlog_days must be a whole number of days')
    .positive('backlog_days must be greater than 0')
    .default(2),
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
      min_score: z.unknown().optional(),
      per_source_limit: z.number().int().min(1).max(100).default(DEFAULT_SCOUT.perSourceLimit),
      queue_days: z
        .number()
        .int('queue_days must be a whole number of days')
        .positive('queue_days must be greater than 0')
        .default(DEFAULT_SCOUT.queueDays),
      generate_topics: z
        .number()
        .int('generate_topics must be a whole number of topics')
        .min(0, 'generate_topics must be 0 or more (0 disables generation)')
        .max(50, 'generate_topics must be at most 50 per scout attempt')
        .default(0),
    })
    .superRefine((scout, ctx) => {
      if (scout?.min_score !== undefined) {
        ctx.addIssue({ code: 'custom', message: REMOVED_MIN_SCORE_MESSAGE, path: ['min_score'] })
      }
    })
    .optional(),
  story: z
    .object({
      max_parts: z
        .number()
        .int('max_parts must be a whole number of parts')
        .positive('max_parts must be greater than 0')
        .default(DEFAULT_STORY_MAX_PARTS),
    })
    .strict()
    .optional(),
  platforms: platformsSchema,
  publish: z.unknown().optional(),
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

// Two invariants the flat shape cannot express, both cross-field.
//
// 1. An RSS item has no post body, so a story channel scouting RSS would fetch
//    and score items it can never narrate — and look healthy doing it.
// 2. A series posts at videos_per_day/day at best, so it needs max_parts /
//    videos_per_day days to clear. backlog_days caps how much unposted video
//    a channel may hold before production stops (planTick's pendingInventory
//    gate) — if max_parts exceeds that capacity, production blocks on the
//    channel's own unfinished series before the last part is ever rendered,
//    stranding viewers on an earlier part indefinitely. Caught here rather
//    than at 3am.
const channelSchema = rawSchema.superRefine((cfg, ctx) => {
  if (cfg.publish !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['publish'],
      message:
        'the [publish] table was removed — declare targets as a top-level ' +
        'platforms = ["youtube", "instagram", "tiktok"] instead',
    })
  }
  if (cfg.story === undefined) return
  if ((cfg.scout?.rss.length ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['story'],
      message:
        'a [story] channel cannot declare [scout] rss sources — an RSS item has no post body to narrate',
    })
  }
  if ((cfg.scout?.generate_topics ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['story'],
      message:
        'a [story] channel cannot declare [scout] generate_topics — a generated topic has no post body to narrate',
    })
  }
  const capacity = cfg.videos_per_day * cfg.backlog_days
  if (cfg.story.max_parts > capacity) {
    ctx.addIssue({
      code: 'custom',
      path: ['story', 'max_parts'],
      message:
        `max_parts ${cfg.story.max_parts} exceeds videos_per_day x backlog_days (${cfg.videos_per_day} x ${cfg.backlog_days} = ${capacity}) — ` +
        'production would stall on this series before its last part rendered; raise videos_per_day or backlog_days, or lower max_parts',
    })
  }
})

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

/**
 * Parses a channel TOML's already-read text into a `ChannelConfig`.
 * `filename` carries no weight here — the filename==name invariant is
 * enforced by `loadChannelsDir`, which is the only caller that knows the
 * file's actual basename — but the parameter documents what the caller has
 * in hand, and lets error messages that want it add it later.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- filename carries no weight yet, see doc comment above
export function parseChannelToml(text: string, filename: string): ChannelConfig {
  const raw = channelSchema.parse(parseToml(text))
  return {
    name: raw.name,
    niche: raw.niche,
    videosPerDay: raw.videos_per_day,
    backlogDays: raw.backlog_days,
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
          perSourceLimit: raw.scout.per_source_limit,
          queueDays: raw.scout.queue_days,
          generateTopics: raw.scout.generate_topics,
        }
      : { ...DEFAULT_SCOUT, subreddits: [], rss: [] },
    story: raw.story ? { maxParts: raw.story.max_parts } : null,
    // Safe: platformsSchema's superRefine already rejected any value not in
    // PLATFORMS, and parse() would have thrown before reaching here.
    platforms: raw.platforms as Platform[],
  }
}

export function loadChannelConfig(path: string): ChannelConfig {
  const text = readFileSync(path, 'utf8')
  return parseChannelToml(text, path)
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
      throw configInvalid(`failed to load channel config ${path}: ${(err as Error).message}`)
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
      throw configInvalid(
        `duplicate channel name "${cfg.name}" declared by both ${prior} and ${file}`,
      )
    }
    declaredBy.set(cfg.name, file)
  }
  for (const { file, path, cfg } of parsed) {
    const base = basename(file, '.toml')
    if (base !== cfg.name) {
      throw configInvalid(
        `channel config ${path}: filename basename "${base}" must equal channel name "${cfg.name}" (rename to ${cfg.name}.toml)`,
      )
    }
  }
  return parsed.map((p) => p.cfg).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
    return { channels: [], error: errorMessage(err) }
  }
}
