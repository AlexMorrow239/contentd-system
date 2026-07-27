import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir, tryLoadChannelsDir } from './channel.js'
import { testChannel } from '../testing/channel.js'
import type { Platform } from '../publish/types.js'

function writeToml(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'chan-'))
  const file = join(dir, 'channel.toml')
  writeFileSync(file, lines.join('\n'))
  return file
}

// Baseline channel TOML shape: no [voice.premium]. NOTE: [budget] is the last
// table, so a bare key appended to this array lands inside [budget].
const PLAN1_LINES = [
  'name = "legacy"',
  'niche = ["space facts", "astronomy"]',
  'script_model = "claude-sonnet-5"',
  'bg_dir = "assets/bg"',
  'bgm_dir = "assets/bgm"',
  'videos_per_day = 2',
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
  '',
]

describe('loadChannelConfig', () => {
  // The live files under channels/ are the operator's real configs and change
  // freely; this only guards that whatever is checked in stays loadable, never
  // pinning content (content contracts are covered by the fixtures below).
  it('every checked-in channels/*.toml loads', () => {
    expect(() => loadChannelsDir('channels')).not.toThrow()
  })

  // channels-dev/ is gitignored (BRAINROT_CHANNELS_DIR's default), so nothing
  // in CI ever loads it and it can silently drift out of sync with the
  // ChannelConfig schema. Skips gracefully where the directory doesn't exist
  // (e.g. CI); a developer who has it locally gets a loud failure instead.
  it('loads channels-dev/ when present locally', () => {
    if (!existsSync('channels-dev')) return
    expect(() => loadChannelsDir('channels-dev')).not.toThrow()
  })

  it('parses a baseline TOML: voice.premium undefined, budget in micros', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.voice.premium).toBeUndefined()
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      perDayUsdMicros: 20_000_000,
    })
  })

  it('defaults [voice.premium] model to eleven_multilingual_v2 when omitted', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[voice.premium]',
        'provider = "elevenlabs"',
        'voice_id = "EXAVITQu4vr4xnSDxMaL"',
      ]),
    )
    expect(cfg.voice.premium).toEqual({
      provider: 'elevenlabs',
      voiceId: 'EXAVITQu4vr4xnSDxMaL',
      modelId: 'eleven_multilingual_v2',
    })
  })

  it('defaults scriptModel to claude-sonnet-5 when script_model is absent', () => {
    const cfg = loadChannelConfig(
      writeToml(PLAN1_LINES.filter((l) => l !== 'script_model = "claude-sonnet-5"')),
    )
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
  })

  it('throws when a required field is missing', () => {
    // strip the entire [budget] table
    const idx = PLAN1_LINES.indexOf('[budget]')
    expect(() => loadChannelConfig(writeToml(PLAN1_LINES.slice(0, idx)))).toThrow()
  })

  it('throws when the file does not exist', () => {
    expect(() => loadChannelConfig('channels/does-not-exist.toml')).toThrow()
  })

  it('defaults [voice] dev to false when absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.voice.dev).toBe(false)
  })

  it('parses [voice] dev = true', () => {
    const lines = PLAN1_LINES.flatMap((l) =>
      l === 'volume = "af_heart"' ? [l, 'dev = true'] : [l],
    )
    const cfg = loadChannelConfig(writeToml(lines))
    expect(cfg.voice.dev).toBe(true)
  })

  it('normalizes a single-string bg_dir into a one-element array', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.bgDir).toEqual(['assets/bg'])
  })

  it('parses an array bg_dir as-is', () => {
    const lines = PLAN1_LINES.map((l) =>
      l === 'bg_dir = "assets/bg"'
        ? 'bg_dir = ["assets/bg/minecraft-parkour", "assets/bg/subway-surfers"]'
        : l,
    )
    const cfg = loadChannelConfig(writeToml(lines))
    expect(cfg.bgDir).toEqual(['assets/bg/minecraft-parkour', 'assets/bg/subway-surfers'])
  })

  // A zero cap is never a real intent, and it read as one: plan-tick's resume
  // floor became 0, `0 < 0` is false, and the job livelocked instead of being
  // parked. Rejecting it at config load is the loud failure it deserves.
  it('rejects a zero or negative budget cap, naming the field', () => {
    const withBudget = (line: string): string[] =>
      PLAN1_LINES.map((l) => (l.startsWith(line.split(' ')[0] + ' ') ? line : l))
    expect(() => loadChannelConfig(writeToml(withBudget('per_video_usd = 0')))).toThrow(
      /per_video_usd must be greater than 0/,
    )
    expect(() => loadChannelConfig(writeToml(withBudget('per_day_usd = 0')))).toThrow(
      /per_day_usd must be greater than 0/,
    )
    expect(() => loadChannelConfig(writeToml(withBudget('per_video_usd = -1')))).toThrow(
      /per_video_usd must be greater than 0/,
    )
  })
})

