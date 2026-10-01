import { promises as fs } from 'node:fs'
import { parseWavDurationMs } from '../../../infra/media/wav.js'
import { estimateTtsCostMicros, synthWithTimestamps } from '../../../infra/providers/elevenlabs.js'
import { ContentdError } from '../../../shared/errors.js'
import { assertBudget, recordCost } from '../../billing/costs.js'
import type { ScriptArtifact } from '../artifacts/script.js'
import { VoiceMeta } from '../artifacts/voice.js'
import type { JobContext, StageDef } from '../contracts.js'
import { checkpoint } from '../ownership.js'
import {
  HOOK_PAUSE_MS,
  MAX_PLAUSIBLE_WORDS_PER_SEC,
  bodyText,
  countWords,
  minPlausibleNarrationMs,
  narrationText,
} from './narration-text.js'

// Send hook and body together, with a deliberate pause understood by ElevenLabs.
const HOOK_BREAK_TAG = `<break time="${HOOK_PAUSE_MS}ms" />`
// Do not let echoed SSML markup become visible captions.
const BREAK_TAG_FRAGMENT = /^<\/?break\b|^time\s*=|^\/?>$/i

export const voiceStage: StageDef = {
  name: 'voice',
  async run(ctx: JobContext): Promise<void> {
    checkpoint(ctx)
    const script = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptArtifact
    const wavPath = ctx.artifactPath('voice', 'narration.wav')
    const timingsPath = ctx.artifactPath('voice', 'timings.json')

    // Remove stale timings before synthesis; only validated audio earns new timings.
    checkpoint(ctx)
    await fs.rm(timingsPath, { force: true })
    const elevenText = `${script.hook} ${HOOK_BREAK_TAG}\n\n${bodyText(script)}`
    assertBudget(ctx.db, ctx.channel, estimateTtsCostMicros(elevenText), ctx.time)
    checkpoint(ctx)
    // Missing credentials and provider failures propagate. There is no alternate TTS.
    const synth = await synthWithTimestamps({
      signal: ctx.signal,
      time: ctx.time,
      voiceId: ctx.channel.voice.voiceId,
      modelId: ctx.channel.voice.modelId,
      text: elevenText,
    })

    // Delivered audio is billed, including when ownership was lost during the call
    // or a subsequent local write/validation fails.
    recordCost(ctx.db, ctx.jobId, 'elevenlabs', 'tts', synth.costUsdMicros, ctx.attemptId, ctx.time)
    checkpoint(ctx)
    await fs.writeFile(wavPath, synth.wavBytes)
    const durationMs = parseWavDurationMs(synth.wavBytes)
    const words = countWords(narrationText(script))
    const minPlausibleMs = minPlausibleNarrationMs(words)
    if (durationMs < minPlausibleMs) {
      throw new ContentdError(
        `voice synthesis produced implausibly short audio: ${durationMs}ms for ${words} words ` +
          `(minimum ${minPlausibleMs}ms at ${MAX_PLAUSIBLE_WORDS_PER_SEC} words/sec); ` +
          'narration was likely truncated by provider "elevenlabs"',
        { domain: 'provider', kind: 'invalid' },
      )
    }

    checkpoint(ctx)
    await fs.writeFile(
      timingsPath,
      JSON.stringify(
        { words: synth.words.filter((w) => !BREAK_TAG_FRAGMENT.test(w.word)) },
        null,
        2,
      ),
    )
    const meta: VoiceMeta = {
      provider: 'elevenlabs',
      voiceId: ctx.channel.voice.voiceId,
      durationMs,
    }
    checkpoint(ctx)
    await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2))
  },
}
