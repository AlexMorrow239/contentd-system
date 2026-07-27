import { describe, expect, it } from 'vitest'
import { BrainrotError, classify } from '../errors.js'
import { StorageError } from './types.js'

describe('StorageError', () => {
  it('is a BrainrotError in the storage domain carrying its kind', () => {
    const err = new StorageError('gone', 'not-found')
    expect(err).toBeInstanceOf(BrainrotError)
    expect(err).toBeInstanceOf(StorageError)
    expect(err.name).toBe('StorageError')
    expect(err.kind).toBe('not-found')
    expect(classify(err)).toMatchObject({
      domain: 'storage',
      kind: 'not-found',
      code: 'storage/not-found',
      message: 'gone',
    })
  })

  it('classifies its other two kinds', () => {
    expect(classify(new StorageError('x', 'auth')).code).toBe('storage/auth')
    expect(classify(new StorageError('x', 'transient')).code).toBe('storage/transient')
  })
})
