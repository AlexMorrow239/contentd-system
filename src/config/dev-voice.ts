/**
 * Single source of truth for the dev-voice-mode env var name, so the voice
 * stage's gate, the `--dev` CLI flag (src/cli.ts) and both test files can never
 * drift apart by hardcoding independent copies of the same literal.
 *
 * It lives here rather than in stages/voice.ts, its only production reader,
 * because src/cli.ts needs the name to implement `--dev` on a command that may
 * never synthesize anything. Importing it from the stage pulled kokoro-js and
 * msedge-tts (~115ms) into every CLI invocation to obtain one string. This
 * module imports nothing, so it stays free to reach from anywhere.
 */
export const DEV_VOICE_ENV = 'BRAINROT_DEV_VOICE'
