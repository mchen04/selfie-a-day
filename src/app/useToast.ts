import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastMessage {
  text: string
  tone: ToastTone
  /** Bumped on every show so repeating the same text still re-announces it. */
  seq: number
}

export function useToast(timeoutMs = 2600) {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const show = useCallback(
    (text: string, tone: ToastTone = 'info') => {
      if (timer.current) clearTimeout(timer.current)
      seq.current += 1
      setToast({ text, tone, seq: seq.current })
      timer.current = setTimeout(() => setToast(null), timeoutMs)
    },
    [timeoutMs],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return { toast, show }
}
