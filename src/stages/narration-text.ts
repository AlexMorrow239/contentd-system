import type { ScriptOutput } from './script.js';

/**
 * Narration text fed to TTS and to caption alignment: the hook followed by each
 * segment's spoken text, joined with blank lines. Shared by the voice and
 * captions stages so both produce byte-identical transcripts.
 */
export function narrationText(script: ScriptOutput): string {
  return [script.hook, ...script.segments.map((s) => s.text)].join('\n\n');
}
