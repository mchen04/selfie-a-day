import { useState } from 'react'
import { useApp } from '../store-context.ts'

export function AccountScreen() {
  const { actions, storageError } = useApp()
  const [create, setCreate] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(storageError)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try { await actions.signIn(username.trim().toLowerCase(), password, create) }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in. Check your connection.') }
    finally { setBusy(false) }
  }

  return (
    <main className="screen account" data-testid="account-screen">
      <div className="account__intro">
        <div className="account__mark" aria-hidden="true"><span /><span /></div>
        <p className="account__eyebrow">A little change, every day</p>
        <h1>Selfie a Day</h1>
        <p>Your last photo becomes a faint ghost.<br />Line up, take a photo, see yourself change.</p>
      </div>
      <form className="account__form" onSubmit={(event) => void submit(event)}>
        <h2>{create ? 'Start your story' : 'Welcome back'}</h2>
        <label className="field">
          <span className="field__label">Username</span>
          <input className="text-input" name="username" autoComplete="username" autoCapitalize="none"
            autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="next" required
            minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input className="text-input" name="password" type="password" autoComplete={create ? 'new-password' : 'current-password'}
            enterKeyHint="go" required minLength={create ? 8 : 1} maxLength={256}
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button type="submit" className="btn btn--primary btn--wide" disabled={busy} data-testid="account-submit">
          {busy ? 'One moment…' : create ? 'Create account' : 'Sign in'}
        </button>
        <button type="button" className="account__switch" disabled={busy}
          onClick={() => { setCreate(!create); setError(null) }}>
          {create ? 'Have an account? Sign in' : 'New here? Create account'}
        </button>
        <p className="tiny muted">Your photos sync privately across your devices.</p>
      </form>
    </main>
  )
}
