import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../../../daemon/src/infra/db/index.js'
import { seedJob, seedLibrary } from '../../../../daemon/testing/db.js'
import { testRoot } from '../../../../daemon/testing/tmp.js'
import type { DashboardConfig } from '../../config.js'
import { withDashboardDb } from '../runtime.js'
import { streamVideo } from '../stream-video.js'
function response(config: DashboardConfig, id: string, range?: string): Response {
  return withDashboardDb(config.paths.dbPath, (db) =>
    streamVideo(
      new Request('http://localhost/video', { headers: range ? { range } : {} }),
      db,
      config.paths.runsRoot,
      id,
    ),
  )
}
describe('streamVideo', () => {
  function configWithVideo(bytes: Buffer, videoPathInDb?: string): DashboardConfig {
    const paths = testRoot('brainrot-vid-')
    const videoDir = join(paths.runsRoot, 'j1', 'assemble')
    mkdirSync(videoDir, { recursive: true })
    const videoFile = join(videoDir, 'final.mp4')
    writeFileSync(videoFile, bytes)

    const db = openDb(paths.dbPath)
    seedJob(db, 'j1', { channel: 'space', topic: 'Venus' })
    seedLibrary(db, 'j1', { videoPath: videoPathInDb ?? videoFile, state: 'ready' })
    db.close()

    return { paths, port: 8787, host: '127.0.0.1' }
  }

  it('serves the whole file when no Range is sent', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = response(config, 'j1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(await res.text()).toBe('0123456789')
  })

  it('serves a 206 partial response so the player can seek', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = response(config, 'j1', 'bytes=2-5')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('2345')
  })

  it('404s for a job with no library row', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    const res = response(config, 'nope')
    expect(res.status).toBe(404)
  })

  it('404s when the file was deleted from disk', async () => {
    const config = configWithVideo(Buffer.from('0123456789'))
    rmSync(join(config.paths.runsRoot, 'j1', 'assemble', 'final.mp4'))
    const res = response(config, 'j1')
    expect(res.status).toBe(404)
  })

  it('403s on a video_path that escapes the runs root', async () => {
    // A malformed library row must not become an arbitrary file read.
    const config = configWithVideo(Buffer.from('0123456789'), '/etc/passwd')
    const res = response(config, 'j1')
    expect(res.status).toBe(403)
  })
})
