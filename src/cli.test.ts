import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDevFlag,
  DEV_VOICE_ENV,
  parsePublishDays,
  parseTopicIds,
  pipelineStages,
  resolveChannelsDir,
  resolveRunsRoot,
} from './cli.js'
import { visualsVolumeStage } from './stages/visuals-volume.js'

/**
 * The CLI's pure, in-process surface: argument parsers, path resolvers and the
 * stage list. No subprocess, no db, no filesystem.
 *
 * The subprocess tests that used to share this file now live in
 * cli.<subcommand>.test.ts. That separation is why these describes no longer
 * need the "(in-process)" suffix they used to carry to distinguish themselves.
 */

describe('path resolvers', () => {
  // These mirror resolveDbPath's flag > env > default precedence. They are
  // exported (not just exercised through a subprocess) because the dev/prod
  // split depends on the env tier existing at all — a literal commander
  // default would silently shadow it.
  it('resolveChannelsDir prefers the flag over the env var', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', 'channels-dev')
    expect(resolveChannelsDir('channels')).toBe('channels')
  })

  it('resolveChannelsDir falls back to the env var when no flag is passed', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', 'channels-dev')
    expect(resolveChannelsDir(undefined)).toBe('channels-dev')
  })

  it('resolveChannelsDir defaults to channels when neither is set', () => {
    vi.stubEnv('BRAINROT_CHANNELS_DIR', undefined)
    expect(resolveChannelsDir(undefined)).toBe('channels')
  })

  it('resolveRunsRoot prefers the flag over the env var', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', 'runs-dev')
    expect(resolveRunsRoot('runs')).toBe('runs')
  })

  it('resolveRunsRoot falls back to the env var when no flag is passed', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', 'runs-dev')
    expect(resolveRunsRoot(undefined)).toBe('runs-dev')
  })

  it('resolveRunsRoot defaults to runs when neither is set', () => {
    vi.stubEnv('BRAINROT_RUNS_ROOT', undefined)
    expect(resolveRunsRoot(undefined)).toBe('runs')
  })
})

describe('pipelineStages', () => {
  it('returns the fixed stage list', () => {
    const stages = pipelineStages()
    const order = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc', 'store']
    expect(stages.map((s) => s.name)).toEqual(order)
    expect(stages[3]).toBe(visualsVolumeStage)
  })
})

describe('parseTopicIds', () => {
  it('parses positive integer tokens in order', () => {
    expect(parseTopicIds(['12', '3', '400'])).toEqual([12, 3, 400])
    // commander's <ids...> guarantees at least one token, but the helper
    // itself is total: an empty list is an empty result, not an error.
    expect(parseTopicIds([])).toEqual([])
  })

  it('throws naming the first bad token; "12abc", "0", "-3" all reject', () => {
    expect(() => parseTopicIds(['12abc'])).toThrow(
      'invalid topic id "12abc": ids must be positive integers',
    )
    expect(() => parseTopicIds(['0'])).toThrow('invalid topic id "0"')
    expect(() => parseTopicIds(['-3'])).toThrow('invalid topic id "-3"')
    // the FIRST offender is the one named, even when later tokens are also bad
    expect(() => parseTopicIds(['5', '0', '-3'])).toThrow('invalid topic id "0"')
  })
})

describe('parsePublishDays', () => {
  it('parses a positive integer string', () => {
    expect(parsePublishDays('7')).toBe(7)
    expect(parsePublishDays('1')).toBe(1)
    expect(parsePublishDays('30')).toBe(30)
  })

  it('throws naming the value; "0", "-3", "3.5", "abc" all reject', () => {
    expect(() => parsePublishDays('0')).toThrow('invalid --days "0": must be a positive integer')
    expect(() => parsePublishDays('-3')).toThrow('invalid --days "-3"')
    expect(() => parsePublishDays('3.5')).toThrow('invalid --days "3.5"')
    expect(() => parsePublishDays('abc')).toThrow('invalid --days "abc"')
  })
})

describe('applyDevFlag', () => {
  // applyDevFlag writes process.env directly, so the assertions have to read
  // it directly too. Stubbing the key to undefined first both clears it and
  // registers it with vitest, so setup.ts's global vi.unstubAllEnvs() reverts
  // whatever applyDevFlag wrote.
  beforeEach(() => {
    vi.stubEnv(DEV_VOICE_ENV, undefined)
  })

  it('sets BRAINROT_DEV_VOICE=1 when dev is true', () => {
    applyDevFlag(true)
    expect(process.env[DEV_VOICE_ENV]).toBe('1')
  })

  it('leaves BRAINROT_DEV_VOICE untouched when dev is falsy', () => {
    applyDevFlag(undefined)
    expect(process.env[DEV_VOICE_ENV]).toBeUndefined()
    applyDevFlag(false)
    expect(process.env[DEV_VOICE_ENV]).toBeUndefined()
  })
})
