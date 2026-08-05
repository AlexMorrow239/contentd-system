import { promises as fs } from 'node:fs'
import type { StageDef, JobContext } from '../jobs/types.js'
import type { ScriptArtifact } from './script.js'
import { narrationText } from './narration-text.js'
import { alignTranscript, type WordTiming } from '../providers/whisperx.js'
import { BrainrotError } from '../errors.js'

export interface CaptionsArtifact {
  words: WordTiming[]
}

// Dual mode: provider-supplied word timings (voice/timings.json, written only
// by a successful ElevenLabs premium synth) win over the WhisperX sidecar — a
// premium run whose synth succeeded has no sidecar dependency. Volume runs and
// premium runs that fell back to kokoro/edge-tts have no timings.json (the
// voice stage guarantees that) and take the WhisperX path unchanged.
export const captionsStage: StageDef = {
  name: 'captions',
  async run(ctx: JobContext): Promise<void> {
    const words = (await providerWords(ctx)) ?? (await alignedWords(ctx))
    const artifact: CaptionsArtifact = { words }
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

  const words = await alignTranscript({
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
