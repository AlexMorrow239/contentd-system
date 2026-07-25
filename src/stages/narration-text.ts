import type { ScriptArtifact } from './script.js';

/**
 * Narration text fed to TTS and to caption alignment: the hook followed by the
 * spoken text of each segment. Shared by the voice and captions stages so both
 * produce byte-identical transcripts.
 */
export function narrationText(script: ScriptArtifact): string {
  return [script.hook, ...script.segments.map((s) => s.text)].join('\n\n');
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function narrationWordCount(script: ScriptArtifact): number {
  return countWords(narrationText(script));
}

// Natural narration runs 2.5-3 words/sec. 5 w/s is a generous ceiling that no real
// synthesis exceeds, so falling under it means audio was lost.
export const MAX_PLAUSIBLE_WORDS_PER_SEC = 5;

/**
 * Shortest narration duration that is plausible for `words` of speech. The voice
 * stage rejects synthesis below this floor and the qc gate re-checks the finished
 * artifacts against it; both derive the rule here so they cannot drift apart.
 */
export function minPlausibleNarrationMs(words: number): number {
  return Math.round(words * (1000 / MAX_PLAUSIBLE_WORDS_PER_SEC));
}
