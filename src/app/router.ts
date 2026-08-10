import { useSyncExternalStore } from 'react'

/**
 * A ~40-line router instead of a routing library.
 *
 * Four screens do not justify a dependency whose weight would land in the
 * critical path of the one metric that matters here: how long it takes for the
 * camera to appear. It also lets us keep real history entries, so the iOS
 * back-swipe works in a standalone window that has no back button.
 */

export type Route =
  | { name: 'capture' }
  | { name: 'timeline' }
  | { name: 'photo'; id: string }
  | { name: 'settings' }
  | { name: 'trash' }

export function parseRoute(pathname: string): Route {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/')
  switch (segments[0]) {
    case 'timeline':
      return { name: 'timeline' }
    case 'settings':
      return { name: 'settings' }
    case 'trash':
      return { name: 'trash' }
    case 'photo':
      return segments[1] ? { name: 'photo', id: segments[1] } : { name: 'timeline' }
    default:
      return { name: 'capture' }
  }
}

export function routeToPath(route: Route): string {
  switch (route.name) {
    case 'timeline':
      return '/timeline'
    case 'settings':
      return '/settings'
    case 'trash':
      return '/trash'
    case 'photo':
      return `/photo/${route.id}`
    case 'capture':
      return '/'
  }
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function getSnapshot(): string {
  return window.location.pathname
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routeToPath(route)
  if (path === window.location.pathname && !options.replace) return
  if (options.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  emit()
}

export function goBack(fallback: Route = { name: 'capture' }): void {
  // A cold start straight into /photo/x has nothing to go back to; sending the
  // user to the camera beats trapping them on a screen with a dead back button.
  if (window.history.length > 1) window.history.back()
  else navigate(fallback, { replace: true })
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot, () => '/')
  return parseRoute(pathname)
}

/** `navigate` is already stable at module scope; the hook exists for symmetry. */
export function useNavigate(): typeof navigate {
  return navigate
}
