import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SCOUT } from '../src/config/channel.js'
import type { ChannelConfig } from '../src/config/channel.js'
import { tmpDir } from './tmp.js'

/**
 * Channel fixtures, in both shapes tests need: the parsed `ChannelConfig`
 * object, and the on-disk TOML that `loadChannelConfig`/`loadChannelsDir`
 * consume.
 *
 * `testChannel` moved here from daemon/src/stages/_testkit.ts. It was imported by
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
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
    },
    bgDir: ['assets/bg'],
    scriptModel: 'claude-sonnet-5',
    scout: { ...DEFAULT_SCOUT },
    story: null,
    platforms: [],
    ...overrides,
  }
}

export interface ChannelTomlOptions {
  name?: string
  niche?: string[]
  videosPerDay?: number
  scriptModel?: string
  bgDir?: string | string[]
  /** Top-level `backlog_days` override. Omitted, the schema default (2) applies. */
  backlogDays?: number
  /** Emitted as a top-level `platforms = [...]` array. Omitted, the default ([]) applies. */
  platforms?: string[]
  /** Extra lines appended verbatim, for one-off keys not worth a parameter. */
  extra?: string[]
}

/**
 * The TOML text for one channel. Always a *loadable* config — tests that want
 * an invalid one build it from `channelTomlLines()` and edit the array.
 *
 * Ordering is load-bearing, not cosmetic: `bg_dir`/`platforms` are
 * top-level keys, so they must precede every `[section]` header, else TOML
 * nests them under the last-opened table and the values silently vanish.
 * `extra` lines are appended *after* the final `[budget]` header, so any
 * other top-level key routed through `extra` (e.g. a bare `backlog_days = N`)
 * silently nests under `[budget]` instead of landing at top level — the
 * `budget` schema isn't `.strict()`, so the stray key is dropped with no
 * error and the field quietly falls back to its default. That is why
 * `backlog_days` and `platforms` each get their own option below rather than
 * being left to `extra`.
 */
export function channelTomlLines(opts: ChannelTomlOptions = {}): string[] {
  const lines = [
    `name = ${JSON.stringify(opts.name ?? 'example')}`,
    `niche = ${JSON.stringify(opts.niche ?? ['space facts', 'astronomy'])}`,
    `script_model = ${JSON.stringify(opts.scriptModel ?? 'claude-sonnet-5')}`,
    `videos_per_day = ${opts.videosPerDay ?? 2}`,
    // Required by the schema, so defaulted rather than conditional.
    `bg_dir = ${JSON.stringify(opts.bgDir ?? 'assets/bg')}`,
    ...(opts.backlogDays === undefined ? [] : [`backlog_days = ${opts.backlogDays}`]),
    ...(opts.platforms === undefined ? [] : [`platforms = ${JSON.stringify(opts.platforms)}`]),
    '',
    '[voice]',
    'voice_id = "EXAVITQu4vr4xnSDxMaL"',
    '',
    '[budget]',
  ]
  if (opts.extra?.length) lines.push('', ...opts.extra)
  return lines
}

export function channelToml(opts: ChannelTomlOptions = {}): string {
  return channelTomlLines(opts).join('\n') + '\n'
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
