import { useTranslation } from 'react-i18next'
import { tx, notice, renderNotice } from './i18n/index.js'
import LanguageSelector from './i18n/LanguageSelector.jsx'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api, connectWs } from './api.js'
import Dashboard from './views/Dashboard.jsx'
import Softphone from './views/Softphone.jsx'
import Messages from './views/Messages.jsx'
import SimConfig from './views/SimConfig.jsx'
import Settings from './views/Settings.jsx'
import Logs from './views/Logs.jsx'
import Esim from './views/Esim.jsx'
import CallBlocking from './views/CallBlocking.jsx'

// [key, label, icon, alwaysAvailable] — views not marked alwaysAvailable are disabled
// while no PC/SC reader is connected (they all operate on a physical SIM line).
const NAV = [
  ['dashboard', 'navigation.dashboard', '▤', true],
  ['softphone', 'navigation.softphone', '☎', false],
  ['messages', 'navigation.messages', '✉', false],
  ['sims', 'navigation.sims', '▣', false],
  ['esim', 'navigation.esim', '◎', false],
  ['blocking', 'navigation.blocking', '⛔', true],
  ['settings', 'navigation.settings', '⚙', true],
  ['logs', 'navigation.logs', '≣', true],
]

export default function App({ onLogout, preview }) {
  const { i18n } = useTranslation()
  const [view, setView] = useState('dashboard')
  const [instances, setInstances] = useState([])
  const [cards, setCards] = useState([])
  const [cardsKnown, setCardsKnown] = useState(false)  // first successful reader scan received
  const [selected, setSelected] = useState(null)
  const [toast, setToast] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'auto')
  const wsEvents = useRef({ handlers: new Set() })

  useEffect(() => { document.title = tx('navigation.' + view) + ' · VoWiFi Gateway' }, [view, i18n.resolvedLanguage])

  // Apply + persist theme. 'auto' follows the OS (falls back to light if unavailable).
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  const refresh = useCallback(async () => {
    try {
      const r = await api.instances()
      setInstances(r.instances)
      setSelected((s) => s != null && s !== ''
        ? String(s)
        : (r.instances[0] ? String(r.instances[0].id) : null))
    } catch (e) { /* manager may be starting */ }
    try { const c = await api.cards(); setCards(c.cards); setCardsKnown(true) } catch {}
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // live updates
  useEffect(() => {
    const off = connectWs((msg) => {
      if (msg.type === 'status') {
        // Keep the WHOLE status payload (reason, reason_code, retry, frozen, …), not just
        // state/label/detail — otherwise a live status push would drop the failure reason
        // that the initial /api/instances fetch showed, making the error banner vanish.
        const { type, instance, ...status } = msg
        setInstances((list) => list.map((i) => String(i.id) === String(instance)
          ? { ...i, status }
          : i))
      }
      if (msg.type === 'cards') { setCards(msg.cards); setCardsKnown(true) }
      if (msg.type === 'engine' && ['card_removed', 'reader_lost', 'reader_added', 'reader_removed'].includes(msg.event)) {
        const name = msg.args?.[0]
        showToast({
          card_removed: notice("navigation.simRemovedLineStopped"),
          reader_lost: notice("navigation.readerUnpluggedLineStopped"),
          reader_added: notice("navigation.cardReaderConnected", {value1: name ? `: ${name}` : ''}),
          reader_removed: notice("navigation.cardReaderDisconnected", {value1: name ? `: ${name}` : ''}),
        }[msg.event])
        refresh()
      }
      wsEvents.current.handlers.forEach((h) => h(msg))
      if (msg.type === 'sms' && msg.message?.direction === 'in') {
        showToast(notice("navigation.smsFrom", {
  value1: msg.message.peer
}))
      }
      if (msg.type === 'call' && msg.call?.direction === 'in') {
        showToast(notice("navigation.incomingCallFrom", {
  value1: msg.call.peer
}))
      }
    })
    return off
  }, [])

  const subscribe = useCallback((h) => {
    wsEvents.current.handlers.add(h)
    return () => wsEvents.current.handlers.delete(h)
  }, [])

  const toastTimer = useRef(null)
  const showToast = (m) => {
    clearTimeout(toastTimer.current)   // an older toast's timer must not clear this one
    setToast(m)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }

  // No PC/SC reader connected at all -> SIM-bound views are unusable; keep only
  // Dashboard / Settings / Logs and bounce back to the dashboard if needed.
  const noReaders = cardsKnown && cards.length === 0
  useEffect(() => {
    if (noReaders && !NAV.find(([k]) => k === view)?.[3]) setView('dashboard')
  }, [noReaders, view])

  const sel = instances.find((i) => String(i.id) === String(selected))

  const View = { dashboard: Dashboard, softphone: Softphone, messages: Messages, sims: SimConfig, esim: Esim, settings: Settings, blocking: CallBlocking, logs: Logs }[view]

  return (
    <div className="app-shell" style={{ display: 'flex', height: '100%' }}>
      <aside className="app-sidebar" style={{ width: 220, background: 'var(--sidebar)', borderRight: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="app-brand" style={{ fontWeight: 800, fontSize: 18, padding: '4px 8px 16px', letterSpacing: .5 }}>
          <span style={{ color: '#3b82f6' }}>Vo</span>WiFi<span style={{ color: 'var(--text-mute)', fontWeight: 500 }}> gateway</span>
        </div>
        {NAV.map(([k, labelKey, icon, always]) => {
          const label = tx(labelKey)
          const disabled = noReaders && !always
          return (
            <button className="app-nav-button" aria-label={`${icon} ${label}`} key={k} onClick={() => !disabled && setView(k)} disabled={disabled}
              title={disabled ? tx("navigation.noPcScReaderDetectedConnectACardReader") : undefined}
              style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
                background: view === k ? 'var(--active)' : 'transparent', color: view === k ? '#fff' : 'var(--text-dim)',
                opacity: disabled ? .35 : 1,
                border: 'none', fontSize: 14, fontWeight: 600, display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ width: 18, textAlign: 'center' }}>{icon}</span><span className="app-nav-label">{label}</span>
            </button>
          )
        })}
        <div className="app-theme-picker" style={{ marginTop: 'auto', display: 'flex', gap: 6, padding: 8 }}>
          {[['auto', '🌗'], ['light', '☀'], ['dark', '🌙']].map(([t, icon]) => (
            <button key={t} onClick={() => setTheme(t)} title={tx('common.theme.' + t)}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 8, cursor: 'pointer', fontSize: 11,
                fontWeight: 600, border: '1px solid var(--border)',
                background: theme === t ? 'var(--primary)' : 'transparent',
                color: theme === t ? '#fff' : 'var(--text-dim)',
              }}>{icon} {tx('common.theme.' + t)}</button>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={onLogout}>{tx("navigation.signOut")}</button>
        <div className="app-instance-count" style={{ fontSize: 11, color: 'var(--text-faint)', padding: '0 8px 8px' }}>{tx('common.simCount', {count: instances.length})}</div>
      </aside>

      <main className="app-main" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {preview && <div style={{ padding: 10, background: 'var(--active)', fontSize: 13 }}>{tx("navigation.localTestInstallationNoSimOrLiveCallsConnected")}</div>}
        <div className="app-header" style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 16, flexShrink: 0, padding: '24px 24px 0' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{tx('navigation.' + view)}</h1>
          <LanguageSelector />
          {/* per-page SIM selectors (SimSelector) handle multi-SIM switching on the views that
              operate on a single line — softphone / messages / logs / SIM config */}
        </div>
        {/* Single bounded scroll region. Document-flow views (Dashboard/Settings/Logs) scroll
            here; app-like views (Messages/Softphone) fill it with height:100% and scroll their
            own inner lists instead, so the page height never grows with list length. The
            padding also gives card outlines/shadows room so overflow:auto doesn't clip them
            (e.g. the Dashboard active-reader ring on the top/left edge). */}
        <div className="app-content" style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', padding: '6px 24px 24px' }}>
          {View && <View instances={instances} cards={cards} noReaders={noReaders} cardsKnown={cardsKnown} selected={sel} setSelected={setSelected} refresh={refresh} subscribe={subscribe} showToast={showToast} setView={setView} />}
        </div>
      </main>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: '#1d4ed8', color: '#fff', padding: '12px 18px', borderRadius: 12, boxShadow: '0 8px 30px #0008', fontWeight: 600 }}>
          {renderNotice(toast)}
        </div>
      )}
    </div>
  )
}
