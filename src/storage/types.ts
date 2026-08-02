/**
 * The seam between the pipeline and wherever finished videos actually live
 * (design spec §3.1). Five methods, one caller each: `put` (the store stage),
 * `get` (YouTube's upload when the local file has been reclaimed), `head`
 * (post-upload verification and the digest sweep), `presignGet` (Instagram,
 * preflight), `delete` (library reject).
 *
 * Deliberately NO `list()`. Its only use would be sweeping for objects
 * orphaned by a failed reject-delete — a rare event costing fractions of a
 * cent, already recorded by a warning line carrying the key.
 */
import { BrainrotError } from '../errors.js'

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<{ etag: string; bytes: number }>
  get(key: string): Promise<Buffer<ArrayBuffer>>
  head(key: string): Promise<{ bytes: number; contentType: string } | null>
  presignGet(key: string, ttlSeconds: number): Promise<string>
  delete(key: string): Promise<void>
}

// One class, one `kind` discriminant, so callers map storage outcomes onto
// their own taxonomy without instanceof-ing SDK-specific error types. The
// vocabulary is the shared one in src/errors.ts, narrowed to the three
// outcomes an object store can actually produce.
export class StorageError extends BrainrotError {
  // `declare` is mandatory under useDefineForClassFields — without it, the
  // base class's field initializer runs after this one and overwrites it
  // with `undefined`.
  declare readonly kind: 'not-found' | 'auth' | 'transient'

  constructor(message: string, kind: 'not-found' | 'auth' | 'transient') {
    super(message, { domain: 'storage', kind })
    this.name = 'StorageError'
  }
}
