import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const fixture = resolve(import.meta.dirname, 'tests/fixtures/alignment-target.y4m')
const chromium = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'] }

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, reporter: [['list']], timeout: 60_000, expect: { timeout: 15_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4319', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile', use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium', isMobile: false, hasTouch: true, permissions: ['camera'], launchOptions: chromium } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, permissions: ['camera'], launchOptions: chromium } },
    { name: 'webkit-iphone', testMatch: ['**/cloud/accounts.spec.ts', '**/cloud/layout.spec.ts', '**/cloud/legacy.spec.ts'], use: { ...devices['iPhone 14'], defaultBrowserType: 'webkit' } },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : [
    { command: 'node scripts/start-e2e-api.mjs', url: 'http://127.0.0.1:8787/api/auth/me', reuseExistingServer: false, timeout: 120_000 },
    { command: 'npm run fixtures && npm run build && npm run preview', url: 'http://localhost:4319', reuseExistingServer: false, timeout: 180_000 },
  ],
})
