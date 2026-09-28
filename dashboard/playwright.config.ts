import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
  outputDir: '../test-results',
  reporter: 'list',
})
