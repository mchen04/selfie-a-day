/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

/**
 * The service worker caches the application shell and nothing else.
 *
 * It deliberately has no idea how to read a photo. Photos live in IndexedDB,
 * which this worker never opens, so an app update — including a full precache
 * purge — cannot touch them. `cleanupOutdatedCaches` only removes precache
 * buckets left by previous builds of this same worker.
 *
 * Navigations are served from the precached shell rather than the network, so a
 * cold start is instant and identical whether or not there is a connection.
 * That is the correct trade for an app that never needs the network again once
 * it has loaded.
 */

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Any in-app route (/, /timeline, /photo/<id>, /settings) resolves to the shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  // Sent only when the user accepts an update. Never automatic: swapping the
  // worker mid-capture would throw away the photo the user was lining up.
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

clientsClaim()
