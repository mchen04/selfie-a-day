import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: '/private/tmp/selfie-a-day-push-vitest',
  test: {
    environment: 'node',
    include: ['worker/test/push/**/*.test.ts'],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
})
