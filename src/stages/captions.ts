import { promises as fs } from 'node:fs';
import type { StageDef, JobContext } from '../jobs/types.js';
import type { ScriptOutput } from './script.js';
import { narrationText } from './narration-text.js';
import { alignTranscript, type WordTiming } from '../providers/whisperx.js';

export interface CaptionsArtifact {
  words: WordTiming[];
}

// Plan 1: captions always come from the WhisperX sidecar. Plan 2 adds a dual
// mode that prefers provider-supplied word timings (ElevenLabs) when present.
export const captionsStage: StageDef = {
  name: 'captions',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8')) as ScriptOutput;
    const transcript = narrationText(script);

    const words = await alignTranscript({
      baseUrl: process.env.WHISPERX_URL ?? 'http://localhost:8585',
      wavPath: ctx.artifactPath('voice', 'narration.wav'),
      transcript,
    });
    if (words.length === 0) throw new Error('captions: whisperx returned no word timings');

    const artifact: CaptionsArtifact = { words };
    await fs.writeFile(ctx.artifactPath('captions', 'words.json'), JSON.stringify(artifact, null, 2));
  },
};
