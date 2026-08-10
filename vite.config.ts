import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

// The app is a static, server-less SPA: no API routes, no SSR, no analytics.
// Photos never leave the device, so there is nothing for a server to do.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest (not generateSW) so the service worker is hand-written and
      // auditable — gate 4 requires proving an SW update cannot touch photo data.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null,
      minify: true,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Photos live in IndexedDB, never in the precache. Keep this small.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // Dev SW is off: a stale precache in dev creates phantom bugs. Service-worker
      // behaviour is verified against `vite preview` (a real production build).
      devOptions: { enabled: false },
      manifest: {
        name: 'Selfie a Day',
        short_name: 'Selfie',
        description:
          'One selfie a day, aligned to yesterday with a ghost overlay. Everything stays on your device.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'fullscreen'],
        orientation: 'portrait',
        background_color: '#0a0a0c',
        theme_color: '#0a0a0c',
        categories: ['photo', 'lifestyle', 'health'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4319, strictPort: true },
})
