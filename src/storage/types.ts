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
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<{ etag: string; bytes: number }>
  get(key: string): Promise<Buffer<ArrayBuffer>>
  head(key: string): Promise<{ bytes: number; contentType: string } | null>
  presignGet(key: string, ttlSeconds: number): Promise<string>
  delete(key: string): Promise<void>
}

// Mirrors PublishError's shape (src/publish/types.ts): one class, one `kind`
// discriminant, so callers map storage outcomes onto their own taxonomy
// without instanceof-ing SDK-specific error types.
export class StorageError extends Error {
  constructor(
    message: string,
    public kind: 'not-found' | 'auth' | 'transient',
  ) {
    super(message)
    this.name = 'StorageError'
  }
}
