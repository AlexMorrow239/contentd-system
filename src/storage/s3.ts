import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { StorageError, type ObjectStore } from './types.js'

export interface S3Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  publicEndpoint?: string
}

/**
 * Reads S3/R2 configuration from the environment at CALL time, not module
 * load — the convention igUploadsPerDayCap already sets, so tests and
 * long-lived cron processes observe env changes without a re-import.
 *
 * Throws naming EVERY missing key at once rather than the first: an operator
 * configuring this for the first time should need one round trip, not four.
 * There is deliberately no fallback to fakeStore here (design spec §3.5).
 */
export function s3ConfigFromEnv(): S3Config {
  const missing: string[] = []
  const read = (name: string): string => {
    const value = process.env[name]?.trim() ?? ''
    if (value === '') missing.push(name)
    return value
  }
  const endpoint = read('BRAINROT_S3_ENDPOINT')
  const bucket = read('BRAINROT_S3_BUCKET')
  const accessKeyId = read('BRAINROT_S3_ACCESS_KEY_ID')
  const secretAccessKey = read('BRAINROT_S3_SECRET_ACCESS_KEY')
  if (missing.length > 0) {
    throw new Error(
      `object storage is not configured: missing ${missing.join(', ')}. ` +
        'Set them in .env (see .env.example) — there is no local fallback.',
    )
  }
  const publicEndpoint = process.env.BRAINROT_S3_PUBLIC_ENDPOINT?.trim()
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // R2 ignores region but the SDK requires one; 'auto' is R2's documented value.
    region: process.env.BRAINROT_S3_REGION?.trim() || 'auto',
    publicEndpoint: publicEndpoint === '' ? undefined : publicEndpoint,
  }
}

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
