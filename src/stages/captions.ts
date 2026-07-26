import { promises as fs } from 'node:fs'
import type { StageDef, JobContext } from '../jobs/types.js'
import type { ScriptArtifact } from './script.js'
import { narrationText } from './narration-text.js'
import { alignTranscript, type WordTiming } from '../providers/whisperx.js'

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
    const timingsRaw = await fs
      .readFile(ctx.artifactPath('voice', 'timings.json'), 'utf8')
      .catch(() => undefined) // absent file -> WhisperX path
    if (timingsRaw !== undefined) {
      // Deliberately NOT try/caught: an unparseable timings.json is a corrupt
      // voice artifact and should fail the stage loudly, not silently realign.
      const timings = JSON.parse(timingsRaw) as Partial<CaptionsArtifact>
      if (Array.isArray(timings.words) && timings.words.length > 0) {
        const artifact: CaptionsArtifact = { words: timings.words }
        await fs.writeFile(
          ctx.artifactPath('captions', 'words.json'),
          JSON.stringify(artifact, null, 2),
        )
        return
      }
    }

    const script = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptArtifact
    const transcript = narrationText(script)

    const words = await alignTranscript({
      baseUrl: process.env.WHISPERX_URL ?? 'http://localhost:8585',
      wavPath: ctx.artifactPath('voice', 'narration.wav'),
      transcript,
    })
    if (words.length === 0) throw new Error('captions: whisperx returned no word timings')

    const artifact: CaptionsArtifact = { words }
    await fs.writeFile(
      ctx.artifactPath('captions', 'words.json'),
      JSON.stringify(artifact, null, 2),
    )
  },
}
