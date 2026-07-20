import { describe, it, expect } from 'vitest';
import { narrationText, narrationWordCount } from './narration-text.js';
import type { ScenesOutput, ScriptArtifact } from './script.js';
import { testScript } from './_testkit.js';

function scenesArtifact(): ScenesOutput {
  return {
    format: 'scenes',
    hook: 'Hook here',
    styleBlock: 'Warm palette, watercolor medium, calm mood, golden-hour light.',
    scenes: [
      { narration: 'First scene line.', visualPrompt: 'v1', motionPrompt: 'm1' },
      { narration: 'Second scene line.', visualPrompt: 'v2', motionPrompt: 'm2' },
    ],
    platformMeta: {
      youtube: { title: 't', description: 'd', hashtags: [] },
      tiktok: { title: 't', description: 'd', hashtags: [] },
      instagram: { title: 't', description: 'd', hashtags: [] },
    },
  };
}

describe('narrationText', () => {
  it('joins hook + scene narrations with single spaces for scenes artifacts', () => {
    // EXACT composition contract: scene-windows (Task 12) re-derives scene
    // boundaries from hook-then-narrations joined with single spaces.
    expect(narrationText(scenesArtifact())).toBe('Hook here First scene line. Second scene line.');
  });

  it('keeps the story composition byte-identical (hook + segments, blank-line joined)', () => {
    expect(narrationText(testScript())).toBe('Hook here\n\nOne.\n\nTwo.');
  });

  it('handles a scenes artifact round-tripped through JSON, as stages read script.json', () => {
    const fromDisk = JSON.parse(JSON.stringify(scenesArtifact())) as ScriptArtifact;
    expect(narrationText(fromDisk)).toBe('Hook here First scene line. Second scene line.');
  });
});

describe('narrationWordCount', () => {
  it('counts words across hook and scene narrations', () => {
    // 'Hook here' (2) + 'First scene line.' (3) + 'Second scene line.' (3)
    expect(narrationWordCount(scenesArtifact())).toBe(8);
  });
});
