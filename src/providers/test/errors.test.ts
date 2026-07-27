import { describe, it, expect } from 'vitest'
import { errorCostUsdMicros } from '../errors.js'
import { tagError } from '../../errors.js'

describe('errorCostUsdMicros', () => {
  it('reads cost from a tagError-attached context', () => {
    const err = tagError(new Error('paid then failed'), {
      domain: 'provider',
      kind: 'invalid',
      context: { costUsdMicros: 42 },
    })
    expect(errorCostUsdMicros(err)).toBe(42)
  })

  it('reads cost from a legacy own-property, for a foreign error with no tag', () => {
    const err = Object.assign(new Error('legacy shape'), { costUsdMicros: 42 })
    expect(errorCostUsdMicros(err)).toBe(42)
  })

  it('rejects a non-finite legacy own-property', () => {
    const err = Object.assign(new Error('bad legacy shape'), { costUsdMicros: Infinity })
    expect(errorCostUsdMicros(err)).toBeUndefined()
  })

  it('returns undefined when no cost is present anywhere', () => {
    expect(errorCostUsdMicros(new Error('no cost here'))).toBeUndefined()
  })
})
