import { useEffect, useState } from 'react'
import { useApp } from '../store-context.ts'

const UNDO_WINDOW_MS = 7_000

export function UndoTrash() {
  const { undoTrash, actions } = useApp()
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const { dismissUndo, restorePhoto } = actions

  useEffect(() => {
    if (!undoTrash) return
    const timer = window.setTimeout(dismissUndo, UNDO_WINDOW_MS)
    return () => window.clearTimeout(timer)
  }, [dismissUndo, undoTrash])

  if (!undoTrash) return null
  const message = failure?.id === undoTrash.id ? failure.message : 'Photo moved to Trash'

  return (
    <div className="undo-trash" role="status" data-testid="undo-trash">
      <span>{message}</span>
      <button
        type="button"
        className="undo-trash__action"
        onClick={() => {
          void restorePhoto(undoTrash.id).catch((err: unknown) => {
            setFailure({
              id: undoTrash.id,
              message: err instanceof Error ? err.message : 'The photo could not be restored.',
            })
          })
        }}
        data-testid="undo-trash-action"
      >
        Undo
      </button>
    </div>
  )
}
