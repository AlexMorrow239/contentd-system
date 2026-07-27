import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SCOUT } from '../config/channel.js'
import type { ChannelConfig } from '../config/channel.js'
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
  /** Platforms to emit a `[publish.<platform>]` sub-table for. */
  platforms?: ('youtube' | 'instagram')[]
  slots?: string[]
  timezone?: string
  /** Extra lines appended verbatim, for one-off keys not worth a parameter. */
  extra?: string[]
}

/**
 * The TOML text for one channel.
 *
 * Key ordering is load-bearing, not cosmetic: `bg_dir`/`bgm_dir` are top-level
 * keys, so they must precede every `[section]` header — otherwise TOML nests
 * them under the last-opened table and the config silently loses them.
 */
export function channelToml(opts: ChannelTomlOptions = {}): string {
  const lines = [
    `name = ${JSON.stringify(opts.name ?? 'example')}`,
    `niche = ${JSON.stringify(opts.niche ?? ['space facts', 'astronomy'])}`,
    `script_model = ${JSON.stringify(opts.scriptModel ?? 'claude-sonnet-5')}`,
    `videos_per_day = ${opts.videosPerDay ?? 2}`,
  ]
  if (opts.bgDir !== undefined) lines.push(`bg_dir = ${JSON.stringify(opts.bgDir)}`)
  if (opts.bgmDir !== undefined) lines.push(`bgm_dir = ${JSON.stringify(opts.bgmDir)}`)
  lines.push(
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
  )
  if (opts.platforms?.length) {
    lines.push('', '[publish]')
    lines.push(`slots = ${JSON.stringify(opts.slots ?? ['09:00'])}`)
    if (opts.timezone) lines.push(`timezone = ${JSON.stringify(opts.timezone)}`)
    for (const platform of opts.platforms) {
      lines.push('', `[publish.${platform}]`)
      // instagramOptionsSchema requires ig_user_id; youtube has no required fields.
      if (platform === 'instagram') lines.push('ig_user_id = "ig-test-user"')
    }
  }
  if (opts.extra?.length) lines.push('', ...opts.extra)
  lines.push('')
  return lines.join('\n')
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
 */
export function writeChannelsDir(files: Record<string, string>): string {
  const dir = tmpDir('brainrot-channels-')
  mkdirSync(dir, { recursive: true })
  for (const [filename, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, filename), contents)
  }
  return dir
}
