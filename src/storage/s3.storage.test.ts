import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { describeObjectStore } from './conformance.js'
import { s3Store, type S3Config } from './s3.js'

// Matches docker-compose.yml's `minio` service (profile: dev). Start it with:
//   docker compose --profile dev up -d minio
const CONFIG: S3Config = {
  endpoint: process.env.BRAINROT_S3_ENDPOINT ?? 'http://localhost:9100',
  bucket: process.env.BRAINROT_S3_BUCKET ?? 'brainrot-test',
  accessKeyId: process.env.BRAINROT_S3_ACCESS_KEY_ID ?? 'brainrotdev',
  secretAccessKey: process.env.BRAINROT_S3_SECRET_ACCESS_KEY ?? 'brainrotdev',
  region: 'auto',
}

// MinIO starts with no buckets, and a conformance run against a nonexistent
// bucket fails with an unhelpful NoSuchBucket. Creating it here makes the tier
// runnable against a freshly-started container with no manual step.
async function ensureBucket(): Promise<void> {
  const client = new S3Client({
    region: CONFIG.region,
    endpoint: CONFIG.endpoint,
    credentials: {
      accessKeyId: CONFIG.accessKeyId,
      secretAccessKey: CONFIG.secretAccessKey,
    },
    forcePathStyle: true,
  })
  try {
    await client.send(new CreateBucketCommand({ Bucket: CONFIG.bucket }))
  } catch (err) {
    const name = (err as { name?: string }).name ?? ''
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err
  }
}

describeObjectStore('s3Store (MinIO)', async () => {
  await ensureBucket()
  return {
    store: s3Store(CONFIG),
    // Objects use unique per-test keys and cost nothing in a dev container;
    // leaving them makes a failed run inspectable in the MinIO console.
    cleanup: async () => {},
  }
})
