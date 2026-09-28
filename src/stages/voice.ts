import { promises as fs } from 'node:fs'
import { KokoroTTS, type GenerateOptions } from 'kokoro-js'
import { MsEdgeTTS, type OUTPUT_FORMAT } from 'msedge-tts'
import type { StageDef, JobContext } from '../jobs/types.js'
import type { ScriptArtifact } from './script.js'
import { assertBudget, recordCost } from '../jobs/costs.js'
import { BrainrotError } from '../errors.js'
import { estimateTtsCostMicros, synthWithTimestamps } from '../providers/elevenlabs.js'
import type { WordTiming } from '../providers/whisperx.js'
import {
  narrationText,
  bodyText,
  countWords,
  minPlausibleNarrationMs,
  MAX_PLAUSIBLE_WORDS_PER_SEC,
  HOOK_PAUSE_MS,
} from './narration-text.js'
import {
  encodePcmWav,
  pcmFromFloat32,
  parseWav,
  parseWavDurationMs,
  silencePcm,
  trimTrailingSilence,
} from '../media/wav.js'

export interface VoiceMeta {
  provider: 'kokoro' | 'edge-tts' | 'elevenlabs'
  voiceId: string
  durationMs: number
}

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const EDGE_VOICE = 'en-US-AriaNeural'
// The Edge TTS backend supports "riff-24khz-16bit-mono-pcm" (a RIFF/WAV PCM
// container), but msedge-tts ships that OUTPUT_FORMAT member commented out, so
// only MP3/Opus constants exist. We pass the literal, protocol-valid format
// string; the cast only satisfies the enum-typed parameter.
const EDGE_FORMAT = 'riff-24khz-16bit-mono-pcm' as unknown as OUTPUT_FORMAT

// kokoro-js tokenizes with `truncation: true` against the model's 510-phoneme-token
// context (see `generate_from_ids`: `Math.min(..., 509)`). Anything past that is
// silently dropped, yielding a well-formed WAV holding only the start of the script.
// ~510 phoneme tokens is roughly 80 English words; 60 is a conservative budget that
// leaves headroom for phoneme-dense words.
export const MAX_CHUNK_WORDS = 60

// Break any piece still over budget on `boundary`; leave the rest alone.
function refine(pieces: string[], boundary: RegExp): string[] {
  return pieces.flatMap((piece) =>
    countWords(piece) <= MAX_CHUNK_WORDS
      ? [piece]
      : piece
          .split(boundary)
          .map((s) => s.trim())
          .filter(Boolean),
  )
}

