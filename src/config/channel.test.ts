import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SCOUT, loadChannelConfig, loadChannelsDir, parseChannelToml } from './channel.js'
import {
  channelToml,
  channelTomlLines,
  writeChannelsDir as writeChannels,
} from '../testing/channel.js'
import { tmpDir } from '../testing/tmp.js'
import { classify } from '../errors.js'

/**
 * This file's subject IS the TOML text, so it works in line arrays and edits
 * them, rather than taking finished strings from the testkit. `PLAN1_LINES` is
 * the testkit's canonical loadable channel named 'legacy'; every fixture below
 * is that array with lines appended or substituted.
 *
 * NOTE: [budget] is the last table, so a bare key appended to this array lands
 * inside [budget] rather than at top level.
 */
const PLAN1_LINES = channelTomlLines({ name: 'legacy' })

function writeToml(lines: string[]): string {
  const file = join(tmpDir('brainrot-chan-'), 'channel.toml')
  writeFileSync(file, lines.join('\n'))
  return file
}

/** PLAN1_LINES with the channel renamed — the basename must match the name. */
function named(name: string): string[] {
  return PLAN1_LINES.map((l) => (l === 'name = "legacy"' ? `name = "${name}"` : l))
}

describe('loadChannelConfig', () => {
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
      perSourceLimit: 25,
      queueDays: 3,
      generateTopics: 0,
    })
    expect(DEFAULT_SCOUT).toEqual({
      subreddits: [],
      rss: [],
      perSourceLimit: 25,
      queueDays: 3,
      generateTopics: 0,
    })
  })

  it('parses a full [scout] table into camelCase', () => {
    const cfg = loadChannelConfig(
      writeToml([
        ...PLAN1_LINES,
        '[scout]',
        'subreddits = ["space", "askscience"]',
        'rss = ["https://www.sciencedaily.com/rss/space_time.xml"]',
        'per_source_limit = 10',
      ]),
    )
    expect(cfg.scout).toEqual({
      subreddits: ['space', 'askscience'],
      rss: ['https://www.sciencedaily.com/rss/space_time.xml'],
      perSourceLimit: 10,
      queueDays: 3,
      generateTopics: 0,
    })
  })

  it('applies per-field defaults inside a partial [scout] table', () => {
    const cfg = loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'subreddits = ["space"]']))
    expect(cfg.scout).toEqual({
      subreddits: ['space'],
      rss: [],
      perSourceLimit: 25,
      queueDays: 3,
      generateTopics: 0,
    })
  })

  it('rejects out-of-range scout numbers', () => {
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

  it('parses [scout] generate_topics and defaults it to 0', () => {
    const withoutKey = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(withoutKey.scout.generateTopics).toBe(0)
    const withKey = loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'generate_topics = 5']))
    expect(withKey.scout.generateTopics).toBe(5)
  })

  it('rejects a negative or fractional generate_topics', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'generate_topics = -1'])),
    ).toThrow(/generate_topics must be 0 or more/)
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'generate_topics = 1.5'])),
    ).toThrow(/generate_topics must be a whole number/)
  })
})

describe('backlog_days / scout.queue_days', () => {
  it('defaults backlog_days to 2 and scout.queue_days to 3', () => {
    const cfg = loadChannelConfig(writeToml(PLAN1_LINES))
    expect(cfg.backlogDays).toBe(2)
    expect(cfg.scout.queueDays).toBe(3)
  })

  it('reads explicit backlog_days and queue_days', () => {
    const lines = PLAN1_LINES.flatMap((l) =>
      l === 'videos_per_day = 2' ? [l, 'backlog_days = 5'] : [l],
    )
    const cfg = loadChannelConfig(writeToml([...lines, '[scout]', 'queue_days = 7']))
    expect(cfg.backlogDays).toBe(5)
    expect(cfg.scout.queueDays).toBe(7)
  })

  it('rejects a zero or negative backlog_days', () => {
    const lines = PLAN1_LINES.flatMap((l) =>
      l === 'videos_per_day = 2' ? [l, 'backlog_days = 0'] : [l],
    )
    expect(() => loadChannelConfig(writeToml(lines))).toThrow(/backlog_days must be greater than 0/)
  })

  it('rejects a zero or negative queue_days', () => {
    expect(() =>
      loadChannelConfig(writeToml([...PLAN1_LINES, '[scout]', 'queue_days = 0'])),
    ).toThrow(/queue_days must be greater than 0/)
  })
})

