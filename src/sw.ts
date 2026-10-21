/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { installPushHandlers } from './push/worker.ts'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Any in-app route (/, /timeline, /photo/<id>, /settings) resolves to the shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api(?:\/|$)/] }))

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  // Sent only when the user accepts an update. Never automatic: swapping the
  // worker mid-capture would throw away the photo the user was lining up.
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

clientsClaim()
installPushHandlers(self)
