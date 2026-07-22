import { describe, expect, it } from 'vitest'
import { PUBLISH_PLATFORMS, PublishError } from './types.js'
import type { PublishErrorKind } from './types.js'

describe('PUBLISH_PLATFORMS', () => {
  it('is exactly youtube for v1', () => {
    expect(PUBLISH_PLATFORMS).toEqual(['youtube'])
  })
})

describe('PublishError', () => {
  it('carries its kind alongside the standard Error message', () => {
    const err = new PublishError('mintAccessToken: refresh rejected', 'auth')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('mintAccessToken: refresh rejected')
    expect(err.kind).toBe('auth')
  })

  it.each<PublishErrorKind>(['auth', 'quota', 'rejected', 'transient'])(
    'accepts kind %s',
    (kind) => {
      const err = new PublishError('boom', kind)
      expect(err.kind).toBe(kind)
    },
  )
})
