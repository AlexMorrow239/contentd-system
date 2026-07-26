import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir } from './channel.js'
import { testChannel } from '../stages/_testkit.js'

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

// Baseline [publish] table reused by several tests below.
const PUBLISH_YOUTUBE_ONLY = [
  '[publish]',
  'slots = ["10:00", "14:00", "19:00"]',
  '',
  '[publish.youtube]',
  'privacy = "private"',
  'category_id = 24',
  'made_for_kids = false',
  '',
]

describe('[publish] — per-platform targets', () => {
  it('is null when [publish] is absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.publish).toBeNull()
  })

  it('parses a single youtube target using the shared slots', () => {
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, ...PUBLISH_YOUTUBE_ONLY]))
    expect(cfg.publish?.targets).toEqual([
      {
        platform: 'youtube',
        slots: ['10:00', '14:00', '19:00'],
        options: { privacy: 'private', categoryId: 24, madeForKids: false },
      },
    ])
  })

  it('parses youtube and instagram targets together, sorted by platform', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        'slots = ["10:00", "14:00"]',
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

  it('lets a platform override the shared slots', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        'slots = ["10:00"]',
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        'slots = ["11:00", "18:00"]',
        '',
      ]),
    )
    expect(cfg.publish?.targets[0]).toEqual({
      platform: 'instagram',
      slots: ['11:00', '18:00'],
      options: { igUserId: '1', shareToFeed: true },
    })
  })

  it('defaults instagram share_to_feed to true', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        'slots = ["10:00"]',
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        '',
      ]),
    )
    expect(cfg.publish?.targets[0]).toMatchObject({ options: { shareToFeed: true } })
  })

  it('throws when [publish] declares no platform sub-table', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]', ''])),
    ).toThrow(/at least one platform sub-table/)
  })

  it('throws when a platform has no slots and [publish] has no shared slots', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish.youtube]', 'privacy = "public"', ''])),
    ).toThrow(/no slots/)
  })

  it('throws on the removed legacy platforms array', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          'slots = ["10:00"]',
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
      loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]', '', '[publish.tiktok]', '']),
      ),
    ).toThrow()
  })

  it('throws on an unknown key inside a platform sub-table', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          'slots = ["10:00"]',
          '',
          '[publish.instagram]',
          'ig_user_id = "1"',
          'category_id = 24',
          '',
        ]),
      ),
    ).toThrow()
  })

  it('throws on duplicate slots within one platform override', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([
          ...PLAN1_LINES,
          '[publish]',
          'slots = ["10:00"]',
          '',
          '[publish.youtube]',
          'slots = ["10:00", "10:00"]',
          '',
        ]),
      ),
    ).toThrow(/duplicates/)
  })

  // Regression (M2): [publish] freezing used to stop at the outer `publish`
  // object and `publish.targets` array — pre-per-platform-rewrite, this test
  // also asserted `cfg.publish.slots`/`cfg.publish.platforms` were frozen.
  // The per-platform rewrite (Task 5) moved slots/options onto each target,
  // and only the outer two layers stayed frozen — each target object, its
  // slots array, and its options object were silently mutable, e.g.
  // `cfg.publish.targets[0].slots.push(...)` succeeded. Assert every layer.
  it('deep-freezes publish, targets, and each target — object, slots, and options', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        'slots = ["10:00", "14:00"]',
        '',
        '[publish.instagram]',
        'ig_user_id = "1"',
        '',
        '[publish.youtube]',
        'privacy = "public"',
        '',
      ]),
    )
    expect(Object.isFrozen(cfg.publish)).toBe(true)
    const targets = cfg.publish?.targets ?? []
    expect(Object.isFrozen(targets)).toBe(true)
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      expect(Object.isFrozen(target)).toBe(true)
      expect(Object.isFrozen(target.slots)).toBe(true)
      expect(Object.isFrozen(target.options)).toBe(true)
    }
    const [first] = targets
    expect(() => first.slots.push('23:00')).toThrow(TypeError)
    const options = first.options as unknown as Record<string, unknown>
    expect(() => {
      options.someKey = 'x'
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
            slots: ['10:00'],
            options: { privacy: 'public', categoryId: 24, madeForKids: false },
          },
        ],
      },
    })
    expect(withPublish.publish).toEqual({
      targets: [
        {
          platform: 'youtube',
          slots: ['10:00'],
          options: { privacy: 'public', categoryId: 24, madeForKids: false },
        },
      ],
    })
  })
})