describe('loadChannelsDir', () => {
  it('loads every *.toml sorted by channel name, ignoring other files', () => {
    // filename basename must equal the channel name (load-bearing invariant),
    // so name order is filename order — the sort still normalizes readdir order.
    const dir = writeChannels({
      'alpha.toml': named('alpha'),
      'zeta.toml': named('zeta'),
      'notes.txt': ['not a channel'],
    })
    const configs = loadChannelsDir(dir)
    expect(configs.map((c) => c.name)).toEqual(['alpha', 'zeta'])
    expect(configs[0].scout).toEqual(DEFAULT_SCOUT)
  })

  it('returns [] for an empty directory', () => {
    expect(loadChannelsDir(tmpDir('brainrot-chans-'))).toEqual([])
  })

  it('throws naming the unparseable file', () => {
    const dir = writeChannels({
      'good.toml': named('good'),
      'bad.toml': ['name = "broken"', 'niche = "not-an-array"'],
    })
    expect(() => loadChannelsDir(dir)).toThrow(/bad\.toml/)
  })

  it('throws when a file basename does not match its channel name, naming both', () => {
    // The invariant is load-bearing: resumeJob resolves the TOML as
    // <channelsDir>/<job.channel>.toml by filename, and planTick keys on name.
    const dir = writeChannels({ 'wrong-name.toml': named('actual') })
    expect(() => loadChannelsDir(dir)).toThrow(/wrong-name/)
    expect(() => loadChannelsDir(dir)).toThrow(/actual/)
  })

  it('throws when two files declare the same channel name, naming both files', () => {
    const dir = writeChannels({
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

  it('parses a platforms list', () => {
    const config = parseChannelToml(
      channelToml({ name: 'alpha', platforms: ['youtube', 'tiktok'] }),
      'alpha.toml',
    )
    expect(config.platforms).toEqual(['youtube', 'tiktok'])
  })

  it('defaults platforms to an empty list', () => {
    expect(parseChannelToml(channelToml({ name: 'alpha' }), 'alpha.toml').platforms).toEqual([])
  })

  it('rejects an unknown platform', () => {
    expect(() =>
      parseChannelToml(channelToml({ name: 'alpha', platforms: ['myspace'] }), 'alpha.toml'),
    ).toThrow(/myspace/)
  })

  it('rejects a duplicate platform', () => {
    expect(() =>
      parseChannelToml(
        channelToml({ name: 'alpha', platforms: ['youtube', 'youtube'] }),
        'alpha.toml',
      ),
    ).toThrow(/duplicate/i)
  })

  // Same treatment `slots` and `[scout] min_score` already get: the error must
  // name the replacement, or an operator upgrading reads "unrecognized key"
  // and has to go find the commit.
  it('rejects a stale [publish] table, naming the replacement', () => {
    const toml = `${channelToml({ name: 'alpha' })}\n[publish.youtube]\nprivacy_status = "public"\n`
    expect(() => parseChannelToml(toml, 'alpha.toml')).toThrow(/platforms = \[/)
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

describe('loadChannelsDir platform quota validation', () => {
  it('accepts videos_per_day above any platform daily quota (runtime detection owns limits)', () => {
    const dir = writeChannels({
      'chan-a.toml': channelTomlLines({
        name: 'chan-a',
        videosPerDay: 15,
        platforms: ['youtube', 'instagram'],
      }),
    })
    expect(loadChannelsDir(dir)).toHaveLength(1)
  })
})

describe('config error classification', () => {
  it('classifies a channel-name/basename mismatch as config/invalid', () => {
    const dir = writeChannels({ 'wrong-name.toml': named('other') })
    const err = (() => {
      try {
        loadChannelsDir(dir)
        return undefined
      } catch (e: unknown) {
        return e
      }
    })()
    expect(classify(err)).toMatchObject({ domain: 'config', kind: 'invalid' })
  })
})

describe('loadChannelConfig story mode', () => {
  it('parses a [story] table and defaults max_parts to 4', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        extra: ['[scout]', 'subreddits = ["AmItheAsshole"]', '[story]'],
      }),
    )
    const cfg = loadChannelConfig(file)
    expect(cfg.story).toEqual({ maxParts: 4 })
  })

  it('reads an explicit max_parts', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        videosPerDay: 3,
        extra: ['[scout]', 'subreddits = ["AmItheAsshole"]', '[story]', 'max_parts = 6'],
      }),
    )
    expect(loadChannelConfig(file).story).toEqual({ maxParts: 6 })
  })

  it('leaves story null when the table is absent', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'plain.toml')
    writeFileSync(file, channelToml({ name: 'plain' }))
    expect(loadChannelConfig(file).story).toBeNull()
  })

  it('rejects [story] alongside rss sources', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        extra: ['[scout]', 'rss = ["https://example.com/feed.xml"]', '[story]'],
      }),
    )
    expect(() => loadChannelConfig(file)).toThrow(/rss/i)
  })

  it('rejects [story] with generate_topics > 0, naming the reason', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        extra: ['[scout]', 'subreddits = ["AmItheAsshole"]', 'generate_topics = 3', '[story]'],
      }),
    )
    expect(() => loadChannelConfig(file)).toThrow(
      'a [story] channel cannot declare [scout] generate_topics — a generated topic has no post body to narrate',
    )
  })

  it('rejects max_parts exceeding videos_per_day x backlog_days', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        videosPerDay: 1,
        backlogDays: 3,
        extra: ['[scout]', 'subreddits = ["AmItheAsshole"]', '[story]', 'max_parts = 4'],
      }),
    )
    expect(() => loadChannelConfig(file)).toThrow(/max_parts/)
  })

  it('accepts max_parts exactly at the bound', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'aita.toml')
    writeFileSync(
      file,
      channelToml({
        name: 'aita',
        videosPerDay: 1,
        backlogDays: 3,
        extra: ['[scout]', 'subreddits = ["AmItheAsshole"]', '[story]', 'max_parts = 3'],
      }),
    )
    const cfg = loadChannelConfig(file)
    expect(cfg.backlogDays).toBe(3)
    expect(cfg.story).toEqual({ maxParts: 3 })
  })

  it('emits backlog_days at top level, not nested under [budget]', () => {
    const dir = tmpDir('story-config')
    const file = join(dir, 'plain.toml')
    // A top-level key passed via `extra` would land inside the still-open
    // [budget] table and be silently dropped; the dedicated option must not.
    writeFileSync(file, channelToml({ name: 'plain', videosPerDay: 1, backlogDays: 5 }))
    expect(loadChannelConfig(file).backlogDays).toBe(5)
  })
})