describe('[scout] config', () => {
  it('applies DEFAULT_SCOUT whole when the [scout] table is absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.scout).toEqual({
      subreddits: [],
      rss: [],
      minScore: 60,
      perSourceLimit: 25,
    })
    expect(DEFAULT_SCOUT).toEqual({
      subreddits: [],
      rss: [],
      minScore: 60,
      perSourceLimit: 25,
    })
  })

  it('parses a full [scout] table into camelCase', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[scout]',
        'subreddits = ["space", "askscience"]',
        'rss = ["https://www.sciencedaily.com/rss/space_time.xml"]',
        'min_score = 75',
        'per_source_limit = 10',
      ]),
    )
    expect(cfg.scout).toEqual({
      subreddits: ['space', 'askscience'],
      rss: ['https://www.sciencedaily.com/rss/space_time.xml'],
      minScore: 75,
      perSourceLimit: 10,
    })
  })

  it('applies per-field defaults inside a partial [scout] table', () => {
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'subreddits = ["space"]']))
    expect(cfg.scout).toEqual({
      subreddits: ['space'],
      rss: [],
      minScore: 60,
      perSourceLimit: 25,
    })
  })

  it('rejects out-of-range scout numbers', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'min_score = 101'])),
    ).toThrow()
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'min_score = -1'])),
    ).toThrow()
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'per_source_limit = 0'])),
    ).toThrow()
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'per_source_limit = 101'])),
    ).toThrow()
  })

  it('gives each config its own scout array instances, and keeps DEFAULT_SCOUT frozen', () => {
    const config1 = loadChannelConfig(writeToml(PLAN1_LINES))
    const config2 = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(config1.scout.subreddits).not.toBe(config2.scout.subreddits)
    expect(config1.scout.rss).not.toBe(config2.scout.rss)
    expect(Object.isFrozen(DEFAULT_SCOUT)).toBe(true)
  })
})

describe('loadChannelsDir', () => {
  function writeDir(files: Record<string, string[]>): string {
    const dir = mkdtempSync(join(tmpdir(), 'chans-'))
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.join('\n'))
    }
    return dir
  }

  function named(name: string): string[] {
    return PLAN1_LINES.map((l) => (l === 'name = "legacy"' ? `name = "${name}"` : l))
  }

  it('loads every *.toml sorted by channel name, ignoring other files', () => {
    // filename basename must equal the channel name (load-bearing invariant),
    // so name order is filename order — the sort still normalizes readdir order.
    const dir = writeDir({
      'alpha.toml': named('alpha'),
      'zeta.toml': named('zeta'),
      'notes.txt': ['not a channel'],
    })
    const configs = loadChannelsDir(dir)
    expect(configs.map((c) => c.name)).toEqual(['alpha', 'zeta'])
    expect(configs[0].scout).toEqual(DEFAULT_SCOUT)
  })

  it('returns [] for an empty directory', () => {
    expect(loadChannelsDir(mkdtempSync(join(tmpdir(), 'chans-')))).toEqual([])
  })

  it('throws naming the unparseable file', () => {
    const dir = writeDir({
      'good.toml': named('good'),
      'bad.toml': ['name = "broken"', 'niche = "not-an-array"'],
    })
    expect(() => loadChannelsDir(dir)).toThrow(/bad\.toml/)
  })

  it('throws when a file basename does not match its channel name, naming both', () => {
    // The invariant is load-bearing: resumeJob resolves the TOML as
    // <channelsDir>/<job.channel>.toml by filename, and planTick keys on name.
    const dir = writeDir({ 'wrong-name.toml': named('actual') })
    expect(() => loadChannelsDir(dir)).toThrow(/wrong-name/)
    expect(() => loadChannelsDir(dir)).toThrow(/actual/)
  })

  it('throws when two files declare the same channel name, naming both files', () => {
    const dir = writeDir({
      'dup-a.toml': named('shared'),
      'dup-b.toml': named('shared'),
    })
    expect(() => loadChannelsDir(dir)).toThrow(/duplicate channel name/)
    expect(() => loadChannelsDir(dir)).toThrow(/dup-a\.toml/)
    expect(() => loadChannelsDir(dir)).toThrow(/dup-b\.toml/)
  })

  it('throws when the directory does not exist', () => {
    expect(() => loadChannelsDir('/nope/definitely/missing')).toThrow()
  })
})

