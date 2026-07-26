import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3ConfigFromEnv, type S3Config } from './config.js'
import { StorageError, type ObjectStore } from './types.js'

// Re-exported so a caller already pulling in the SDK for a client does not
// need a second import; ./config.js is the SDK-free entry point for callers
// that only want to validate configuration.
export { s3ConfigError, s3ConfigFromEnv, type S3Config } from './config.js'

interface SdkError {
  name?: string
  $metadata?: { httpStatusCode?: number }
}

function mapS3Error(op: string, err: unknown): StorageError {
  const e = err as SdkError
  const status = e.$metadata?.httpStatusCode
  const name = e.name ?? ''
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
    return new StorageError(`${op}: object not found`, 'not-found')
  }
  if (status === 401 || status === 403) {
    return new StorageError(`${op}: ${status} auth error`, 'auth')
  }
  const message = err instanceof Error ? err.message : String(err)
  return new StorageError(`${op}: ${message}`, 'transient')
}

/**
 * ObjectStore over any S3-compatible endpoint (Cloudflare R2 in production,
 * MinIO in the storage test tier). Its behavioral contract is asserted by
 * src/storage/conformance.ts running against real MinIO — mocking the SDK
 * here would only assert the mock.
 */
export function s3Store(config: S3Config): ObjectStore {
  const base = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2 and MinIO both want path-style addressing; virtual-host style would
    // require per-bucket DNS that neither provides here.
    forcePathStyle: true,
  }
  const client = new S3Client({ ...base, endpoint: config.endpoint })

  // Presigning binds the endpoint hostname into the signature. Inside Compose
  // the SDK reaches MinIO at http://minio:9000, but a URL signed against that
  // hostname is unfetchable from anywhere else — so signing gets its own
  // client pointed at the publicly reachable host when one is configured.
  const signClient = config.publicEndpoint
    ? new S3Client({ ...base, endpoint: config.publicEndpoint })
    : client

  return {
    async put(key, body, contentType) {
      let res
      try {
        res = await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.length,
          }),
        )
      } catch (err) {
        throw mapS3Error(`s3Store.put(${key})`, err)
      }
      // S3 returns the ETag quoted, and for multipart uploads it is not an
      // md5 at all. Strip the quotes and record it for provenance only —
      // upload verification is head()'s byte count, never this value.
      return { etag: (res.ETag ?? '').replaceAll('"', ''), bytes: body.length }
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        if (res.Body === undefined) {
          throw new StorageError(`s3Store.get(${key}): empty response body`, 'transient')
        }
        return Buffer.from(await res.Body.transformToByteArray())
      } catch (err) {
        if (err instanceof StorageError) throw err
        throw mapS3Error(`s3Store.get(${key})`, err)
      }
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
        return {
          bytes: res.ContentLength ?? 0,
          contentType: res.ContentType ?? 'application/octet-stream',
        }
      } catch (err) {
        const mapped = mapS3Error(`s3Store.head(${key})`, err)
        // A missing object is an ANSWER here, not a failure: callers ask head()
        // precisely to find out whether the key exists.
        if (mapped.kind === 'not-found') return null
        throw mapped
      }
    },

    async presignGet(key, ttlSeconds) {
      try {
        return await getSignedUrl(
          signClient,
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { expiresIn: ttlSeconds },
        )
      } catch (err) {
        throw mapS3Error(`s3Store.presignGet(${key})`, err)
      }
    },

    async delete(key) {
      try {
        // S3 DeleteObject is already idempotent — deleting a missing key is a
        // 204, which is exactly the contract the conformance suite asserts.
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      } catch (err) {
        throw mapS3Error(`s3Store.delete(${key})`, err)
      }
    },
  }
}

/**
 * The production store, from the environment. Every caller that is not
 * injecting a fake wants exactly this pair of calls, so it lives here once
 * rather than at each site; the throw on missing configuration is
 * s3ConfigFromEnv()'s, naming every absent key.
 */
export function storeFromEnv(): ObjectStore {
  return s3Store(s3ConfigFromEnv())
}
