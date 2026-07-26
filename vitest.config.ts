import { defineConfig } from 'vitest/config'

const contract = process.env.CONTRACT === '1'

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Builds dist/ before any worker starts, so `pnpm vitest run <one-file>`
    // gets a fresh CLI too and can never read a stale build.
    globalSetup: ['scripts/vitest-global-setup.ts'],
    include: contract ? ['src/**/*.contract.test.ts'] : ['src/**/*.test.ts', 'remotion/**/*.test.ts'],
    exclude: contract
      ? ['**/node_modules/**', '**/dist/**']
      : ['**/node_modules/**', '**/dist/**', 'src/**/*.contract.test.ts'],
  },
})
