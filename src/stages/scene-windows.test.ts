import { describe, it, expect } from 'vitest';
import { computeSceneWindows } from './scene-windows.js';
import type { SceneWindowsResult } from './scene-windows.js';
import type { ScenesOutput } from './script.js';
import type { WordTiming } from '../providers/whisperx.js';

const PLATFORM_META = {
  youtube: { title: 't', description: 'd', hashtags: [] },
  tiktok: { title: 't', description: 'd', hashtags: [] },
  instagram: { title: 't', description: 'd', hashtags: [] },
};

/** Schema-valid ScenesOutput; only hook and scenes[].narration matter here. */
function makeScenes(hook: string, narrations: string[]): ScenesOutput {
  return {
    format: 'scenes',
    hook,
    styleBlock: 'Muted watercolor, soft dawn light, consistent pastel palette.',
    scenes: narrations.map((narration, i) => ({
      narration,
      visualPrompt: `visual ${i}`,
      motionPrompt: `motion ${i}`,
    })),
    platformMeta: PLATFORM_META,
  };
}

/** One WordTiming per whitespace token: word i starts at i*300ms, 250ms spoken. */
function timeline(text: string): WordTiming[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({ word, startMs: i * 300, endMs: i * 300 + 250 }));
}

/**
 * Contract invariants that must hold for EVERY result: one window per scene,
 * integer ms, window 0 starts at 0, contiguous (end k === start k+1), last end
 * === totalDurationMs, no negative-length windows.
 */
function assertTiling(result: SceneWindowsResult, sceneCount: number, totalDurationMs: number): void {
  expect(result.windows).toHaveLength(sceneCount);
  if (sceneCount === 0) return;
  expect(result.windows[0].startMs).toBe(0);
  expect(result.windows[sceneCount - 1].endMs).toBe(totalDurationMs);
  for (const w of result.windows) {
    expect(Number.isInteger(w.startMs)).toBe(true);
    expect(Number.isInteger(w.endMs)).toBe(true);
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  }
  for (let k = 0; k + 1 < result.windows.length; k++) {
    expect(result.windows[k].endMs).toBe(result.windows[k + 1].startMs);
  }
}

describe('computeSceneWindows — proportional', () => {
  it('empty words[] → proportional split by word count, hook weighting scene 1', () => {
    const script = makeScenes('One two', ['a b c', 'd e', 'f']);
    const result = computeSceneWindows(script, [], 8000);
    expect(result.method).toBe('proportional');
    // weights: scene1 = 2 hook + 3 = 5, scene2 = 2, scene3 = 1 (of 8) over 8000ms
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 7000 },
      { startMs: 7000, endMs: 8000 },
    ]);
    assertTiling(result, 3, 8000);
  });

  it('rounding never breaks the tiling: 3 equal scenes over 1000ms', () => {
    const script = makeScenes('', ['a', 'b', 'c']);
    const result = computeSceneWindows(script, [], 1000);
    expect(result.method).toBe('proportional');
    // cumulative-then-round: boundaries at round(1000/3)=333 and round(2000/3)=667;
    // the last window absorbs the remainder so the sum is exactly 1000.
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 333 },
      { startMs: 333, endMs: 667 },
      { startMs: 667, endMs: 1000 },
    ]);
    assertTiling(result, 3, 1000);
  });

  it('all-punctuation narration (zero total weight) splits evenly, never throws', () => {
    const script = makeScenes('—', ['...', '!!!']);
    const result = computeSceneWindows(script, [], 1000);
    expect(result.method).toBe('proportional');
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 500, endMs: 1000 },
    ]);
    assertTiling(result, 2, 1000);
  });

  it('single scene spans the whole narration', () => {
    const script = makeScenes('Hi', ['Just one scene here.']);
    const result = computeSceneWindows(script, [], 2000);
    expect(result.method).toBe('proportional');
    expect(result.windows).toEqual([{ startMs: 0, endMs: 2000 }]);
    assertTiling(result, 1, 2000);
  });

  it('zero scenes yields zero windows without throwing', () => {
    const script = makeScenes('Hi', []);
    const result = computeSceneWindows(script, timeline('Hi'), 1000);
    expect(result.windows).toEqual([]);
    assertTiling(result, 0, 1000);
  });
});

