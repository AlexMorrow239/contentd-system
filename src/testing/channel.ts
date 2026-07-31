import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SCOUT } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
import type { Platform } from '../publish/types.js'
import { tmpDir } from './tmp.js'

/**
 * Channel fixtures, in both shapes tests need: the parsed `ChannelConfig`
 * object, and the on-disk TOML that `loadChannelConfig`/`loadChannelsDir`
 * consume.
 *
 * `testChannel` moved here from src/stages/_testkit.ts. It was imported by
 * fifteen files across every module, so a *stages* file had become a
 * repo-wide dependency. The TOML builders replace a ~20-line string-array
 * literal that had been copy-pasted into eight files, two of which had
 * independently reinvented the same parameterized builder.
 */

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
}

export { PLATFORM_META }

export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: 'test',
    niche: ['space facts', 'astronomy'],
    videosPerDay: 2,
    backlogDays: 2,
    voice: {
      volume: 'af_heart',
      premium: {
        provider: 'elevenlabs',
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        modelId: 'eleven_multilingual_v2',
      },
    },
    captionStyle: {
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    },
    bgDir: ['assets/bg'],
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    scout: { ...DEFAULT_SCOUT },
    story: null,
    publish: null,
    ...overrides,
  }
}

export interface ChannelTomlOptions {
  name?: string
  niche?: string[]
  videosPerDay?: number
  scriptModel?: string
  bgDir?: string | string[]
  bgmDir?: string
  /** Top-level `backlog_days` override. Omitted, the schema default (2) applies. */
  backlogDays?: number
  /** Platforms to emit a `[publish.<platform>]` sub-table for. */
  platforms?: Platform[]
  /** Lines appended inside the last `[publish.<platform>]` sub-table. */
  platformOptions?: Partial<Record<Platform, string[]>>
  /** Extra lines appended verbatim, for one-off keys not worth a parameter. */
  extra?: string[]
}

/**
 * The TOML text for one channel. Always a *loadable* config — tests that want
 * an invalid one build it from `channelTomlLines()` and edit the array.
 *
 * Two ordering rules are load-bearing, not cosmetic:
 *   - `bg_dir`/`bgm_dir` are top-level keys, so they must precede every
 *     `[section]` header, else TOML nests them under the last-opened table and
 *     the values silently vanish. `extra` lines are appended *after* the final
 *     `[budget]` header, so any other top-level key routed through `extra`
 *     (e.g. a bare `backlog_days = N`) silently nests under `[budget]` instead
 *     of landing at top level — the `budget` schema isn't `.strict()`, so the
 *     stray key is dropped with no error and the field quietly falls back to
 *     its default. That is why `backlog_days` gets its own `backlogDays`
 *     option below rather than being left to `extra`.
 *   - `[publish]` carries no keys of its own any more; `slots` was removed in
 *     favor of `videos_per_day` and `loadChannelConfig` now *rejects* it by
 *     name (see rejectStaleSlots in src/config/channel.ts), so this builder
 *     must never emit one.
 */
/**
 * Overrides replace a default with the same `key = ` prefix rather than
 * appending beside it. TOML rejects a redefined key outright, so a caller
 * supplying its own `ig_user_id` must not also get the default one.
 */
function mergeTomlKeys(defaults: string[], overrides: string[]): string[] {
  const keyOf = (line: string) => line.split('=')[0].trim()
  const overridden = new Set(overrides.map(keyOf))
  return [...defaults.filter((l) => !overridden.has(keyOf(l))), ...overrides]
}

export function channelTomlLines(opts: ChannelTomlOptions = {}): string[] {
  const lines = [
    `name = ${JSON.stringify(opts.name ?? 'example')}`,
    `niche = ${JSON.stringify(opts.niche ?? ['space facts', 'astronomy'])}`,
    `script_model = ${JSON.stringify(opts.scriptModel ?? 'claude-sonnet-5')}`,
    `videos_per_day = ${opts.videosPerDay ?? 2}`,
    // Required by the schema, so defaulted rather than conditional.
    `bg_dir = ${JSON.stringify(opts.bgDir ?? 'assets/bg')}`,
    `bgm_dir = ${JSON.stringify(opts.bgmDir ?? 'assets/bgm')}`,
    ...(opts.backlogDays === undefined ? [] : [`backlog_days = ${opts.backlogDays}`]),
    '',
    '[voice]',
    'volume = "af_heart"',
    '',
    '[caption_style]',
    'font = "Inter"',
    'font_size_px = 72',
    'active_color = "#FFD700"',
    'inactive_color = "#FFFFFF"',
    'stroke_px = 8',
    '',
    '[budget]',
    'per_video_usd = 8.0',
    'per_day_usd = 20.0',
  ]
  if (opts.platforms?.length) {
    lines.push('', '[publish]')
    for (const platform of opts.platforms) {
      lines.push('', `[publish.${platform}]`)
      // instagramOptionsSchema requires ig_user_id; youtube has no required fields.
      const defaults = platform === 'instagram' ? ['ig_user_id = "ig-test-user"'] : []
      lines.push(...mergeTomlKeys(defaults, opts.platformOptions?.[platform] ?? []))
    }
  }
  if (opts.extra?.length) lines.push('', ...opts.extra)
  return lines
}

export function channelToml(opts: ChannelTomlOptions = {}): string {
  return channelTomlLines(opts).join('\n') + '\n'
}

/** Writes one channel TOML into a fresh temp dir and returns its path. */
export function writeChannelToml(opts: ChannelTomlOptions = {}): string {
  const dir = tmpDir('brainrot-chan-')
  const file = path.join(dir, `${opts.name ?? 'example'}.toml`)
  writeFileSync(file, channelToml(opts))
  return file
}

/**
 * Writes a whole channels directory and returns its path. Keys are filenames.
 *
 * `loadChannelsDir` enforces that a file's basename equals the TOML's `name`
 * field, so passing explicit filenames is what lets a test exercise the
 * mismatch case deliberately.
 *
 * Pass `dir` to write into an existing directory — a `testRoot().channelsDir`,
 * typically, since the CLI now derives that path from the root rather than
 * taking it as a flag. Omitted, it mints its own temp dir as before.
 */
export function writeChannelsDir(
  files: Record<string, string | string[]>,
  dir = tmpDir('brainrot-channels-'),
): string {
  mkdirSync(dir, { recursive: true })
  for (const [filename, body] of Object.entries(files)) {
    const contents = Array.isArray(body) ? body.join('\n') : body
    writeFileSync(path.join(dir, filename), contents)
  }
  return dir
}
