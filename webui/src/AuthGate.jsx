import { useTranslation } from 'react-i18next'
import { tx, renderNotice, errorNotice } from './i18n/index.js'
import LanguageSelector from './i18n/LanguageSelector.jsx'
import React, { useEffect, useState } from 'react'
import App from './App.jsx'
import { api } from './api.js'

export default function AuthGate() {
  const { i18n } = useTranslation()
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => { if (!status?.authenticated) document.title = tx('common.documentTitle') }, [status?.authenticated, i18n.resolvedLanguage])
  const refresh = () => api.auth('GET', '/status').then(setStatus).catch((e) => setError(errorNotice(e)))
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
      } catch (err) { setError(errorNotice(err)) } finally { setBusy(false) }
    }}>
      <LanguageSelector />
      <h1 style={{ marginTop: 0, fontSize: 24 }}>VoWiFi Gateway</h1>
      <h2 style={{ fontSize: 18 }}>{!status ? tx("authentication.connecting") : status.configured ? tx("authentication.administratorLogin") : tx("authentication.createAdministrator")}</h2>
      {status && <>
        {!status.configured && <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>{tx("authentication.onTheServerRunSudoInstallShSetupCode")}</p>}
        {!status.configured && <label>{tx("authentication.setupCode")}<input autoComplete="off" type="password" value={code} onChange={(e) => setCode(e.target.value)} required /></label>}
        <label>{tx("authentication.username")}<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} /></label>
        <label>{tx("authentication.password")}<input type="password" autoComplete={status.configured ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={status.configured ? 1 : 12} maxLength={256} required /></label>
        <button className="btn btn-primary" disabled={busy} style={{ marginTop: 16, width: '100%' }}>{busy ? tx("authentication.pleaseWait") : status.configured ? tx("authentication.signIn") : tx("authentication.createAccount")}</button>
      </>}
      {error && <p role="alert" style={{ color: '#ef4444' }}>{renderNotice(error)}</p>}
    </form>
  </div>
}
