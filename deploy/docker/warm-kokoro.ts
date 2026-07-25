// Build-time only. transformers.js caches model weights under node_modules, so
// downloading here turns the kokoro weights into an image layer instead of a
// first-job network dependency. Runs as the `node` user in the Dockerfile so
// the cache is owned by the account that reads it at runtime.
import { KokoroTTS } from 'kokoro-js'
import { KOKORO_MODEL_ID } from '../../src/stages/voice.js'

await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'q8' })
console.log(`warm-kokoro: cached ${KOKORO_MODEL_ID}`)
