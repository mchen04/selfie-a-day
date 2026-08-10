import type { ToastMessage } from '../useToast.ts'

export function Toast({ toast }: { toast: ToastMessage | null }) {
  return (
    <div className="toast-layer" aria-live="polite" role="status">
      {toast ? (
        <div key={toast.seq} className="toast" data-tone={toast.tone} data-testid="toast">
          {toast.text}
        </div>
      ) : null}
    </div>
  )
}
