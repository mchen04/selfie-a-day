import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest (not generateSW) so the service worker is hand-written and
      // auditable: an update replaces the app shell and never touches stored photos.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null,
      minify: true,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Keep the app shell small.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // Dev SW is off: a stale precache in dev creates phantom bugs. Service-worker
      // behaviour is verified against `vite preview` (a real production build).
      devOptions: { enabled: false },
      manifest: {
        name: 'Selfie a Day',
        short_name: 'Selfie',
        description:
          'One selfie a day, aligned to yesterday with a ghost overlay. Your photos sync privately across your devices.',
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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { port: 4319, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
})