// Split `text` into pieces of at most MAX_CHUNK_WORDS words, preferring the most
// natural boundary available: sentences, then clauses, then a hard word count.
export function splitForTts(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const clauses = refine(sentences, /(?<=,)\s+/)
  // Anything still over budget has no punctuation to lean on: slice on raw word
  // count so no piece can ever exceed what the model will accept.
  const atomic = clauses.flatMap((piece) => {
    const words = piece.split(/\s+/).filter(Boolean)
    if (words.length <= MAX_CHUNK_WORDS) return [piece]
    const sliced: string[] = []
    for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
      sliced.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '))
    }
    return sliced
  })

  // Greedily pack the atomic pieces back into full-budget chunks.
  const chunks: string[] = []
  let current = ''
  let currentWords = 0
  for (const piece of atomic) {
    const pieceWords = countWords(piece)
    if (current && currentWords + pieceWords > MAX_CHUNK_WORDS) {
      chunks.push(current)
      current = piece
      currentWords = pieceWords
    } else {
      current = current ? `${current} ${piece}` : piece
      currentWords += pieceWords
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// One synthesized chunk, reduced to the PCM payload plus the format it came in.
interface PcmChunk {
  data: Buffer
  sampleRate: number
  channels: number
}

// A section's (hook or body's) synthesized chunks, unjoined so encodePcmWav
// still copies the payload only once across the whole hook+silence+body splice.
interface PcmSection {
  parts: Buffer[]
  sampleRate: number
  channels: number
}

/**
 * Synthesize `text` one under-budget chunk at a time and return the trimmed,
 * unconcatenated chunk buffers. Chunks are synthesized sequentially on
 * purpose: kokoro is local ONNX inference against one model instance and
 * edge-tts reuses one socket, so concurrency would only contend.
 *
 * Each chunk's trailing silence is capped before concatenation: kokoro pads
 * every generation with multi-second silence, which would otherwise embed dead
 * air between chunks and a long silent tail after the last word (Plan 1 real
 * tail run: 15375ms narration whose aligned words end ~10490ms — captions stop
 * while the video keeps running).
 */
async function synthChunked(
  text: string,
  provider: string,
  synth: (chunk: string) => Promise<PcmChunk>,
): Promise<PcmSection> {
  const parts: Buffer[] = []
  let sampleRate = 0
  let channels = 0
  for (const chunk of splitForTts(text)) {
    const pcm = await synth(chunk)
    parts.push(trimTrailingSilence(pcm.data, pcm.sampleRate, Math.max(1, pcm.channels)))
    sampleRate = pcm.sampleRate
    channels = pcm.channels
  }
  if (parts.length === 0 || sampleRate <= 0) {
    throw new BrainrotError(`${provider} produced no audio`, {
      domain: 'provider',
      kind: 'invalid',
    })
  }
  return { parts, sampleRate, channels: Math.max(1, channels) }
}

/**
 * Synthesize `hook` and `body` as two separate chunked sections and splice
 * them together with HOOK_PAUSE_MS of true silence, writing the result as a
 * single WAV. kokoro and edge-tts have no SSML/pause markup support, so the
 * pause has to be a real, physically synthesized gap rather than a text-level
 * hint the backend might honor.
 */
async function synthHookAndBody(
  hook: string,
  body: string,
  provider: string,
  synth: (chunk: string) => Promise<PcmChunk>,
  wavPath: string,
): Promise<void> {
  const hookPcm = await synthChunked(hook, provider, synth)
  const bodyPcm = await synthChunked(body, provider, synth)
  const silence = silencePcm(HOOK_PAUSE_MS, hookPcm.sampleRate, hookPcm.channels)
  await fs.writeFile(
    wavPath,
    encodePcmWav(
      [...hookPcm.parts, silence, ...bodyPcm.parts],
      hookPcm.sampleRate,
      hookPcm.channels,
    ),
  )
}

/**
 * The loaded kokoro model, memoized for the process. `from_pretrained` reads
 * and initializes the ONNX weights, and it used to run once per job even though
 * the model is immutable and every synth is a `generate` call against it. One
 * instance is also what the sequential-chunk discipline in synthChunked assumes
 * — chunks contend on a single model either way, so caching it changes cost,
 * not concurrency.
 *
 * Same memo shape as assemble.ts's getBundle: a rejected load must not poison
 * the memo for the process lifetime, or one transient model-load failure would
 * send every later job down the edge-tts fallback. Callers still see the
 * original rejection; the identity guard keeps a newer in-flight load from
 * being wiped by an older failure.
 */
let kokoroPromise: Promise<KokoroTTS> | undefined
function getKokoro(): Promise<KokoroTTS> {
  if (!kokoroPromise) {
    const inFlight = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' })
    inFlight.catch(() => {
      if (kokoroPromise === inFlight) kokoroPromise = undefined
    })
    kokoroPromise = inFlight
  }
  return kokoroPromise
}

/** Drops the memoized model, freeing its weights (and letting a test reload). */
export function resetKokoro(): void {
  kokoroPromise = undefined
}

async function synthKokoro(
  hook: string,
  body: string,
  voiceId: string,
  wavPath: string,
): Promise<void> {
  const tts = await getKokoro()
  const synth = async (chunk: string): Promise<PcmChunk> => {
    // ctx.channel.voice.volume is a runtime-configured string; kokoro-js types the
    // `voice` option as a narrow union of built-in voice names. Narrow the config
    // value here, mirroring the EDGE_FORMAT cast above.
    const audio = await tts.generate(chunk, { voice: voiceId as GenerateOptions['voice'] })
    return { data: pcmFromFloat32(audio.audio), sampleRate: audio.sampling_rate, channels: 1 }
  }
  await synthHookAndBody(hook, body, 'kokoro', synth, wavPath)
}

async function synthEdge(hook: string, body: string, wavPath: string): Promise<void> {
  const tts = new MsEdgeTTS()
  await tts.setMetadata(EDGE_VOICE, EDGE_FORMAT)

  // Edge TTS is a cloud service with no local context window, but its input limits
  // are undocumented and could not be exercised here (the endpoint currently answers
  // 403), so the same chunking is applied defensively. It is safe either way: each
  // response is a self-contained RIFF stream whose PCM payloads concatenate cleanly.
  const synth = async (chunk: string): Promise<PcmChunk> => {
    // toStream is synchronous in current msedge-tts; awaiting a plain object is a
    // no-op, so this is robust across versions that return a promise.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const { audioStream } = await tts.toStream(chunk)
    const buffers: Buffer[] = []
    for await (const b of audioStream as AsyncIterable<Uint8Array>) buffers.push(Buffer.from(b))
    const wav = parseWav(Buffer.concat(buffers))
    return { data: wav.data, sampleRate: wav.sampleRate, channels: wav.channels }
  }
  await synthHookAndBody(hook, body, 'edge-tts', synth, wavPath)
}

// ElevenLabs' eleven_multilingual_v2 model (the only premium model this repo
// wires up) understands the SSML break tag as a real, timed pause rather than
// literal text (verified against ElevenLabs' own docs: "the AI has an actual
// understanding of this syntax"). Sent as one call so the API's own pacing
// carries across the hook/body boundary, instead of splicing two separate
// syntheses together as the local kokoro/edge-tts path must.
const HOOK_BREAK_TAG = `<break time="${HOOK_PAUSE_MS}ms" />`
// Defense in depth: if a provider ever echoed the tag's characters back into
// its alignment instead of consuming it as markup, match on the tag's
// distinctive markup shape rather than the exact fragments we happened to
// send — robust to whitespace/quoting variance a Set of literal tokens is not.
const BREAK_TAG_FRAGMENT = /^<\/?break\b|^time\s*=|^\/?>$/i

export const voiceStage: StageDef = {
  name: 'voice',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptArtifact
    const narration = narrationText(script)
    const body = bodyText(script)
    const wavPath = ctx.artifactPath('voice', 'narration.wav')
    const timingsPath = ctx.artifactPath('voice', 'timings.json')

    // Captions trusts voice/timings.json over WhisperX, so a stale file from a
    // previous failed attempt would caption audio it was never measured against.
    // Remove it before any synthesis; only a VALIDATED ElevenLabs success
    // recreates it (below, after the duration guard).
    await fs.rm(timingsPath, { force: true })

    let provider: VoiceMeta['provider'] | undefined
    let voiceId = ''
    let premiumWords: WordTiming[] | undefined

    const premiumVoice = ctx.channel.voice.premium
    if (premiumVoice) {
      // The hook and body go in one call, with an explicit SSML break between
      // them so ElevenLabs leaves a deliberate pause instead of reading
      // straight into the story (see HOOK_BREAK_TAG above).
      const elevenText = `${script.hook} ${HOOK_BREAK_TAG}\n\n${body}`

      // Paid call: reserve the character-based estimate against the per-video
      // cap before dialing out. This sits OUTSIDE the fallback catch on
      // purpose — a budget breach is enforcement, not a provider fault, so
      // BudgetExceededError propagates and the runner parks the job 'blocked'
      // instead of silently downgrading the voice. Estimated off the actual
      // (SSML-augmented) text sent — never under-reserve against the shorter
      // plain narration.
      assertBudget(ctx.db, ctx.channel, ctx.jobId, estimateTtsCostMicros(elevenText))

      // ONLY the provider call is fallback-eligible: while nothing has been
      // delivered, a failure legitimately means "use the volume chain".
      let synth: Awaited<ReturnType<typeof synthWithTimestamps>> | undefined
      try {
        synth = await synthWithTimestamps({
          voiceId: premiumVoice.voiceId,
          modelId: premiumVoice.modelId,
          text: elevenText,
        })
      } catch (err) {
        // The timings write is deferred past the duration guard, so this
        // attempt cannot have created timings.json — the rm is defense in
        // depth against the write ever drifting back into the try.
        await fs.rm(timingsPath, { force: true })
        ctx.log.warn({ err }, 'elevenlabs TTS failed; falling back to volume voice chain')
      }

      if (synth) {
        // Paid audio is in hand, so the spend is real: ledger it BEFORE any
        // fallible local write. A failure below is a local fault, not a
        // provider one — it surfaces as a stage error rather than a silent
        // downgrade that would strand this charge unrecorded.
        recordCost(ctx.db, ctx.jobId, 'elevenlabs', 'tts', synth.costUsdMicros)
        await fs.writeFile(wavPath, synth.wavBytes)
        provider = 'elevenlabs'
        voiceId = premiumVoice.voiceId
        // timings.json is NOT written here: it becomes visible to captions
        // only after the shared duration guard below has accepted the audio.
        premiumWords = synth.words.filter((w) => !BREAK_TAG_FRAGMENT.test(w.word))
      }
    }

    if (provider === undefined) {
      try {
        await synthKokoro(script.hook, body, ctx.channel.voice.volume, wavPath)
        provider = 'kokoro'
        voiceId = ctx.channel.voice.volume
      } catch (kokoroErr) {
        ctx.log.warn({ err: kokoroErr }, 'kokoro TTS failed; falling back to edge-tts')
        try {
          await synthEdge(script.hook, body, wavPath)
          provider = 'edge-tts'
          voiceId = EDGE_VOICE
        } catch (edgeErr) {
          throw new BrainrotError(
            `voice synthesis failed: kokoro=${String(kokoroErr)}; edge=${String(edgeErr)}`,
            { domain: 'provider', kind: 'transient' },
          )
        }
      }
    }

    const durationMs = parseWavDurationMs(await fs.readFile(wavPath))

    // Defense in depth: a TTS backend that silently drops text still returns a
    // well-formed WAV, so the only signal is that it is too short for the
    // script. This guard covers every provider, ElevenLabs included.
    const words = countWords(narration)
    const minPlausibleMs = minPlausibleNarrationMs(words)
    if (durationMs < minPlausibleMs) {
      throw new BrainrotError(
        `voice synthesis produced implausibly short audio: ${durationMs}ms for ${words} words ` +
          `(minimum ${minPlausibleMs}ms at ${MAX_PLAUSIBLE_WORDS_PER_SEC} words/sec); ` +
          `narration was likely truncated by provider "${provider}"`,
        { domain: 'provider', kind: 'invalid' },
      )
    }

    // Only now — with the audio validated — may the provider timings land on
    // disk. Writing timings.json any earlier would break the ABSENT guarantee:
    // a truncation throw above must leave nothing for captions to trust.
    if (premiumWords !== undefined) {
      await fs.writeFile(timingsPath, JSON.stringify({ words: premiumWords }, null, 2))
    }

    const meta: VoiceMeta = { provider, voiceId, durationMs }
    await fs.writeFile(ctx.artifactPath('voice', 'voice.json'), JSON.stringify(meta, null, 2))
  },
}
