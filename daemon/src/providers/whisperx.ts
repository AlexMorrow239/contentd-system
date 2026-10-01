import { createDeadline, systemTime, type TimeSource } from '../time.js'
import { readFile } from 'node:fs/promises'
import { BrainrotError, errorMessage, isAbortLike, isAuthStatus } from '../errors.js'

export interface WordTiming {
  word: string
  startMs: number
  endMs: number
}

export async function alignTranscript(opts: {
  baseUrl: string
  wavPath: string
  transcript: string
  time?: TimeSource
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<WordTiming[]> {
  opts.signal?.throwIfAborted()
  const bytes = await readFile(opts.wavPath)
  const form = new FormData()
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'narration.wav')
  form.append('transcript', opts.transcript)

  // Without a timeout a hung sidecar wedges the align stage forever. Abort the fetch
  // after timeoutMs and rethrow with a message that names the sidecar and the budget.
  const timeoutMs = opts.timeoutMs ?? 120_000
  opts.signal?.throwIfAborted()
  const deadline = createDeadline(opts.time ?? systemTime, timeoutMs, opts.signal)
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/align`, {
      method: 'POST',
      body: form,
      signal: deadline.signal,
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      throw new BrainrotError(`alignTranscript: whisperx responded ${res.status}: ${raw}`, {
        domain: 'provider',
        kind: isAuthStatus(res.status) ? 'auth' : 'transient',
      })
    }

    // The 200 body is sidecar output, not a local invariant: casting it blind
    // turned an unexpected shape into "Cannot read properties of undefined
    // (reading 'map')" stored verbatim as the stage error — indistinguishable from
    // a bug in this repo. Name the endpoint instead, and drop any word whose
    // timings are not finite rather than emitting NaN (or silently 0) ms.
    const body = (await res.json()) as { words?: { word: string; start: number; end: number }[] }
    if (!Array.isArray(body.words)) {
      throw new BrainrotError(`alignTranscript: malformed response from ${opts.baseUrl}/align`, {
        domain: 'provider',
        kind: 'invalid',
      })
    }
    return body.words
      .filter((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end))
      .map((w) => ({
        word: w.word,
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      }))
  } catch (err) {
    opts.signal?.throwIfAborted()
    if (isAbortLike(err)) {
      throw new BrainrotError(`alignTranscript: whisperx align timed out after ${timeoutMs}ms`, {
        domain: 'provider',
        kind: 'transient',
        cause: err,
      })
    }
    if (err instanceof BrainrotError) throw err
    const codes = new Set<string>()
    const detail = requestErrorDetail(err, codes)
    const hint = codes.has('UND_ERR_SOCKET')
      ? ' The sidecar closed the connection; check its logs and Docker VM memory for a crash or out-of-memory kill.'
      : ''
    throw new BrainrotError(
      `alignTranscript: request to ${opts.baseUrl}/align failed: ${detail}.${hint}`,
      { domain: 'provider', kind: 'transient', cause: err },
    )
  } finally {
    deadline.dispose()
  }
}

// Fetch hides socket/DNS failures in cause (sometimes an AggregateError).
// Bound traversal and tolerate cycles; only include messages/codes, not request data.
// Codes found along the chain are collected into `codes`.
function requestErrorDetail(err: unknown, codes: Set<string>, seen = new Set<unknown>()): string {
  if (seen.has(err) || seen.size >= 8) return ''
  seen.add(err)
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  if (code) codes.add(code)
  const parts = [code ? `${code}: ${errorMessage(err)}` : errorMessage(err)]
  if (err instanceof Error && err.cause !== undefined) {
    parts.push(requestErrorDetail(err.cause, codes, seen))
  }
  if (err instanceof AggregateError) {
    for (const nested of err.errors) parts.push(requestErrorDetail(nested, codes, seen))
  }
  return parts.filter(Boolean).join('; ')
}
