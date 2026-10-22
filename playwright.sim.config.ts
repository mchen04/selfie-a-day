import { defineConfig } from '@playwright/test'

/**
 * The ten-day fake-clock simulation (`npm run sim`). Browsers are launched by
 * the simulation itself (persistent phone and desktop profiles), so there are
 * no projects here; days run one at a time in calendar order.
 */
export default defineConfig({
  testDir: './tests/sim',
  testMatch: /.*\.sim\.ts$/,
  globalSetup: './tests/sim/setup.ts',
  outputDir: 'test-results/sim-runner',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 12 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { headless: true },
  webServer: [
    {
      command: 'node tests/sim/api.ts',
      url: 'http://127.0.0.1:8787/api/auth/me',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run fixtures && npm run build && npm run preview',
      url: 'http://localhost:4319',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