describe('[publish] — per-platform targets', () => {
  it('is null when [publish] is absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.publish).toBeNull()
  })

  it('parses a single youtube target with no slots field anywhere', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[publish]', '', '[publish.youtube]', 'privacy = "private"', '']),
    )
    expect(cfg.publish?.targets).toEqual([
      { platform: 'youtube', options: expect.objectContaining({ privacy: 'private' }) },
    ])
  })

  it('rejects a stale shared slots key with a message naming the replacement', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]', '', '[publish.youtube]', '']),
      ),
    ).toThrow(/slots were removed; daily volume now comes from videos_per_day/)
  })

  it('rejects a stale per-platform slots key with the same message', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', '', '[publish.youtube]', 'slots = ["10:00"]', '']),
      ),
    ).toThrow(/slots were removed; daily volume now comes from videos_per_day/)
  })

  it('still requires at least one platform sub-table', () => {
    expect(() => loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', '']))).toThrow(
      /must declare at least one platform sub-table/,
    )
  })

  it('parses youtube and instagram targets together, sorted by platform', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        '',
        '[publish.instagram]',
        'ig_user_id = "17841400000000000"',
        '',
        '[publish.youtube]',
        'privacy = "public"',
        '',
      ]),
    )
    expect(cfg.publish?.targets.map((t) => t.platform)).toEqual(['instagram', 'youtube'])
  })

  it('defaults instagram share_to_feed to true', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[publish]', '', '[publish.instagram]', 'ig_user_id = "1"', '']),
    )
    expect(cfg.publish?.targets[0]).toMatchObject({ options: { shareToFeed: true } })
  })

  it('throws on the removed legacy platforms array', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          'platforms = ["youtube"]',
          '',
          '[publish.youtube]',
          '',
        ]),
      ),
    ).toThrow()
  })

  it('throws on an unknown platform sub-table', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', '', '[publish.tiktok]', ''])),
    ).toThrow()
  })

  it('throws on an unknown key inside a platform sub-table', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          '',
          '[publish.instagram]',
          'ig_user_id = "1"',
          'category_id = 24',
          '',
        ]),
      ),
    ).toThrow()
  })

  // Regression (M2): [publish] freezing used to stop at the outer `publish`
  // object and `publish.targets` array — each target object and its options
  // object were silently mutable, e.g.
  // `cfg.publish.targets[0].options.privacy = ...` succeeded. Assert every
  // layer.
  it('deep-freezes publish, targets, each target, and its options', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[publish]', '', '[publish.youtube]', '']),
    )
    const publish = cfg.publish!
    expect(Object.isFrozen(publish)).toBe(true)
    expect(Object.isFrozen(publish.targets)).toBe(true)
    const first = publish.targets[0]
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.options)).toBe(true)
    // The regression itself: mutation used to succeed SILENTLY (no throw, the
    // write simply had no effect under sloppy freezing) rather than being
    // rejected outright. Strict mode (this file is ESM, always strict) turns
    // an assignment to a frozen object's property into a thrown TypeError, so
    // asserting the throw is what actually guards against silent mutation.
    expect(() => {
      ;(first.options as unknown as Record<string, unknown>).someKey = 'x'
    }).toThrow(TypeError)
  })
})

