import { beforeEach, describe, expect, it, vi } from 'vitest'
import { minioConfig } from '../testing/storage.js'
import { errorMessage } from '../errors.js'
import { s3ConfigError, s3ConfigFromEnv } from './config.js'

const KEYS = [
  'BRAINROT_S3_ENDPOINT',
  'BRAINROT_S3_BUCKET',
  'BRAINROT_S3_ACCESS_KEY_ID',
  'BRAINROT_S3_SECRET_ACCESS_KEY',
  'BRAINROT_S3_REGION',
] as const

// Shared by every describe block below: each test starts from a clean slate
// with these keys unset. Restoring is src/testing/setup.ts's global
// vi.unstubAllEnvs() — stubbing to undefined deletes the key and is undone
// there, which is what the hand-rolled save/restore Map used to do.
beforeEach(() => {
  for (const k of KEYS) vi.stubEnv(k, undefined)
})

describe('s3ConfigFromEnv', () => {
  function setRequired(): void {
    vi.stubEnv('BRAINROT_S3_ENDPOINT', 'https://acct.r2.cloudflarestorage.com')
    vi.stubEnv('BRAINROT_S3_BUCKET', 'brainrot-videos')
    vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', 'ak')
    vi.stubEnv('BRAINROT_S3_SECRET_ACCESS_KEY', 'sk')
  }

  it('reads every key from the environment', () => {
    setRequired()
    vi.stubEnv('BRAINROT_S3_REGION', 'us-east-1')
    expect(s3ConfigFromEnv()).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'brainrot-videos',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      region: 'us-east-1',
    })
  })

  it("defaults region to 'auto' for R2", () => {
    setRequired()
    expect(s3ConfigFromEnv().region).toBe('auto')
  })

  // The no-silent-fallback rule (design spec §3.5). A production tick that
  // quietly wrote videos somewhere local and reported success is a worse
  // failure than a crash.
  it('throws naming every missing required key', () => {
    expect(() => s3ConfigFromEnv()).toThrow(/BRAINROT_S3_BUCKET/)
    expect(() => s3ConfigFromEnv()).toThrow(/BRAINROT_S3_ENDPOINT/)
  })

  it('treats an empty string as unset', () => {
    setRequired()
    vi.stubEnv('BRAINROT_S3_BUCKET', '   ')
    expect(() => s3ConfigFromEnv()).toThrow(/BRAINROT_S3_BUCKET/)
  })
})

// The fail-fast half of the no-silent-fallback rule: storage being required
// is only defensible if the produce path refuses BEFORE the render, not after
// it (the store stage runs last). s3ConfigError is how the tick asks.
describe('s3ConfigError', () => {
  it('returns undefined when every required key is set', () => {
    vi.stubEnv('BRAINROT_S3_ENDPOINT', 'https://acct.r2.cloudflarestorage.com')
    vi.stubEnv('BRAINROT_S3_BUCKET', 'brainrot-videos')
    vi.stubEnv('BRAINROT_S3_ACCESS_KEY_ID', 'ak')
    vi.stubEnv('BRAINROT_S3_SECRET_ACCESS_KEY', 'sk')
    expect(s3ConfigError()).toBeUndefined()
  })

  // Same message as the throw, so the operator sees one wording whether the
  // failure surfaced from a tick's JSON line or from a stage's exception.
  it('names every missing key without throwing', () => {
    const message = s3ConfigError()
    expect(message).toMatch(/BRAINROT_S3_ENDPOINT/)
    expect(message).toMatch(/BRAINROT_S3_BUCKET/)
    expect(message).toMatch(/BRAINROT_S3_ACCESS_KEY_ID/)
    expect(message).toMatch(/BRAINROT_S3_SECRET_ACCESS_KEY/)
    let thrown = ''
    try {
      s3ConfigFromEnv()
    } catch (err) {
      thrown = errorMessage(err)
    }
    expect(message).toBe(thrown)
  })
})

describe('minioConfig', () => {
  it('does not inherit production storage settings', () => {
    for (const key of KEYS) vi.stubEnv(key, 'production-value')
    for (const key of ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
      vi.stubEnv(`TEST_S3_${key}`, undefined)
    }
    expect(minioConfig()).toEqual({
      endpoint: 'http://localhost:9100',
      bucket: 'brainrot-tests',
      accessKeyId: 'brainrotdev',
      secretAccessKey: 'brainrotdev',
      region: 'auto',
    })
  })

  it('accepts dedicated storage test overrides', () => {
    vi.stubEnv('TEST_S3_ENDPOINT', 'http://localhost:19100')
    vi.stubEnv('TEST_S3_BUCKET', 'isolated-tests')
    vi.stubEnv('TEST_S3_ACCESS_KEY_ID', 'test-key')
    vi.stubEnv('TEST_S3_SECRET_ACCESS_KEY', 'test-secret')
    expect(minioConfig()).toEqual({
      endpoint: 'http://localhost:19100',
      bucket: 'isolated-tests',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      region: 'auto',
    })
  })
})
