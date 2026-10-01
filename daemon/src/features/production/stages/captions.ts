import { promises as fs } from 'node:fs'
import { alignTranscript } from '../../../infra/providers/whisperx.js'
import { type WordTiming } from '../../../shared/contracts/word-timing.js'
import { BrainrotError } from '../../../shared/errors.js'
import { CaptionsArtifact } from '../artifacts/captions.js'
import type { ScriptArtifact } from '../artifacts/script.js'
import type { JobContext, StageDef } from '../contracts.js'
import { checkpoint } from '../ownership.js'
import { narrationText } from './narration-text.js'

// ElevenLabs word timings take precedence. WhisperX can still align historical
// audio or a successful synthesis whose provider alignment was absent/invalid.
// It never synthesizes replacement audio after a voice failure.
export const captionsStage: StageDef = {
  name: 'captions',
  async run(ctx: JobContext): Promise<void> {
    checkpoint(ctx)
    const words = (await providerWords(ctx)) ?? (await alignedWords(ctx))
    const artifact: CaptionsArtifact = { words }
    checkpoint(ctx)
    await fs.writeFile(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify(artifact, null, 2),
    )
  },
}

/** Provider-supplied timings, or `undefined` when this run has none to trust. */
async function providerWords(ctx: JobContext): Promise<WordTiming[] | undefined> {
  const timingsRaw = await fs
    .readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8')
    .catch(() => undefined) // absent file -> WhisperX path
  if (timingsRaw === undefined) return undefined
  // Deliberately NOT try/caught: an unparseable timings.json is a corrupt
  // voice artifact and should fail the stage loudly, not silently realign.
  const timings = JSON.parse(timingsRaw) as Partial<CaptionsArtifact>
  return Array.isArray(timings.words) && timings.words.length > 0 ? timings.words : undefined
}

async function alignedWords(ctx: JobContext): Promise<WordTiming[]> {
  const script = JSON.parse(
    await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
  ) as ScriptArtifact

  checkpoint(ctx)
  const words = await alignTranscript({
    signal: ctx.signal,
    time: ctx.time,
    baseUrl: process.env.WHISPERX_URL ?? 'http://localhost:8585',
    wavPath: ctx.artifactPath('voice', 'narration.wav'),
    transcript: narrationText(script),
  })
  if (words.length === 0) {
    throw new BrainrotError('captions: whisperx returned no word timings', {
      domain: 'provider',
      kind: 'invalid',
    })
  }
  return words
}
