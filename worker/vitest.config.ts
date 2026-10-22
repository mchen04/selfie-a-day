import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'worker/test/support/.vite',
  test: {
    cache: false,
    environment: 'node',
    include: ['worker/test/{core,push}/**/*.test.ts'],
    restoreMocks: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
})
