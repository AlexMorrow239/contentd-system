import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

// Parses BRAINROT_TOKEN_KEY (64 hex chars = 32 raw bytes for AES-256) into the
// key Buffer. Missing/malformed input is a config error the caller surfaces
// before any token work is attempted — never a bare crash on a bad .env value.
export function parseTokenKey(hex: string | undefined): Buffer {
  if (hex === undefined || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BRAINROT_TOKEN_KEY must be 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}

// Fresh random IV per call so identical plaintexts never produce identical
// ciphertexts (GCM requires a unique IV per key: reuse breaks both
// confidentiality and authenticity). Blob layout iv(12) || authTag(16) ||
// ciphertext is self-contained — no separate IV column needed in oauth_tokens.
export function encryptToken(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext])
}

// Throws on a truncated blob and on GCM auth-tag failure (tamper, corruption,
// wrong key) — callers treat any throw here as "token unusable" (the no-auth
// noop path), never a crash.
export function decryptToken(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('decryptToken: blob too short')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
