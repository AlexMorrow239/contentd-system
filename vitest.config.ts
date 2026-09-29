import { defineConfig } from 'vitest/config'
import { SlowFilesFirstSequencer } from './scripts/vitest-sequencer.js'

const contract = process.env.CONTRACT === '1'

function include(): string[] {
  if (contract) return ['daemon/src/**/*.contract.test.ts']
  return [
    'daemon/src/**/*.test.ts',
    'daemon/testing/**/*.test.ts',
    'integrations/remotion/**/*.test.ts',
    'dashboard/**/*.test.{ts,tsx}',
  ]
}

function exclude(): string[] {
  const base = ['**/node_modules/**', '**/dist/**']
  if (contract) return base
  return [...base, 'daemon/src/**/*.contract.test.ts']
}

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Builds daemon/dist/ before any worker starts, so `pnpm vitest run <one-file>`
    // gets a fresh CLI too and can never read a stale build.
    globalSetup: ['scripts/vitest-global-setup.ts'],
    // Runs once per test FILE. Holds the teardown every file needs:
    // vi.unstubAllEnvs() and the daemon/testing/tmp.ts cleanup sweep.
    setupFiles: ['daemon/testing/setup.ts'],
    // Default is 5, which would cap the concurrent CLI subprocess tests.
    // 8 leaves headroom for the ffmpeg and Remotion files in sibling workers.
    maxConcurrency: 8,
    sequence: { sequencer: SlowFilesFirstSequencer },
    include: include(),
    exclude: exclude(),
    // Report-only: no `thresholds` key, so coverage never fails a run and
    // `pnpm test` pays no instrumentation cost. Collect with
    // `pnpm test:coverage`.
    //
    // Known blind spot: the ~42 runCli tests execute in spawned
    // `node daemon/dist/cli.js` subprocesses, which v8 coverage cannot see. daemon/src/cli.ts
    // therefore reads far lower than it is actually exercised.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // The point of the layer. Vitest defaults to reporting only files some
      // test imported, which hides a never-tested module entirely; naming
      // `include` reports every match, so those show up as an explicit 0%.
      // (This is what `all: true` did before Vitest 4 removed the option.)
      include: [
        'daemon/src/**/*.ts',
        'integrations/remotion/**/*.{ts,tsx}',
        'dashboard/lib/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        // Test scaffolding, not code under test.
        'daemon/testing/**',
        // Type-only modules: erased at runtime, so they can only ever read 0%.
        '**/types.ts',
        'daemon/src/remotion-types.ts',
        'integrations/remotion/index.ts',
      ],
    },
  },
})
