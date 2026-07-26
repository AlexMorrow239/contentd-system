import { defineConfig } from 'vitest/config'
import { SlowFilesFirstSequencer } from './scripts/vitest-sequencer.js'

const contract = process.env.CONTRACT === '1'
// A third tier alongside CONTRACT: free but infrastructure-dependent (MinIO
// must be up). Kept out of the default run so `pnpm test` stays hermetic.
const storage = process.env.STORAGE === '1'

function include(): string[] {
  if (contract) return ['src/**/*.contract.test.ts']
  if (storage) return ['src/**/*.storage.test.ts']
  return ['src/**/*.test.ts', 'remotion/**/*.test.ts']
}

function exclude(): string[] {
  const base = ['**/node_modules/**', '**/dist/**']
  if (contract || storage) return base
  return [...base, 'src/**/*.contract.test.ts', 'src/**/*.storage.test.ts']
}

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
    include: include(),
    exclude: exclude(),
  },
})
