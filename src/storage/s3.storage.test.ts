import { ensureBucket, minioConfig } from './_testkit.js'
import { describeObjectStore } from './conformance.js'
import { s3Store } from './s3.js'

const CONFIG = minioConfig()

describeObjectStore('s3Store (MinIO)', async () => {
  await ensureBucket(CONFIG)
  return {
    store: s3Store(CONFIG),
    // Objects use unique per-test keys and cost nothing in a dev container;
    // leaving them makes a failed run inspectable in the MinIO console.
    cleanup: async () => {},
  }
})
