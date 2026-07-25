import { describe, it, expect } from 'vitest';
import { bodyText, HOOK_PAUSE_MS, narrationText, narrationWordCount } from './narration-text.js';
import type { ScriptArtifact } from './script.js';
import { testScript } from './_testkit.js';

describe('narrationText', () => {
  it('keeps the story composition byte-identical (hook + segments, blank-line joined)', () => {
    expect(narrationText(testScript())).toBe('Hook here\n\nOne.\n\nTwo.');
  });

  it('handles a script round-tripped through JSON, as stages read script.json', () => {
    const fromDisk = JSON.parse(JSON.stringify(testScript())) as ScriptArtifact;
    expect(narrationText(fromDisk)).toBe('Hook here\n\nOne.\n\nTwo.');
  });
});

describe('narrationWordCount', () => {
  it('counts words across hook and segments', () => {
    // 'Hook here' (2) + 'One.' (1) + 'Two.' (1)
    expect(narrationWordCount(testScript())).toBe(4);
  });
});

describe('bodyText', () => {
  it('joins segment text only, excluding the hook', () => {
    expect(bodyText(testScript())).toBe('One.\n\nTwo.');
  });
});

describe('HOOK_PAUSE_MS', () => {
  it('is a positive, deliberate pause -- not zero or accidental', () => {
    expect(HOOK_PAUSE_MS).toBeGreaterThan(0);
  });
});
