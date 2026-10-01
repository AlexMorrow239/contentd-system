import { describe, expect, it } from 'vitest'
import { testScript } from '../../../../../testing/job.js'
import type { ScriptArtifact } from '../../artifacts/script.js'
import { HOOK_PAUSE_MS, bodyText, narrationText, narrationWordCount } from '../narration-text.js'

describe('narrationText', () => {
  it('keeps the story composition byte-identical (hook + segments, blank-line joined)', () => {
    expect(narrationText(testScript())).toBe('Hook here\n\nOne.\n\nTwo.')
  })

  it('handles a script round-tripped through JSON, as stages read script.json', () => {
    const fromDisk = JSON.parse(JSON.stringify(testScript())) as ScriptArtifact
    expect(narrationText(fromDisk)).toBe('Hook here\n\nOne.\n\nTwo.')
  })
})

describe('narrationWordCount', () => {
  it('counts words across hook and segments', () => {
    // 'Hook here' (2) + 'One.' (1) + 'Two.' (1)
    expect(narrationWordCount(testScript())).toBe(4)
  })
})

describe('bodyText', () => {
  it('joins segment text only, excluding the hook', () => {
    expect(bodyText(testScript())).toBe('One.\n\nTwo.')
  })
})

describe('HOOK_PAUSE_MS', () => {
  it('is a positive, deliberate pause -- not zero or accidental', () => {
    expect(HOOK_PAUSE_MS).toBeGreaterThan(0)
  })
})
