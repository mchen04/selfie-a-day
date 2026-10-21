import { useApp } from '../../store-context.ts'

export function CloudStatus() {
  const { pendingIds, syncError, actions } = useApp()
  if (!pendingIds.length && !syncError) return null
  return (
    <div className="cloud-status" role="status" data-testid="cloud-status">
      <span>{pendingIds.length ? `${pendingIds.length} uploading${syncError ? ' · ' + syncError : '…'}` : syncError}</span>
      {syncError ? <button type="button" className="banner__link" onClick={() => void actions.retrySync()}>Retry</button> : null}
    </div>
  )
}
