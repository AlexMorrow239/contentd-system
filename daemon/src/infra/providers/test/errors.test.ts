import { describe, expect, it } from 'vitest'
import { tagError } from '../../../shared/errors.js'
import { errorCostUsdMicros } from '../errors.js'

describe('errorCostUsdMicros', () => {
  it('reads cost from a tagError-attached context', () => {
    const err = tagError(new Error('paid then failed'), {
      domain: 'provider',
      kind: 'invalid',
      context: { costUsdMicros: 42 },
    })
    expect(errorCostUsdMicros(err)).toBe(42)
  })

  it('rejects a non-finite tagged cost', () => {
    const err = tagError(new Error('bad shape'), {
      domain: 'provider',
      kind: 'invalid',
      context: { costUsdMicros: Infinity },
    })
    expect(errorCostUsdMicros(err)).toBeUndefined()
  })

  it('returns undefined when no cost is present anywhere', () => {
    expect(errorCostUsdMicros(new Error('no cost here'))).toBeUndefined()
  })
})