describe('testChannel() publish default', () => {
  it('defaults publish to null and allows overriding it', () => {
    expect(testChannel().publish).toBeNull()
    const withPublish = testChannel({
      publish: {
        targets: [
          {
            platform: 'youtube',
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    expect(withPublish.publish).toEqual({
      targets: [
        {
          platform: 'youtube',
          options: { privacy: 'public', categoryId: 24, madeForKids: false },
        },
      ],
    })
  })
})

function withVideosPerDay(value: string): string[] {
  return PLAN1_LINES.map((l) => (l.startsWith('videos_per_day') ? `videos_per_day = ${value}` : l))
}

describe('videos_per_day validation', () => {
  it('rejects a fractional videos_per_day', () => {
    expect(() => loadChannelConfig(writeToml(withVideosPerDay('1.5')))).toThrow(/videos_per_day/)
  })

  it('rejects zero', () => {
    expect(() => loadChannelConfig(writeToml(withVideosPerDay('0')))).toThrow(/videos_per_day/)
  })

  it('rejects a negative count', () => {
    expect(() => loadChannelConfig(writeToml(withVideosPerDay('-1')))).toThrow(/videos_per_day/)
  })
})

// Fixture helpers for the quota-validation suite below. writeDir() inside the
// loadChannelsDir describe block above is scoped to that callback, so this is
// a second, top-level helper of the same shape (Record<string, string[]>)
// rather than a duplicate.
// Same cleanup pattern as src/loop/publish-next.test.ts and
// src/db/migrate.test.ts: record every temp dir and remove it after the test,
// so a full run does not leave one tmpdir per case behind.
const cleanupDirs: string[] = []
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function writeChannelsDir(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'chans-quota-'))
  cleanupDirs.push(dir)
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.join('\n'))
  }
  return dir
}

function channelToml(opts: {
  name: string
  videosPerDay: number
  platforms: Platform[]
}): string[] {
  const lines = [
    `name = "${opts.name}"`,
    'niche = ["space"]',
    'bg_dir = "assets/bg"',
    'bgm_dir = "assets/bgm"',
    `videos_per_day = ${opts.videosPerDay}`,
    '[voice]',
    'volume = "af_heart"',
    '[caption_style]',
    'font = "Inter"',
    'font_size_px = 72',
    'active_color = "#FFD700"',
    'inactive_color = "#FFFFFF"',
    'stroke_px = 8',
    '[budget]',
    'per_video_usd = 0.5',
    'per_day_usd = 10.0',
  ]
  if (opts.platforms.length > 0) {
    lines.push('[publish]')
    for (const p of opts.platforms) {
      lines.push(`[publish.${p}]`)
      // instagramOptionsSchema requires ig_user_id; youtube has no required fields.
      if (p === 'instagram') lines.push('ig_user_id = "ig-quota-test"')
    }
  }
  return lines
}

describe('loadChannelsDir platform quota validation', () => {
  afterEach(() => {
    delete process.env.BRAINROT_IG_UPLOADS_PER_DAY
  })

  it('rejects a global-scope quota over-subscribed across channels', () => {
    // youtube is scope 'global', cap 6 by default: 4 + 3 = 7.
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 4, platforms: ['youtube'] }),
      'chan-b.toml': channelToml({ name: 'chan-b', videosPerDay: 3, platforms: ['youtube'] }),
    })
    expect(() => loadChannelsDir(dir)).toThrow(
      /chan-a\(4\) \+ chan-b\(3\) declare 7 youtube videos\/day, exceeding youtube's 6\/day cap/,
    )
  })

  it('accepts a global-scope total exactly at the cap', () => {
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 3, platforms: ['youtube'] }),
      'chan-b.toml': channelToml({ name: 'chan-b', videosPerDay: 3, platforms: ['youtube'] }),
    })
    expect(loadChannelsDir(dir)).toHaveLength(2)
  })

  it('ignores channels that do not declare the platform when summing a global quota', () => {
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 6, platforms: ['youtube'] }),
      'chan-b.toml': channelToml({ name: 'chan-b', videosPerDay: 6, platforms: ['instagram'] }),
    })
    expect(loadChannelsDir(dir)).toHaveLength(2)
  })

  it('ignores channels with no [publish] table at all', () => {
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 6, platforms: ['youtube'] }),
      'chan-b.toml': channelToml({ name: 'chan-b', videosPerDay: 6, platforms: [] }),
    })
    expect(loadChannelsDir(dir)).toHaveLength(2)
  })

  it('rejects a channel-scope quota exceeded by one channel alone', () => {
    process.env.BRAINROT_IG_UPLOADS_PER_DAY = '2'
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 3, platforms: ['instagram'] }),
    })
    expect(() => loadChannelsDir(dir)).toThrow(
      /chan-a declares 3 instagram videos\/day, exceeding instagram's 2\/day per-channel cap/,
    )
  })

  it('does not sum a channel-scope quota across channels', () => {
    process.env.BRAINROT_IG_UPLOADS_PER_DAY = '3'
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 3, platforms: ['instagram'] }),
      'chan-b.toml': channelToml({ name: 'chan-b', videosPerDay: 3, platforms: ['instagram'] }),
    })
    expect(loadChannelsDir(dir)).toHaveLength(2)
  })

  it('surfaces a quota breach through tryLoadChannelsDir as an error string, not a throw', () => {
    const dir = writeChannelsDir({
      'chan-a.toml': channelToml({ name: 'chan-a', videosPerDay: 7, platforms: ['youtube'] }),
    })
    const loaded = tryLoadChannelsDir(dir)
    expect(loaded.channels).toEqual([])
    expect(loaded.error).toMatch(/exceeding youtube's 6\/day cap/)
  })
})
