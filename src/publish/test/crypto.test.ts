import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken, parseTokenKey } from '../crypto.js'

const VALID_KEY_HEX = '0123456789abcdef'.repeat(4)

describe('parseTokenKey', () => {
  it('rejects undefined', () => {
    expect(() => parseTokenKey(undefined)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('rejects hex shorter than 64 characters', () => {
    expect(() => parseTokenKey('ab'.repeat(10))).toThrow(
      'BRAINROT_TOKEN_KEY must be 64 hex characters',
    )
  })

  it('rejects a 64-character string containing a non-hex digit', () => {
    const notHex = `g${'0'.repeat(63)}`
    expect(() => parseTokenKey(notHex)).toThrow('BRAINROT_TOKEN_KEY must be 64 hex characters')
  })

  it('accepts a valid 64-char hex string and returns a 32-byte Buffer', () => {
    const key = parseTokenKey(VALID_KEY_HEX)
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
    expect(key.toString('hex')).toBe(VALID_KEY_HEX)
  })
})

describe('encryptToken / decryptToken', () => {
  const key = parseTokenKey(VALID_KEY_HEX)

  it('round-trips a plaintext through encrypt then decrypt', () => {
    const blob = encryptToken('rt-test-token', key)
    expect(decryptToken(blob, key)).toBe('rt-test-token')
  })

  it('produces a different blob on each call (fresh IV) but both decrypt correctly', () => {
    const blobA = encryptToken('rt-test-token', key)
    const blobB = encryptToken('rt-test-token', key)
    expect(blobA.equals(blobB)).toBe(false)
    expect(decryptToken(blobA, key)).toBe('rt-test-token')
    expect(decryptToken(blobB, key)).toBe('rt-test-token')
  })

  it('throws when a ciphertext byte is flipped', () => {
    const blob = encryptToken('rt-test-token', key)
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => decryptToken(tampered, key)).toThrow()
  })

  it('throws on a truncated blob shorter than iv+authTag (28 bytes)', () => {
    const tooShort = Buffer.alloc(27)
    expect(() => decryptToken(tooShort, key)).toThrow()
  })
})