describe('computeSceneWindows — aligned', () => {
  it('anchors each scene at the start of its first word; scene 1 covers the hook', () => {
    const script = makeScenes('Space is weird', [
      'The moon drifts away.',
      'Every single year.',
      'Nobody can stop it.',
    ]);
    const words = timeline(
      'Space is weird The moon drifts away Every single year Nobody can stop it',
    );
    const result = computeSceneWindows(script, words, 4500);
    expect(result.method).toBe('aligned');
    // 'Every' is word 7 (startMs 2100), 'Nobody' is word 10 (startMs 3000)
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 2100 },
      { startMs: 2100, endMs: 3000 },
      { startMs: 3000, endMs: 4500 },
    ]);
    assertTiling(result, 3, 4500);
  });

  it('normalizes punctuation and case on both sides; standalone punctuation is skipped', () => {
    const script = makeScenes("Don't panic!", [
      "It's fine — really.",
      '"Ninety percent" is empty...',
    ]);
    const words = timeline("Don't panic It's fine really Ninety percent is empty");
    const result = computeSceneWindows(script, words, 2700);
    expect(result.method).toBe('aligned');
    // the narration's standalone '—' has no aligner counterpart and is skipped;
    // 'Ninety' is word 5 → startMs 1500
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 1500 },
      { startMs: 1500, endMs: 2700 },
    ]);
    assertTiling(result, 2, 2700);
  });

  it('a word duplicated across a boundary anchors on the SECOND occurrence', () => {
    const script = makeScenes('Look up', ['You see the moon.', 'Moon dust is deadly.']);
    const words = timeline('Look up You see the moon Moon dust is deadly');
    const result = computeSceneWindows(script, words, 3300);
    expect(result.method).toBe('aligned');
    // scene 2's 'Moon' is word 6 (startMs 1800) — NOT scene 1's 'moon' at 1500.
    // A naive indexOf search would anchor at 1500; the sequential pointer walk
    // must consume scene 1's 'moon' first.
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 1800 },
      { startMs: 1800, endMs: 3300 },
    ]);
    assertTiling(result, 2, 3300);
  });

  it('single scene with a matching timeline is aligned and spans everything', () => {
    const script = makeScenes('Hi', ['Just one scene here.']);
    const result = computeSceneWindows(script, timeline('Hi Just one scene here'), 2000);
    expect(result.method).toBe('aligned');
    expect(result.windows).toEqual([{ startMs: 0, endMs: 2000 }]);
    assertTiling(result, 1, 2000);
  });
});

describe('computeSceneWindows — alignment tolerance', () => {
  it('stays aligned when the aligner dropped a mid-scene word', () => {
    const script = makeScenes('Space is weird', ['The moon drifts away.', 'Every single year.']);
    const words = timeline('Space is weird The moon away Every single year'); // 'drifts' dropped
    const result = computeSceneWindows(script, words, 3000);
    expect(result.method).toBe('aligned');
    // 'Every' is word 6 → startMs 1800
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 1800 },
      { startMs: 1800, endMs: 3000 },
    ]);
    assertTiling(result, 2, 3000);
  });

  it('skips an inserted spurious word and anchors the boundary on the real word', () => {
    const script = makeScenes('Space is weird', ['The moon drifts away.', 'Every single year.']);
    const words = timeline('Space is weird The moon drifts away uh Every single year'); // 'uh' inserted
    const result = computeSceneWindows(script, words, 3300);
    expect(result.method).toBe('aligned');
    // 'Every' is word 8 → startMs 2400; the walk skipped 'uh'
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 2400 },
      { startMs: 2400, endMs: 3300 },
    ]);
    assertTiling(result, 2, 3300);
  });

  it("falls back to proportional when a scene's first token cannot be matched", () => {
    const script = makeScenes('Hi there', ['Alpha beta gamma.', 'Delta epsilon zeta.']);
    const words = timeline('Hi there alpha beta gamma deltoid epsilon zeta'); // boundary word garbled
    const result = computeSceneWindows(script, words, 8000);
    expect(result.method).toBe('proportional');
    // weights: scene1 = 2 hook + 3 = 5 (of 8) → boundary at 5000
    expect(result.windows).toEqual([
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 8000 },
    ]);
    assertTiling(result, 2, 8000);
  });
});
