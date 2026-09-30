import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { BrainrotError, errorMessage } from '../errors.js'
import { PLATFORMS, type Platform } from '../posts/types.js'
import { validateChannelBudget } from './budget.js'

function configInvalid(message: string): BrainrotError {
  return new BrainrotError(message, { domain: 'config', kind: 'invalid' })
}

export interface VoiceConfig {
  voiceId: string
  modelId: string
}

export interface ScoutConfig {
  /** Bare subreddit names, read through Arctic Shift — the only scout source. */
  subreddits: string[]
  perSourceLimit: number
  /**
   * How many days of scored candidate topics to keep queued before the scout
   * skips this channel. Deeper than backlogDays by default: the scorer rejects
   * a share of what it sees, and topics go stale.
   */
  queueDays: number
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
  voice: VoiceConfig
  bgDir: string[]
  budget?: { perDayUsdMicros: number }
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
 * absent, per-field (via the zod defaults below) when it is partial. An empty
 * subreddit list means the scout skips this channel; manual produce still
 * works.
 *
 * Shared singleton — frozen so accidental mutation fails loudly instead of
 * leaking across channels/test runs. Callers that need per-config arrays
 * (loadChannelConfig's absent-[scout] branch) must copy subreddits fresh
 * rather than spreading this object's array reference.
 */
export const DEFAULT_SCOUT: ScoutConfig = Object.freeze({
  subreddits: Object.freeze([] as string[]),
  perSourceLimit: 25,
  queueDays: 3,
}) as ScoutConfig

/**
 * Story mode's only channel dial. Everything else about splitting is a code
 * constant (STORY_WORDS_PER_PART, daemon/src/stories/split.ts) — max_parts is
 * per-channel because it is the one number that trades story completeness
 * against how long a single post occupies the channel.
 */
export const DEFAULT_STORY_MAX_PARTS = 4

export interface StoryConfig {
  maxParts: number
}

const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2'

// min_score used to gate which scored topics got stored. It is now a
// constant in code (SCOUT_MIN_SCORE, in daemon/src/scout/scout.ts) rather than a
// per-channel dial, so a channel TOML that still sets it is a load error
// naming the replacement rather than a silently ignored key.
const REMOVED_MIN_SCORE_MESSAGE =
  'min_score was removed; the scout stores only topics scoring >= 80 (SCOUT_MIN_SCORE)'

// RSS feeds and LLM topic generation were scout sources until subreddits read
// through Arctic Shift became the only one. A TOML still declaring either is
// a load error rather than a silently ignored key, so an operator learns the
// supply they configured no longer exists.
const REMOVED_SCOUT_SOURCE_MESSAGES = {
  rss: '[scout] rss was removed; subreddits (read through Arctic Shift) are the only scout source',
  generate_topics:
    '[scout] generate_topics was removed; subreddits (read through Arctic Shift) are the only scout source',
} as const

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
  voice: z
    .object({
      voice_id: z.string().trim().min(1, '[voice] voice_id must not be empty'),
      model: z
        .string()
        .trim()
        .min(1, '[voice] model must not be empty')
        .default(DEFAULT_ELEVENLABS_MODEL_ID),
    })
    .strict(),
  scout: z
    .object({
      subreddits: z.array(z.string()).default([]),
      rss: z.unknown().optional(),
      generate_topics: z.unknown().optional(),
      min_score: z.unknown().optional(),
      per_source_limit: z.number().int().min(1).max(100).default(DEFAULT_SCOUT.perSourceLimit),
      queue_days: z
        .number()
        .int('queue_days must be a whole number of days')
        .positive('queue_days must be greater than 0')
        .default(DEFAULT_SCOUT.queueDays),
    })
    .superRefine((scout, ctx) => {
      if (scout?.min_score !== undefined) {
        ctx.addIssue({ code: 'custom', message: REMOVED_MIN_SCORE_MESSAGE, path: ['min_score'] })
      }
      for (const key of ['rss', 'generate_topics'] as const) {
        if (scout[key] !== undefined) {
          ctx.addIssue({ code: 'custom', message: REMOVED_SCOUT_SOURCE_MESSAGES[key], path: [key] })
        }
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
  caption_style: z.unknown().optional(),
  budget: z
    .object({
      per_video_usd: z.unknown().optional(),
      per_day_usd: z.number().positive('per_day_usd must be greater than 0').optional(),
    })
    .superRefine((budget, ctx) => {
      if (budget.per_video_usd !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['per_video_usd'],
          message: 'per_video_usd was removed; remove it and optionally set [budget] per_day_usd',
        })
      }
    })
    .optional(),
  bg_dir: z.preprocess(
    (v) => (Array.isArray(v) ? (v as unknown[]) : [v]),
    z.array(z.string()).min(1),
  ),
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
  if (cfg.caption_style !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['caption_style'],
      message:
        'the [caption_style] table was removed; caption styling is shared in code (CAPTION_STYLE)',
    })
  }
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
  const perDayUsdMicros =
    raw.budget?.per_day_usd === undefined ? undefined : usdToMicros(raw.budget.per_day_usd)
  validateChannelBudget(raw.name, perDayUsdMicros)
  return {
    name: raw.name,
    niche: raw.niche,
    videosPerDay: raw.videos_per_day,
    backlogDays: raw.backlog_days,
    voice: {
      voiceId: raw.voice.voice_id,
      modelId: raw.voice.model,
    },
    bgDir: raw.bg_dir,
    ...(perDayUsdMicros === undefined ? {} : { budget: { perDayUsdMicros } }),
    scriptModel: raw.script_model,
    scout: raw.scout
      ? {
          subreddits: raw.scout.subreddits,
          perSourceLimit: raw.scout.per_source_limit,
          queueDays: raw.scout.queue_days,
        }
      : { ...DEFAULT_SCOUT, subreddits: [] },
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
 * The single-file form of `loadChannelsDir`'s filename==name invariant: resume
 * and the `jobs.produce` action both want one named channel, and each used to
 * get it a different way — resume by joining `<name>.toml` and trusting an
 * invariant it never verified, the action by parsing the whole directory to
 * `.find` one entry. This verifies what resume assumed without the
 * whole-directory parse the action paid for.
 *
 * Throws a config error naming the file for both a missing file and a
 * mismatch; callers wanting a softer outcome (resume's `ResumeError`) catch
 * and translate.
 */
export function loadChannelByName(channelsDir: string, name: string): ChannelConfig {
  const path = join(channelsDir, `${name}.toml`)
  if (!existsSync(path)) {
    throw configInvalid(`channel config not found: ${path}`)
  }
  let cfg: ChannelConfig
  try {
    cfg = loadChannelConfig(path)
  } catch (err) {
    throw configInvalid(`failed to load channel config ${path}: ${(err as Error).message}`)
  }
  if (cfg.name !== name) {
    throw configInvalid(
      `channel config ${path}: filename basename "${name}" must equal channel name "${cfg.name}" (rename to ${cfg.name}.toml)`,
    )
  }
  return cfg
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
