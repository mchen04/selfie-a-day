import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const FIXTURE = resolve(import.meta.dirname, 'tests/fixtures/alignment-target.y4m')

/**
 * End-to-end tests run against a real production build served by `vite preview`.
 *
 * The service worker, the precache and the offline behaviour only exist in a
 * production build, and three of the gates this suite covers are about exactly
 * those. Testing the dev server would be testing something the user never runs.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4319',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'off',
    permissions: ['camera'],
    launchOptions: {
      args: [
        // A synthetic camera that always shows the same known target, so
        // alignment can be checked by reading pixels instead of by eye.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-video-capture=${FIXTURE}`,
        '--autoplay-policy=no-user-gesture-required',
        // /dev/shm is small on many machines; Chromium crashes there under the
        // memory pressure of many short-lived contexts each holding a video.
        '--disable-dev-shm-usage',
      ],
    },
  },

  projects: [
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium', isMobile: false, hasTouch: true },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: 'http://localhost:4319',
        /**
         * Never reuse. With reuse enabled, an already-running server on this
         * port makes Playwright skip the build entirely, so the whole suite
         * silently grades a stale bundle and reports green — the failure mode
         * that makes a passing suite worthless. Refusing to start is a loud,
         * safe failure; grading the wrong code is not.
         */
        reuseExistingServer: false,
        timeout: 180_000,
      },
})
