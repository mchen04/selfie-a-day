export async function offlineReadiness(): Promise<string> {
  const registration = await navigator.serviceWorker.getRegistration()
  if (registration?.active?.state !== 'activated') return 'not-activated'
  const name = (await caches.keys()).find((key) => key.startsWith('workbox-precache-') && key.endsWith(registration.scope))
  if (!name) return 'no-precache'
  const cached = new Set((await (await caches.open(name)).keys()).map((request) => {
    const url = new URL(request.url)
    url.searchParams.delete('__WB_REVISION__')
    return url.href
  }))
  const linked = Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]'))
    .map((element) => element instanceof HTMLScriptElement ? element.src : element.href)
  const loaded = performance.getEntriesByType('resource').map((entry) => new URL(entry.name, location.href))
    .filter((url) => url.origin === location.origin && /\.(?:js|css)$/.test(url.pathname)).map((url) => url.href)
  const required = new Set([new URL('index.html', registration.scope).href, ...linked, ...loaded])
  for (const url of required) {
    if (!cached.has(url)) return `precache-missing:${new URL(url).pathname}`
  }
  return 'ready'
}
