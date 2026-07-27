import { beforeEach, describe, expect, it, vi } from 'vitest'
import { s3ConfigError, s3ConfigFromEnv } from './config.js'

const KEYS = [
  'BRAINROT_S3_ENDPOINT',
  'BRAINROT_S3_BUCKET',
  'BRAINROT_S3_ACCESS_KEY_ID',
  'BRAINROT_S3_SECRET_ACCESS_KEY',
  'BRAINROT_S3_REGION',
  'BRAINROT_S3_PUBLIC_ENDPOINT',
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
      publicEndpoint: undefined,
    })
  })

  it("defaults region to 'auto' for R2", () => {
    setRequired()
    expect(s3ConfigFromEnv().region).toBe('auto')
  })

  it('carries publicEndpoint through when set', () => {
    setRequired()
    vi.stubEnv('BRAINROT_S3_PUBLIC_ENDPOINT', 'http://localhost:9000')
    expect(s3ConfigFromEnv().publicEndpoint).toBe('http://localhost:9000')
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
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(message).toBe(thrown)
  })
})
