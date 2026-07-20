import type { WordTiming } from '../providers/whisperx.js';
import type { ScenesOutput } from './script.js';

export interface SceneWindow {
  startMs: number;
  endMs: number;
}

export interface SceneWindowsResult {
  windows: SceneWindow[];
  method: 'aligned' | 'proportional';
}

/**
 * Lowercase and strip every non-alphanumeric character: "Don't," → 'dont'.
 * A token that normalizes to nothing (pure punctuation like '—') is dropped by
 * tokenize(), matching aligner output, which never emits standalone punctuation.
 */
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 0);
}

/**
 * Turn per-scene start boundaries into windows that tile [0, totalDurationMs]
 * exactly: clamp each start into [previous start, totalDurationMs] so the
 * invariant holds even against a pathological word timeline, force the first
 * start to 0 (scene 1 covers the hook), and let the last window absorb the
 * remainder.
 */
function tile(rawStarts: number[], totalDurationMs: number): SceneWindow[] {
  const starts: number[] = [];
  let prev = 0;
  for (const raw of rawStarts) {
    const clamped = Math.min(Math.max(Math.round(raw), prev), totalDurationMs);
    starts.push(clamped);
    prev = clamped;
  }
  if (starts.length > 0) starts[0] = 0;
  return starts.map((startMs, k) => ({
    startMs,
    endMs: k + 1 < starts.length ? starts[k + 1] : totalDurationMs,
  }));
}

/**
 * Split [0, totalDurationMs] proportionally to per-scene token counts. Hook
 * words are spoken inside scene 1's window, so they weight the first scene.
 * Boundaries accumulate exact fractions and round once each, so rounding error
 * never compounds across scenes.
 */
function proportionalStarts(
  hookTokens: string[],
  sceneTokens: string[][],
  totalDurationMs: number,
): number[] {
  let weights = sceneTokens.map((tokens, k) =>
    k === 0 ? hookTokens.length + tokens.length : tokens.length,
  );
  let totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) {
    // Every narration normalized to nothing (pure punctuation). Split evenly
    // rather than divide by zero — this module must never throw.
    weights = weights.map(() => 1);
    totalWeight = weights.length;
  }
  const starts: number[] = [];
  let cumulative = 0;
  for (const weight of weights) {
    starts.push(Math.round((cumulative / totalWeight) * totalDurationMs));
    cumulative += weight;
  }
  return starts;
}

// The aligner (WhisperX or grouped ElevenLabs timings) sometimes inserts or
// splits words. When hunting for the next expected token we look at most this
// many actual words past the pointer before treating the expected token as
// dropped. Small on purpose: an unbounded search could leap across scenes and
// anchor a boundary at a coincidental later occurrence of the same word.
const MAX_SKIP_AHEAD = 2;

/**
 * Walk the expected token sequence (hook, then each scene's narration — the
 * same composition narrationText() speaks) against the aligner's word
 * timeline. Returns per-scene start boundaries (scene k's boundary = startMs
 * of the word matched to its first token), or null when a scene's first token
 * cannot be anchored — the caller then falls back to proportional allocation.
 */
function tryAlignedStarts(
  hookTokens: string[],
  sceneTokens: string[][],
  words: WordTiming[],
): number[] | null {
  // A scene whose narration normalized to nothing has no first token to
  // anchor a boundary on; alignment cannot place it.
  if (sceneTokens.some((tokens) => tokens.length === 0)) return null;

  const actual = words
    .map((w) => ({ token: normalizeToken(w.word), startMs: w.startMs }))
    .filter((w) => w.token.length > 0);

  interface ExpectedToken {
    token: string;
    sceneIndex: number | null; // set on each scene's FIRST token only
  }
  const expected: ExpectedToken[] = hookTokens.map((token) => ({ token, sceneIndex: null }));
  sceneTokens.forEach((tokens, k) => {
    tokens.forEach((token, i) => expected.push({ token, sceneIndex: i === 0 ? k : null }));
  });

  const starts = new Array<number>(sceneTokens.length).fill(0);
  let p = 0;
  for (const e of expected) {
    // Hunt for the expected token at the pointer, skipping up to
    // MAX_SKIP_AHEAD non-matching actual words.
    let matchedAt = -1;
    for (let j = 0; j <= MAX_SKIP_AHEAD && p + j < actual.length; j++) {
      if (actual[p + j].token === e.token) {
        matchedAt = p + j;
        break;
      }
    }
    if (matchedAt === -1) {
      // Not found. A scene's first token must anchor a boundary — give up and
      // let the caller fall back to proportional. Any other token was likely
      // dropped or merged by the aligner: move on without consuming actual
      // words, so the pointer still sits on the next real word.
      if (e.sceneIndex !== null) return null;
      continue;
    }
    if (e.sceneIndex !== null) starts[e.sceneIndex] = actual[matchedAt].startMs;
    p = matchedAt + 1;
  }
  starts[0] = 0; // scene 1 covers the hook from t=0
  return starts;
}

/**
 * Compute one time window per scene over the narration span. Pure and
 * deterministic; never throws. windows.length === script.scenes.length and the
 * windows tile [0, totalDurationMs] exactly (window k's end === window k+1's
 * start). Scene 1's window always starts at 0 so it covers the spoken hook.
 */
export function computeSceneWindows(
  script: ScenesOutput,
  words: WordTiming[],
  totalDurationMs: number,
): SceneWindowsResult {
  const hookTokens = tokenize(script.hook);
  const sceneTokens = script.scenes.map((scene) => tokenize(scene.narration));
  if (sceneTokens.length === 0) return { windows: [], method: 'proportional' };

  const alignedStarts = tryAlignedStarts(hookTokens, sceneTokens, words);
  if (alignedStarts !== null) {
    return { windows: tile(alignedStarts, totalDurationMs), method: 'aligned' };
  }
  return {
    windows: tile(proportionalStarts(hookTokens, sceneTokens, totalDurationMs), totalDurationMs),
    method: 'proportional',
  };
}
