import { describe, expect, it } from 'vitest'
import { PUBLISH_PLATFORMS } from '../../types.js'
import { ADAPTERS } from '../index.js'

describe('ADAPTERS', () => {
  it('has a factory for every declared platform, each producing a matching platformId', () => {
    for (const platform of PUBLISH_PLATFORMS) {
      expect(ADAPTERS[platform]).toBeDefined()
      expect(ADAPTERS[platform]().platformId).toBe(platform)
    }
  })
})
