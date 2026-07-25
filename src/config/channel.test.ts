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

// Exactly the Plan-1-era channels/example.toml shape: no [voice.premium], no
// [premium], no premium_per_video_usd. Parsing this unchanged is the backward-
// compatibility contract. NOTE: [budget] is the last table, so a bare key
// appended to this array lands inside [budget].
const PLAN1_LINES = [
  'name = "legacy"',
  'niche = ["space facts", "astronomy"]',
  'script_model = "claude-sonnet-5"',
  'bg_dir = "assets/bg"',
  'bgm_dir = "assets/bgm"',
  '',
  '[tier_mix]',
  'volume = 2',
  'premium = 1',
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

  it('parses a Plan-1-era TOML: voice.premium undefined, premium defaults applied', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.voice.premium).toBeUndefined()
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      sceneConcurrency: 3,
    })
    expect(cfg.premium.stylePrefix).toBeUndefined()
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000, // default 7.0 USD
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

  it('applies per-field defaults inside a partial [premium] table', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[premium]', 'scene_concurrency = 5', 'style_prefix = "watercolor"']),
    )
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      stylePrefix: 'watercolor',
      sceneConcurrency: 5,
    })
  })

  it('converts an explicit premium_per_video_usd to micros', () => {
    // appended bare key lands in [budget] (last table in PLAN1_LINES)
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, 'premium_per_video_usd = 3.5']))
    expect(cfg.budget.premiumPerVideoUsdMicros).toBe(3_500_000)
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
    // premium_per_video_usd is absent from PLAN1_LINES; a bare appended key
    // lands in [budget], the last table.
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, 'premium_per_video_usd = 0'])),
    ).toThrow(/premium_per_video_usd must be greater than 0/)
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
      autoPremium: false,
    })
    expect(DEFAULT_SCOUT).toEqual({
      subreddits: [],
      rss: [],
      minScore: 60,
      perSourceLimit: 25,
      autoPremium: false,
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
        'auto_premium = true',
      ]),
    )
    expect(cfg.scout).toEqual({
      subreddits: ['space', 'askscience'],
      rss: ['https://www.sciencedaily.com/rss/space_time.xml'],
      minScore: 75,
      perSourceLimit: 10,
      autoPremium: true,
    })
  })

  it('applies per-field defaults inside a partial [scout] table', () => {
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'subreddits = ["space"]']))
    expect(cfg.scout).toEqual({
      subreddits: ['space'],
      rss: [],
      minScore: 60,
      perSourceLimit: 25,
      autoPremium: false,
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

describe('[publish] config', () => {
  it('defaults publish to null when the [publish] table is absent', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.publish).toBeNull()
  })

  it('parses a full [publish] table into camelCase', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[publish]',
        'slots = ["10:00", "14:00", "19:00"]',
        'platforms = ["youtube"]',
        'privacy = "unlisted"',
        'category_id = 22',
        'made_for_kids = true',
      ]),
    )
    expect(cfg.publish).toEqual({
      slots: ['10:00', '14:00', '19:00'],
      platforms: ['youtube'],
      privacy: 'unlisted',
      categoryId: 22,
      madeForKids: true,
    })
  })

  it('sorts slots ascending regardless of TOML order', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[publish]', 'slots = ["19:00", "10:00", "14:00"]']),
    )
    expect(cfg.publish?.slots).toEqual(['10:00', '14:00', '19:00'])
  })

  it('applies platforms/privacy/category_id/made_for_kids defaults when only slots is given', () => {
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]']))
    expect(cfg.publish).toEqual({
      slots: ['10:00'],
      platforms: ['youtube'],
      privacy: 'public',
      categoryId: 24,
      madeForKids: false,
    })
  })
})

describe('[publish] validation', () => {
  it('rejects a slot that is not zero-padded 24h HH:MM', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["9:00"]'])),
    ).toThrow()
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["24:00"]'])),
    ).toThrow()
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:60"]'])),
    ).toThrow()
  })

  it('rejects duplicate slots', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00", "10:00"]'])),
    ).toThrow()
  })

  it('rejects an empty slots array', () => {
    expect(() => loadChannelConfig(writeToml([...PLAN1_LINES, '[publish]', 'slots = []']))).toThrow()
  })

  it('rejects a platform outside PUBLISH_PLATFORMS', () => {
    expect(() =>
      loadChannelConfig(
        writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00"]', 'platforms = ["tiktok"]']),
      ),
    ).toThrow()
  })
})

describe('[publish] freezing', () => {
  it('freezes the publish object and its arrays', () => {
    const cfg = loadChannelConfig(
      writeToml([...PLAN1_LINES, '[publish]', 'slots = ["10:00", "14:00"]']),
    )
    expect(Object.isFrozen(cfg.publish)).toBe(true)
    expect(Object.isFrozen(cfg.publish?.slots)).toBe(true)
    expect(Object.isFrozen(cfg.publish?.platforms)).toBe(true)
  })
})

describe('testChannel() publish default', () => {
  it('defaults publish to null and allows overriding it', () => {
    expect(testChannel().publish).toBeNull()
    const withPublish = testChannel({
      publish: { slots: ['10:00'], platforms: ['youtube'], privacy: 'public', categoryId: 24, madeForKids: false },
    })
    expect(withPublish.publish).toEqual({
      slots: ['10:00'],
      platforms: ['youtube'],
      privacy: 'public',
      categoryId: 24,
      madeForKids: false,
    })
  })
})
