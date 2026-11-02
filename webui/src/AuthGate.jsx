import React, { useEffect, useState } from 'react'
import App from './App.jsx'
import { api } from './api.js'

export default function AuthGate() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const refresh = () => api.auth('GET', '/status').then(setStatus).catch((e) => setError(e.message))
  useEffect(() => {
    refresh()
    const expired = () => { setStatus((s) => ({ ...s, authenticated: false })); setPassword('') }
    window.addEventListener('vowifi-unauthorized', expired)
    return () => window.removeEventListener('vowifi-unauthorized', expired)
  }, [])
  if (status?.authenticated) return <App onLogout={async () => { await api.auth('POST', '/logout'); setPassword(''); await refresh() }} preview={status.preview} />
  return <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
    <form className="card" style={{ padding: 28, width: '100%', maxWidth: 420 }} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('')
      try {
        await api.auth('POST', status.configured ? '/login' : '/setup', {
          username, password, ...(!status.configured ? { setup_code: code } : {}),
        })
        setPassword(''); setCode(''); await refresh()
      } catch (err) { setError(err.message) } finally { setBusy(false) }
    }}>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>VoWiFi Gateway</h1>
      <h2 style={{ fontSize: 18 }}>{!status ? 'Connecting…' : status.configured ? 'Administrator login' : 'Create administrator'}</h2>
      {status && <>
        {!status.configured && <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>On the server, run sudo ./install.sh setup-code from the installation folder. Enter the one-time code below, then choose your login and password.</p>}
        {!status.configured && <label>Setup code<input autoComplete="off" type="password" value={code} onChange={(e) => setCode(e.target.value)} required /></label>}
        <label>Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} /></label>
        <label>Password<input type="password" autoComplete={status.configured ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={status.configured ? 1 : 12} maxLength={256} required /></label>
        <button className="btn btn-primary" disabled={busy} style={{ marginTop: 16, width: '100%' }}>{busy ? 'Please wait…' : status.configured ? 'Sign in' : 'Create account'}</button>
      </>}
      {error && <p role="alert" style={{ color: '#ef4444' }}>{error}</p>}
    </form>
  </div>
}
