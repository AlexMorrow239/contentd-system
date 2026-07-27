import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../db/index.js'
import { ensureBucket, minioConfig } from '../../testing/storage.js'
import { s3Store } from '../../storage/s3.js'
import { runCli } from '../../testing/run-cli.js'

const CONFIG = minioConfig()

const ENV = {
  BRAINROT_S3_ENDPOINT: CONFIG.endpoint,
  BRAINROT_S3_BUCKET: CONFIG.bucket,
  BRAINROT_S3_ACCESS_KEY_ID: CONFIG.accessKeyId,
  BRAINROT_S3_SECRET_ACCESS_KEY: CONFIG.secretAccessKey,
  BRAINROT_S3_REGION: 'auto',
}

const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom', 'utf8'),
  Buffer.alloc(64),
])

describe('brainrot publish preflight (MinIO)', () => {
  it('reports every check ok for a well-formed stored object', async () => {
    await ensureBucket(CONFIG)
    const dir = mkdtempSync(path.join(tmpdir(), 'brainrot-preflight-cli-'))
    const dbPath = path.join(dir, 'test.db')
    const db = openDb(dbPath)
    db.prepare(
      "INSERT INTO jobs (id, channel, tier, topic, status) VALUES ('job-pf','example','volume','a topic','done')",
    ).run()
    db.prepare(
      "INSERT INTO library (job_id, video_path, metadata_json, state) VALUES ('job-pf','gone.mp4','{}','ready')",
    ).run()
    db.prepare(
      'INSERT INTO library_objects (job_id, object_key, bytes, etag) VALUES (?,?,?,?)',
    ).run('job-pf', 'videos/example/job-pf.mp4', VIDEO.length, 'e')
    db.close()

    await s3Store(CONFIG).put('videos/example/job-pf.mp4', VIDEO, 'video/mp4')

    const res = await runCli(['publish', 'preflight', 'job-pf', '--db', dbPath], { env: ENV })

    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('ok   http-status')
    expect(res.stdout).toContain('ok   content-type')
    expect(res.stdout).toContain('ok   byte-length')
    expect(res.stdout).toContain('ok   mp4-header')
    rmSync(dir, { recursive: true, force: true })
  })
})
