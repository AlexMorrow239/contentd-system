import { defineConfig } from 'vitest/config'
import { SlowFilesFirstSequencer } from './scripts/vitest-sequencer.js'

const contract = process.env.CONTRACT === '1'

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Builds dist/ before any worker starts, so `pnpm vitest run <one-file>`
    // gets a fresh CLI too and can never read a stale build.
    globalSetup: ['scripts/vitest-global-setup.ts'],
    // Default is 5, which would cap the concurrent CLI subprocess tests.
    // 8 leaves headroom for the ffmpeg and Remotion files in sibling workers.
    maxConcurrency: 8,
    sequence: { sequencer: SlowFilesFirstSequencer },
    include: contract
      ? ['src/**/*.contract.test.ts']
      : ['src/**/*.test.ts', 'remotion/**/*.test.ts'],
    exclude: contract
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'src/**/*.contract.test.ts'],
  },
})
