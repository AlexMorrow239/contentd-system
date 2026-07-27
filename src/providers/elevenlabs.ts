import { encodePcmWav, parseWavDurationMs } from '../media/wav.js'
import { BrainrotError } from '../errors.js'
import type { WordTiming } from './whisperx.js'

// ElevenLabs bills TTS per character. $0.30 per 1,000 characters is the
// Creator-plan overage rate (verified 2026-07-19 against elevenlabs.io/pricing:
// Creator $0.30/1k, Pro $0.24/1k, Scale $0.18/1k). Subscription credits make the
// marginal character cheaper in practice, but the Creator overage rate is the
// durable worst case, so the ledger stays honest once included credits run out —
// same rationale as anthropic.ts ledgering list price through the sonnet-5 promo.
export const ELEVENLABS_USD_MICROS_PER_1K_CHARS = 300_000

// output_format=pcm_24000 returns raw 16-bit little-endian mono PCM at 24 kHz
// with no container, so the adapter wraps it in a RIFF/WAVE header itself.
const PCM_SAMPLE_RATE = 24_000
const PCM_CHANNELS = 1
const TIMEOUT_MS = 120_000

// Ceil per-character: a budget estimate must never under-reserve for a paid call.
export function estimateTtsCostMicros(text: string): number {
  return Math.ceil((text.length * ELEVENLABS_USD_MICROS_PER_1K_CHARS) / 1000)
}

// Wire shape of POST /v1/text-to-speech/{voiceId}/with-timestamps (verified
// 2026-07-19: elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).
// `alignment` is nullable in the published schema; audio can arrive without it.
interface WithTimestampsResponse {
  audio_base64: string
  alignment?: {
    characters: string[]
    character_start_times_seconds: number[]
    character_end_times_seconds: number[]
  } | null
}

// The alignment is third-party data, not a local invariant: a partial one
// indexed positionally yields `undefined` timings, hence NaN milliseconds, which
// collapse every scene window to 0ms and fail the job blaming "empty or
// too-short narration" long after the paid call. Require the three arrays to
// agree in length and every timing to be a finite number before trusting any of
// them.
function alignmentIsUsable(alignment: NonNullable<WithTimestampsResponse['alignment']>): boolean {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return false
  if (starts.length !== characters.length || ends.length !== characters.length) return false
  return starts.every((t) => Number.isFinite(t)) && ends.every((t) => Number.isFinite(t))
}

// Group character-level timings into words: every maximal run of non-whitespace
// characters is one word (punctuation stays attached — the same token style
// WhisperX emits, so captions and scene-window matching treat both sources alike).
function groupCharactersIntoWords(
  alignment: NonNullable<WithTimestampsResponse['alignment']>,
): WordTiming[] {
  const words: WordTiming[] = []
  let word = ''
  let startSec = 0
  let endSec = 0
  for (let i = 0; i < alignment.characters.length; i++) {
    const ch = alignment.characters[i]
    if (/\s/.test(ch)) {
      if (word) {
        words.push({ word, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) })
        word = ''
      }
      continue
    }
    if (!word) startSec = alignment.character_start_times_seconds[i]
    word += ch
    endSec = alignment.character_end_times_seconds[i]
  }
  if (word)
    words.push({ word, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) })
  return words
}

export async function synthWithTimestamps(opts: {
  voiceId: string
  modelId: string
  text: string
  apiKey?: string
  fetchImpl?: typeof fetch
}): Promise<{ wavBytes: Buffer; durationMs: number; words: WordTiming[]; costUsdMicros: number }> {
  // Resolve the key before any network activity: a missing key must fail fast so
  // the voice stage can fall back to the volume chain at zero spend.
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    throw new BrainrotError(
      'synthWithTimestamps: missing ElevenLabs API key (pass opts.apiKey or set ELEVENLABS_API_KEY)',
      { domain: 'config', kind: 'invalid' },
    )
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  // ElevenLabs responses carry no billing data; the ledger records the
  // deterministic per-character list price computed up front.
  const costUsdMicros = estimateTtsCostMicros(opts.text)

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}` +
    `/with-timestamps?output_format=pcm_24000`

  // Same guard as whisperx.ts: a hung TTS endpoint must not wedge the voice
  // stage forever. Abort after TIMEOUT_MS and rethrow with a named message.
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: opts.text, model_id: opts.modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`synthWithTimestamps: elevenlabs request timed out after ${TIMEOUT_MS}ms`)
    }
    throw err
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    throw new Error(`synthWithTimestamps: elevenlabs responded ${res.status}: ${raw}`)
  }

  const body = (await res.json()) as WithTimestampsResponse
  // A 200 without audio has nothing for the voice stage to fall back to, so it
  // is a hard failure — named so the log says which provider produced it.
  if (typeof body.audio_base64 !== 'string' || body.audio_base64.length === 0) {
    throw new Error('synthWithTimestamps: elevenlabs response carried no audio_base64')
  }
  const pcm = Buffer.from(body.audio_base64, 'base64')
  const wavBytes = encodePcmWav([pcm], PCM_SAMPLE_RATE, PCM_CHANNELS)
  const durationMs = parseWavDurationMs(wavBytes)
  // No alignment, or one we cannot trust → empty words. The voice stage (Task
  // 11) still writes timings.json; captions treats words.length === 0 as "no
  // provider timings" and falls through to WhisperX, so the paid audio is never
  // wasted — a downgrade worth one stderr line, not a failed job.
  let words: WordTiming[] = []
  if (body.alignment) {
    if (alignmentIsUsable(body.alignment)) {
      words = groupCharactersIntoWords(body.alignment)
    } else {
      console.error(
        'synthWithTimestamps: elevenlabs alignment is malformed; falling back to WhisperX timings',
      )
    }
  }
  return { wavBytes, durationMs, words, costUsdMicros }
}
