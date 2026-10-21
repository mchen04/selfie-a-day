import { useApp } from '../../store-context.ts'

export function CloudStatus() {
  const { pendingIds, syncError, actions } = useApp()
  if (!pendingIds.length && !syncError) return null
  const photos = `${pendingIds.length} photo${pendingIds.length === 1 ? '' : 's'}`
  // A failed upload is queued, not uploading: say what is left and why it waits.
  const text = !pendingIds.length ? syncError : syncError ? `${photos} to upload · ${syncError}` : `Uploading ${photos}…`
  return (
    <div className="cloud-status" role="status" data-testid="cloud-status">
      <span>{text}</span>
      {syncError ? <button type="button" className="banner__link" onClick={() => void actions.retrySync()}>Retry</button> : null}
    </div>
  )
}
