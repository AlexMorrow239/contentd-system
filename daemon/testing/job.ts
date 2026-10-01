import type { Database } from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import type { ChannelConfig } from '../src/config/channel.js'
import type { ScriptOutput } from '../src/features/production/artifacts/script.js'
import type { JobContext } from '../src/features/production/contracts.js'
import { createJob } from '../src/features/production/jobs/runner.js'
import type { StoryPart } from '../src/shared/stories/types.js'
import { systemTime, type TimeSource } from '../src/shared/time.js'
import { PLATFORM_META, testChannel } from './channel.js'
import { memDb } from './db.js'
import { tmpDir } from './tmp.js'

/**
 * JobContext and stage-artifact fixtures.
 *
 * `makeCtx` and `testScript` moved here from the old daemon/src/stages/_testkit.ts. The old
 * `makeCtx` hardcoded its db, jobId and runDir, which is why qc, visuals-volume
 * and assemble each carried a byte-identical private fork of it — the options
 * bag below is what those three actually needed. It also leaked its runDir on
 * every call; tmpDir() now cleans it up.
 */

/**
 * A schema-valid ScriptOutput. Centralized so a new required field on
 * ScriptOutputSchema means updating one fixture rather than every stage test.
 */
export function testScript(opts: { hook?: string; segments?: string[] } = {}): ScriptOutput {
  return {
    hook: opts.hook ?? 'Hook here',
    segments: (opts.segments ?? ['One.', 'Two.']).map((text, i) => ({
      text,
      visualDirection: `v${i}`,
    })),
    platformMeta: PLATFORM_META,
  }
}

export interface MakeCtxOptions {
  time?: TimeSource
  channel?: ChannelConfig
  topic?: string
  /** Fixed job id, for tests that assert on paths. Default: a real createJob id. */
  jobId?: string
  /** Existing run dir to write artifacts into. Default: a fresh temp dir. */
  runDir?: string
  db?: Database
  /** Story-mode payload, for stage tests that need `ctx.story` set. Default: undefined. */
  story?: StoryPart
}

export function makeCtx(opts: MakeCtxOptions = {}): JobContext {
  const time = opts.time ?? systemTime
  const channel = opts.channel ?? testChannel()
  const topic = opts.topic ?? 'Why the Moon is drifting away'
  const db = opts.db ?? memDb()
  // createJob is skipped when the caller pinned an id: those tests seed
  // artifacts directly and never read the jobs row back.
  const jobId = opts.jobId ?? createJob(db, channel, { topic, time })
  const runDir = opts.runDir ?? tmpDir('brainrot-videos-')
  return {
    jobId,
    time,
    db,
    channel,
    topic,
    story: opts.story,
    runDir,
    artifactPath(stage, file) {
      const dir = path.join(runDir, stage)
      mkdirSync(dir, { recursive: true })
      return path.join(dir, file)
    },
    log: pino({ level: 'silent' }),
  }
}

/** Writes the `voice/voice.json` a later stage reads for narration duration. */
export function seedVoiceJson(ctx: JobContext, durationMs = 1000): void {
  writeFileSync(
    ctx.artifactPath('voice', 'voice.json'),
    JSON.stringify({ provider: 'elevenlabs', voiceId: ctx.channel.voice.voiceId, durationMs }),
  )
}

/** Writes a `captions/words.json` whose last word ends at `durationMs`. */
export function seedWordsJson(ctx: JobContext, durationMs = 1000): void {
  writeFileSync(
    ctx.artifactPath('captions', 'words.json'),
    JSON.stringify({
      words: [
        { word: 'a', startMs: 0, endMs: Math.round(durationMs * 0.3) },
        { word: 'b', startMs: Math.round(durationMs * 0.3), endMs: Math.round(durationMs * 0.65) },
        { word: 'c', startMs: Math.round(durationMs * 0.65), endMs: durationMs },
      ],
    }),
  )
}

/**
 * Writes `script/script.json` verbatim. `script` is deliberately `unknown`:
 * the stage tests that assert on a malformed artifact need to write something
 * `ScriptOutputSchema` rejects, which a `ScriptOutput`-typed writer cannot express.
 */
export function writeScriptJson(ctx: JobContext, script: unknown = testScript()): JobContext {
  writeFileSync(ctx.artifactPath('script', 'script.json'), JSON.stringify(script))
  return ctx
}

/** Writes a `script/script.json` of `sentences` total lines (hook + segments). */
export function seedScriptJson(ctx: JobContext, sentences = 3, text = SENTENCE): void {
  writeScriptJson(
    ctx,
    testScript({ hook: text, segments: Array.from({ length: sentences - 1 }, () => text) }),
  )
}

export const SENTENCE =
  'Venus spins backwards compared to every other planet orbiting our star and nobody really knows why.'
