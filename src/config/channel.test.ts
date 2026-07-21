import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir } from './channel.js'

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
  it('parses channels/example.toml into a ChannelConfig', () => {
    const cfg = loadChannelConfig('channels/example.toml')
    expect(cfg.name).toBe('example')
    expect(cfg.niche).toEqual(['space facts', 'astronomy'])
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
    expect(cfg.tierMix).toEqual({ volume: 2, premium: 1 })
    expect(cfg.voice).toEqual({
      volume: 'af_heart',
      premium: {
        provider: 'elevenlabs',
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        modelId: 'eleven_multilingual_v2',
      },
    })
    expect(cfg.premium).toEqual({
      imageModel: 'fal-ai/flux/dev',
      videoModel: 'fal-ai/kling-video/v3/standard/image-to-video',
      stylePrefix: 'vivid digital illustration, cinematic lighting',
      sceneConcurrency: 3,
    })
    expect(cfg.captionStyle).toEqual({
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    })
    expect(cfg.bgDir).toBe('assets/bg')
    expect(cfg.bgmDir).toBe('assets/bgm')
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      premiumPerVideoUsdMicros: 7_000_000,
      perDayUsdMicros: 20_000_000,
    })
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
    const dir = writeDir({
      'zzz.toml': named('alpha'), // filename order deliberately ≠ channel-name order
      'aaa.toml': named('zeta'),
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

  it('throws when the directory does not exist', () => {
    expect(() => loadChannelsDir('/nope/definitely/missing')).toThrow()
  })
})
