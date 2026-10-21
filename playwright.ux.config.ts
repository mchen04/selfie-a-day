import { defineConfig, devices } from '@playwright/test'

const phones = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]
const camera = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }

export default defineConfig({
  testDir: './tests/e2e/ux',
  testMatch: '**/*.ux.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/ux-runner',
  reporter: [['list'], ['./tests/e2e/ux/reporter.ts']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4319',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    timezoneId: 'UTC',
    locale: 'en-US',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    ...phones.map((viewport) => ({
      name: `webkit-${viewport.width}`,
      testIgnore: ['**/camera.ux.ts', '**/taps.ux.ts'],
      use: { ...devices['iPhone 14'], browserName: 'webkit' as const, viewport, isMobile: true, hasTouch: true },
    })),
    ...phones.map((viewport) => ({
      name: `camera-${viewport.width}`,
      testMatch: ['**/camera.ux.ts', '**/taps.ux.ts'],
      use: { ...devices['iPhone 14'], browserName: 'chromium' as const, viewport, isMobile: true, hasTouch: true, permissions: ['camera'], launchOptions: camera },
    })),
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, permissions: ['camera'], launchOptions: camera },
    },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run preview',
    url: 'http://localhost:4319',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
