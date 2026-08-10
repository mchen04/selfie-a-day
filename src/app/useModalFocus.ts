import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  )
}

export function useModalFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    const layer = dialog?.parentElement
    if (!dialog || !layer) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousInert = new Map<HTMLElement, boolean>()
    let branch: HTMLElement = layer
    while (branch.parentElement && branch.parentElement !== document.body) {
      const parent = branch.parentElement
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue
        previousInert.set(sibling, sibling.inert)
        sibling.inert = true
      }
      branch = parent
    }

    const initialFocus = focusableElements(dialog)[0] ?? dialog
    initialFocus.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const elements = focusableElements(dialog)
      if (elements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = elements[0]!
      const last = elements.at(-1)!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      for (const [element, inert] of previousInert) element.inert = inert
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return dialogRef
}
