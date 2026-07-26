import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { s3ConfigFromEnv } from './s3.js'

const KEYS = [
  'BRAINROT_S3_ENDPOINT',
  'BRAINROT_S3_BUCKET',
  'BRAINROT_S3_ACCESS_KEY_ID',
  'BRAINROT_S3_SECRET_ACCESS_KEY',
  'BRAINROT_S3_REGION',
  'BRAINROT_S3_PUBLIC_ENDPOINT',
] as const

describe('s3ConfigFromEnv', () => {
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k])
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function setRequired(): void {
    process.env.BRAINROT_S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com'
    process.env.BRAINROT_S3_BUCKET = 'brainrot-videos'
    process.env.BRAINROT_S3_ACCESS_KEY_ID = 'ak'
    process.env.BRAINROT_S3_SECRET_ACCESS_KEY = 'sk'
  }

  it('reads every key from the environment', () => {
    setRequired()
    process.env.BRAINROT_S3_REGION = 'us-east-1'
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
    process.env.BRAINROT_S3_PUBLIC_ENDPOINT = 'http://localhost:9000'
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
    process.env.BRAINROT_S3_BUCKET = '   '
    expect(() => s3ConfigFromEnv()).toThrow(/BRAINROT_S3_BUCKET/)
  })
})
