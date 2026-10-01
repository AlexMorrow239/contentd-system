import { writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../../../../testing/tmp.js'
import { classify, errorMessage } from '../../../shared/errors.js'
import { alignTranscript } from '../whisperx.js'

let server: http.Server
let baseUrl: string
let lastBody: string
let responder: () => { status: number; body: string }

beforeEach(async () => {
  responder = () => ({
    status: 200,
    body: JSON.stringify({ words: [{ word: 'hi', start: 0.12, end: 0.34 }] }),
  })
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8')
      const r = responder()
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

async function tmpWav(): Promise<string> {
  const dir = tmpDir('contentd-wx-')
  const p = path.join(dir, 'narration.wav')
  await writeFile(p, Buffer.from('RIFFxxxxWAVEdummy'))
  return p
}

describe('alignTranscript', () => {
  it('surfaces nested socket failures with the endpoint and original cause', async () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const failure = new TypeError('fetch failed', { cause })
    const err = await alignTranscript({
      baseUrl,
      wavPath: await tmpWav(),
      transcript: 'hi',
      fetchImpl: async () => {
        throw failure
      },
    }).catch((e: unknown) => e)
    expect(errorMessage(err)).toContain(baseUrl + '/align')
    expect(errorMessage(err)).toContain('UND_ERR_SOCKET')
    expect(errorMessage(err)).toContain('other side closed')
    expect(errorMessage(err)).toContain('memory')
    expect(err).toHaveProperty('cause', failure)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'transient' })
  })

  it('posts multipart audio + transcript and converts seconds to integer ms', async () => {
    const wavPath = await tmpWav()
    const words = await alignTranscript({ baseUrl, wavPath, transcript: 'hi there' })
    expect(lastBody).toContain('name="transcript"')
    expect(lastBody).toContain('hi there')
    expect(lastBody).toContain('name="audio"')
    expect(lastBody).toContain('filename="narration.wav"')
    expect(words).toEqual([{ word: 'hi', startMs: 120, endMs: 340 }])
  })

  it('throws on a non-2xx response, classified as provider/transient', async () => {
    const wavPath = await tmpWav()
    responder = () => ({ status: 500, body: JSON.stringify({ detail: 'boom' }) })
    const err = await alignTranscript({ baseUrl, wavPath, transcript: 'x' }).catch(
      (e: unknown) => e,
    )
    expect(errorMessage(err)).toMatch(/500/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'transient' })
  })

  it('throws on a 401/403 response, classified as provider/auth', async () => {
    const wavPath = await tmpWav()
    responder = () => ({ status: 401, body: JSON.stringify({ detail: 'bad token' }) })
    const err = await alignTranscript({ baseUrl, wavPath, transcript: 'x' }).catch(
      (e: unknown) => e,
    )
    expect(errorMessage(err)).toMatch(/401/)
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'auth' })
  })

  it('throws naming the endpoint when a 200 body has no words array, classified as provider/invalid', async () => {
    const wavPath = await tmpWav()
    // A 200 of an unexpected shape used to surface as "Cannot read properties of
    // undefined (reading 'map')", indistinguishable from a bug in this repo.
    responder = () => ({ status: 200, body: JSON.stringify({ detail: 'model still loading' }) })
    const err = await alignTranscript({ baseUrl, wavPath, transcript: 'x' }).catch(
      (e: unknown) => e,
    )
    expect(errorMessage(err)).toMatch(new RegExp(`malformed response from ${baseUrl}/align`))
    expect(classify(err)).toMatchObject({ domain: 'provider', kind: 'invalid' })
  })

  it('drops words whose timings are not finite rather than emitting NaN ms', async () => {
    const wavPath = await tmpWav()
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        words: [
          { word: 'hi', start: 0.12, end: 0.34 },
          { word: 'gone', start: null, end: 0.5 },
          { word: 'there', start: 0.4, end: 0.6 },
        ],
      }),
    })
    const words = await alignTranscript({ baseUrl, wavPath, transcript: 'hi gone there' })
    expect(words).toEqual([
      { word: 'hi', startMs: 120, endMs: 340 },
      { word: 'there', startMs: 400, endMs: 600 },
    ])
  })
})
