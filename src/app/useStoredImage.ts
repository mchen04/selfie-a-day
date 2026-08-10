import { useEffect, useState } from 'react'
import { getMaster, getThumb } from '../storage/photos.ts'

export interface StoredImageState {
  url: string | null
  loading: boolean
  error: string | null
}

const IDLE: StoredImageState = { url: null, loading: false, error: null }
const LOADING: StoredImageState = { url: null, loading: true, error: null }

interface Entry {
  key: string
  url: string | null
  error: string | null
}

/**
 * Load a stored image and expose it as an object URL.
 *
 * Every URL created here is revoked when the id changes or the component
 * unmounts. That bookkeeping is the whole reason this is a hook: the timeline
 * mounts and unmounts hundreds of these while scrolling, and one missed revoke
 * pins a full decoded bitmap in memory until the tab is closed.
 *
 * The loaded entry is tagged with the key it belongs to, so a result arriving
 * after the caller moved on is ignored by rendering rather than by a race-prone
 * cancellation flag.
 */
export function useStoredImage(
  id: string | null | undefined,
  kind: 'master' | 'thumb',
  enabled = true,
): StoredImageState {
  const key = enabled && id ? `${kind}:${id}` : null
  const [entry, setEntry] = useState<Entry | null>(null)

  useEffect(() => {
    if (!key || !id) return

    let cancelled = false
    let created: string | null = null

    void (async () => {
      try {
        const stored = kind === 'master' ? await getMaster(id) : await getThumb(id)
        if (cancelled) return
        if (!stored) {
          setEntry({ key, url: null, error: 'This photo is missing from storage.' })
          return
        }
        created = URL.createObjectURL(new Blob([stored.bytes], { type: stored.mime }))
        if (cancelled) {
          URL.revokeObjectURL(created)
          created = null
          return
        }
        setEntry({ key, url: created, error: null })
      } catch (err) {
        if (cancelled) return
        setEntry({
          key,
          url: null,
          error: err instanceof Error ? err.message : 'Could not read this photo.',
        })
      }
    })()

    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [key, id, kind])

  if (!key) return IDLE
  if (entry?.key !== key) return LOADING
  return { url: entry.url, loading: false, error: entry.error }
}

/**
 * True once the element has been near the viewport at least once.
 *
 * Sticky by design: a thumbnail that unloads the moment it scrolls off screen
 * makes flicking back up flash grey placeholders, which reads as data loss in an
 * app whose entire promise is that nothing is lost.
 */
export function useNearViewport(
  ref: React.RefObject<Element | null>,
  rootMargin = '400px',
): boolean {
  // Without IntersectionObserver there is no way to know what is on screen, so
  // everything loads eagerly rather than never.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const element = ref.current
    if (!element || seen) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, rootMargin, seen])

  return seen
}
