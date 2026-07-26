import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { S3Config } from './s3.js'

/**
 * Shared scaffolding for the storage test tier (STORAGE=1, see vitest.config.ts).
 * Centralized so pointing the tier at a different MinIO is one edit — the two
 * copies this replaced had already drifted, one honoring the BRAINROT_S3_*
 * overrides and the other hardcoding localhost.
 */

// Matches docker-compose.yml's `minio` service (profile: dev). Start it with:
//   docker compose --profile dev up -d minio
export function minioConfig(): S3Config {
  return {
    endpoint: process.env.BRAINROT_S3_ENDPOINT ?? 'http://localhost:9100',
    bucket: process.env.BRAINROT_S3_BUCKET ?? 'brainrot-videos',
    accessKeyId: process.env.BRAINROT_S3_ACCESS_KEY_ID ?? 'brainrotdev',
    secretAccessKey: process.env.BRAINROT_S3_SECRET_ACCESS_KEY ?? 'brainrotdev',
    region: 'auto',
  }
}

/**
 * MinIO starts with no buckets, and a conformance run against a nonexistent
 * bucket fails with an unhelpful NoSuchBucket. Creating it here makes the tier
 * runnable against a freshly-started container with no manual step.
 *
 * Every storage-tier file calls this for itself: workers run in any order and
 * may be separate processes, so bucket creation cannot rely on import order
 * across files. The already-exists cases are what make that safe.
 */
export async function ensureBucket(config: S3Config): Promise<void> {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  })
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
  } catch (err) {
    const name = (err as { name?: string }).name ?? ''
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
  }
}
