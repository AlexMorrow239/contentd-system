import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BrainrotError,
  classify,
  errorContext,
  errorMessage,
  isAbortLike,
  tagError,
} from './errors.js'

describe('errors', () => {
  describe('BrainrotError', () => {
    it('carries its domain, kind and derived code', () => {
      const err = new BrainrotError('nope', { domain: 'publish', kind: 'auth' })
      expect(err.domain).toBe('publish')
      expect(err.kind).toBe('auth')
      expect(err.code).toBe('publish/auth')
      expect(err.message).toBe('nope')
      expect(err).toBeInstanceOf(Error)
    })

    it('freezes context and defaults it to an empty object', () => {
      const bare = new BrainrotError('x', { domain: 'job', kind: 'internal' })
      expect(bare.context).toEqual({})
      const withCtx = new BrainrotError('x', {
        domain: 'job',
        kind: 'budget',
        context: { usdMicros: 42 },
      })
      expect(withCtx.context).toEqual({ usdMicros: 42 })
      expect(Object.isFrozen(withCtx.context)).toBe(true)
    })

    it('threads cause through to the native Error.cause', () => {
      const root = new Error('root')
      const err = new BrainrotError('wrapper', {
        domain: 'storage',
        kind: 'transient',
        cause: root,
      })
      expect(err.cause).toBe(root)
    })

    it('leaves cause undefined when none is given', () => {
      const err = new BrainrotError('x', { domain: 'storage', kind: 'transient' })
      expect(err.cause).toBeUndefined()
    })
  })

  describe('errorMessage', () => {
    it('matches the idiom it replaces for every ordinary input', () => {
      expect(errorMessage(new Error('boom'))).toBe('boom')
      expect(errorMessage('boom')).toBe('boom')
      expect(errorMessage(undefined)).toBe('undefined')
      expect(errorMessage(null)).toBe('null')
      expect(errorMessage(42)).toBe('42')
    })

    it('does not throw on a value String() would reject', () => {
      // `String(Object.create(null))` throws TypeError — the old inline
      // ternary would have propagated it out of a catch block.
      expect(errorMessage(Object.create(null))).toBe('[unstringifiable thrown value]')
    })
  })

  describe('classify', () => {
    it('reads a BrainrotError own fields', () => {
      const err = new BrainrotError('nope', {
        domain: 'publish',
        kind: 'quota',
        context: { platform: 'youtube' },
      })
      expect(classify(err)).toEqual({
        domain: 'publish',
        kind: 'quota',
        code: 'publish/quota',
        message: 'nope',
        context: { platform: 'youtube' },
      })
    })

    it('falls back to internal/internal for a plain Error', () => {
      expect(classify(new TypeError('x is not a function'))).toEqual({
        domain: 'internal',
        kind: 'internal',
        code: 'internal/internal',
        message: 'x is not a function',
        context: {},
      })
    })

    it('never throws on a non-Error thrown value', () => {
      for (const thrown of ['boom', undefined, null, 42, {}]) {
        expect(classify(thrown).kind).toBe('internal')
      }
    })

    it('reads a tag off an error this codebase does not own', () => {
      const zodErr = new z.ZodError([])
      tagError(zodErr, {
        domain: 'provider',
        kind: 'invalid',
        context: { costUsdMicros: 3300 },
      })
      const info = classify(zodErr)
      expect(info.domain).toBe('provider')
      expect(info.kind).toBe('invalid')
      expect(info.code).toBe('provider/invalid')
      expect(info.context).toEqual({ costUsdMicros: 3300 })
    })
  })

  describe('tagError', () => {
    it('preserves the tagged error identity', () => {
      // This is the whole reason the tag exists: anthropic.ts must keep
      // throwing a real ZodError so callers still narrow on it.
      const zodErr = new z.ZodError([])
      const returned = tagError(zodErr, { domain: 'provider', kind: 'invalid' })
      expect(returned).toBe(zodErr)
      expect(returned).toBeInstanceOf(z.ZodError)
    })

    it('hides the tag from enumeration and JSON', () => {
      const err = tagError(new Error('x'), { domain: 'scout', kind: 'transient' })
      expect(Object.keys(err)).toEqual([])
      expect(JSON.stringify({ ...err })).toBe('{}')
    })

    it('is a no-op on a non-object without throwing', () => {
      expect(tagError('boom', { domain: 'scout', kind: 'transient' })).toBe('boom')
    })
  })

  describe('errorContext', () => {
    it('reads context from a BrainrotError and from a tag alike', () => {
      const owned = new BrainrotError('x', {
        domain: 'provider',
        kind: 'invalid',
        context: { costUsdMicros: 10 },
      })
      expect(errorContext(owned).costUsdMicros).toBe(10)

      const foreign = tagError(new Error('x'), {
        domain: 'provider',
        kind: 'invalid',
        context: { costUsdMicros: 20 },
      })
      expect(errorContext(foreign).costUsdMicros).toBe(20)
    })

    it('returns an empty object for an untagged throw', () => {
      expect(errorContext(new Error('x'))).toEqual({})
      expect(errorContext(undefined)).toEqual({})
    })
  })

  describe('isAbortLike', () => {
    it('matches the TimeoutError/AbortError names AbortSignal.timeout produces', () => {
      const timeout = new Error('timed out')
      timeout.name = 'TimeoutError'
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      expect(isAbortLike(timeout)).toBe(true)
      expect(isAbortLike(abort)).toBe(true)
      expect(isAbortLike(new Error('other'))).toBe(false)
      expect(isAbortLike('TimeoutError')).toBe(false)
    })
  })
})
