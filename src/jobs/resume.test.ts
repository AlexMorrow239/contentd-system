import { describe, expect, it } from 'vitest'
import { assertPremiumPreflight as cliPreflight, stagesForTier as cliStages } from '../cli.js'
import { assertPremiumPreflight, stagesForTier } from './pipeline.js'

describe('jobs/pipeline', () => {
  it('cli.ts re-exports the moved helpers with identical identity', () => {
    // Re-export, not copy: the loop code and the CLI must share ONE wiring.
    expect(cliStages).toBe(stagesForTier)
    expect(cliPreflight).toBe(assertPremiumPreflight)
    // The move is verbatim: the six-stage produce order is unchanged.
    expect(stagesForTier('volume').map((s) => s.name)).toEqual([
      'script',
      'voice',
      'captions',
      'visuals',
      'assemble',
      'qc',
    ])
  })
})
