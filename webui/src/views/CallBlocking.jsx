import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const request = api.blocking
const date = (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—'
const empty = { kind: 'block', number: '', match_type: 'exact', description: '', enabled: true }

export default function CallBlocking({ instances, showToast }) {
  const [scope, setScope] = useState('*')
  const generation = useRef(0)
  const [loadedScope, setLoadedScope] = useState(null)
  const [settings, setSettings] = useState(null)
  const [rules, setRules] = useState([])
  const [events, setEvents] = useState([])
  const [provider, setProvider] = useState(null)
  const [form, setForm] = useState(empty)
  const [editId, setEditId] = useState(null)
  const [kind, setKind] = useState('block')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState('')
  const [testInstance, setTestInstance] = useState('')
  const [presentation, setPresentation] = useState('allowed')
  const [result, setResult] = useState(null)
  const [offset, setOffset] = useState(0)
  const [token, setToken] = useState(() => sessionStorage.getItem('blocking-token') || '')

  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const q = new URLSearchParams({ scope, kind, search })
      if (filter !== 'all') q.set('enabled', filter)
      const [s, r, e, p] = await Promise.all([
        request('GET', '/settings?' + new URLSearchParams({ scope })),
        request('GET', '/rules?' + q),
        request('GET', '/events?' + new URLSearchParams({ ...(scope === '*' ? {} : { instance: scope }), limit: 50, offset })),
        request('GET', '/providers'),
      ])
      if (current !== generation.current) return
      setLoadedScope(scope)
      setSettings(s); setRules(r.rules); setEvents(e.events); setProvider(p.providers[0]); setError('')
    } catch (e) { if (current === generation.current) setError(e.message) }
  }, [scope, kind, search, filter, offset])
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer) }, [load])
  useEffect(() => { setEditId(null); setForm({ ...empty, kind }); setOffset(0); setResult(null) }, [scope, kind])

  async function run(fn) {
    setBusy(true)
    try { await fn(); await load() } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  async function config(key, value) {
    const next = { ...(scope === '*' ? settings.global : settings.override), [key]: value }
    if (value === null) delete next[key]
    await run(() => request('PUT', '/settings?' + new URLSearchParams({ scope }), next))
  }
  const ready = loadedScope === scope
  const effective = ready ? settings?.effective : null

  return <div className="blocking-page">
    <div className="card blocking-card">
      <label>Settings and personal rules for
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="*">Global — all lines</option>
          {instances.map((i) => <option key={i.id} value={String(i.id)}>{i.name || i.msisdn || i.id}</option>)}
        </select>
      </label>
      <p>Line settings inherit global values unless overridden. Global and line rules both apply; any personal whitelist match wins.</p>
      <details><summary>Access token (if configured by administrator)</summary>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('blocking-token', token); load() }} className="blocking-row">
          <input aria-label="Call Blocking access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-ghost">Connect</button>
        </form>
      </details>
      {error && <div role="alert" style={{ color: '#ef4444' }}>{error}</div>}
    </div>
    {effective && <div className="card blocking-card">
      <h2>Operation mode</h2>
      <label className="blocking-check"><input type="checkbox" disabled={busy || (scope !== '*' && settings.global.mode === 'disabled')} checked={effective.mode !== 'disabled'}
        onChange={(e) => config('mode', e.target.checked ? 'monitor' : 'disabled')} />Filtering enabled</label>
      <select aria-label="Operation mode" disabled={busy || (scope !== '*' && settings.global.mode === 'disabled')} value={effective.mode} onChange={(e) => config('mode', e.target.value)}>
        <option value="disabled">Disabled — no filtering</option><option value="monitor">Monitor — log matches, allow calls</option>
        <option value="enforce">Enforce — reject matching calls (603 Decline)</option>
      </select>
      {scope !== '*' && <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => request('PUT', '/settings?' + new URLSearchParams({ scope }), {}))}>Reset all line settings to global</button>}
      {[
        ['arcep', 'Block ARCEP verified automated-calling ranges (optional; may include legitimate services)'],
        ['saracroche', 'Enable Saracroche matching when an authorized database becomes available'],
        ['block_withheld', 'Block withheld caller IDs'], ['block_unavailable', 'Block unavailable / invalid caller IDs'],
      ].map(([key, label]) => <div key={key} className="blocking-row">
        <label className="blocking-check"><input type="checkbox" disabled={busy} checked={effective[key]} onChange={(e) => config(key, e.target.checked)} />{label}</label>
        {scope !== '*' && Object.hasOwn(settings.override, key) && <button className="btn btn-ghost" disabled={busy} onClick={() => config(key, null)}>Inherit</button>}
      </div>)}
      {scope !== '*' && settings.global.mode === 'disabled' && <p>Global filtering is disabled for every line. Enable it in Global settings first.</p>}
      {scope !== '*' && <p>Mode: {Object.hasOwn(settings.override, 'mode') ? 'line override' : 'inherited from global'}.</p>}
      <a href="https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation.html" target="_blank" rel="noreferrer">ARCEP numbering plan — verified 2 November 2026</a>
    </div>}
    {provider && <div className="card blocking-card">
      <h2>Saracroche source and automatic updates (global)</h2>
      <strong>{provider.status === 'access_required' ? 'Access required — download unavailable' : 'Available'}</strong>
      <p>{provider.notice}</p>
      <div className="blocking-row">
        <label className="blocking-check"><input type="checkbox" disabled={busy} checked={!!provider.auto_update}
          onChange={(e) => run(() => request('PUT', '/providers/saracroche', { auto_update: e.target.checked, interval_hours: provider.interval_hours }))} />Automatic updates</label>
        <label>Interval (hours)<input type="number" min="1" max="720" value={provider.interval_hours}
          onChange={(e) => setProvider({ ...provider, interval_hours: e.target.value })} /></label>
        <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => request('PUT', '/providers/saracroche', { auto_update: !!provider.auto_update, interval_hours: Number(provider.interval_hours) }))}>Save schedule</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => {
          const r = await request('POST', '/providers/saracroche/update'); showToast(r.ok ? 'Database updated' : r.error)
        })}>Update now</button>
      </div>
      <p>Last success: {date(provider.last_success)} · Next attempt: {date(provider.next_update)}<br />Version: {provider.version || '—'} · Entries: {provider.entries} · Failed attempts: {provider.failures}</p>
      {provider.error && <p role="status">{provider.error}</p>}
      <a href="https://saracroche.org/fr/help/database-downloadable/" target="_blank" rel="noreferrer">Official database availability</a>
    </div>}
    <div className="card blocking-card">
      <h2>Personal {kind === 'block' ? 'blacklist' : 'whitelist'}</h2>
      <div className="blocking-row">
        <select aria-label="List" value={kind} onChange={(e) => setKind(e.target.value)}><option value="block">Blacklist</option><option value="allow">Whitelist</option></select>
        <input aria-label="Search rules" placeholder="Search number or description" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Rule status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All entries</option><option value="true">Enabled</option><option value="false">Disabled</option></select>
      </div>
      <form className="blocking-row" onSubmit={(e) => { e.preventDefault(); run(async () => {
        await request(editId ? 'PUT' : 'POST', '/rules' + (editId ? '/' + editId : ''), { ...form, scope, kind })
        setForm({ ...empty, kind }); setEditId(null)
      }) }}>
        <input required maxLength={128} aria-label="Number or prefix" placeholder="0612345678 or +33612" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
        <select aria-label="Match type" value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}><option value="exact">Complete number</option><option value="prefix">Explicit prefix</option></select>
        <input maxLength={500} aria-label="Description" placeholder="Optional description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <label className="blocking-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label>
        <button disabled={busy || !ready} className="btn btn-primary">{editId ? 'Save' : 'Add'}</button>
        {editId && <button type="button" className="btn btn-ghost" onClick={() => { setEditId(null); setForm({ ...empty, kind }) }}>Cancel</button>}
      </form>
      <p>French domestic numbers use +33; use international format for other countries and overseas territories. Select Prefix explicitly; wildcards and regular expressions are rejected.</p>
      {(ready ? rules : []).map((r) => <div key={r.id} className="blocking-row blocking-rule">
        <label className="blocking-check"><input type="checkbox" disabled={busy} checked={!!r.enabled} onChange={(e) => run(() => {
          const { id, ...body } = r; return request('PUT', '/rules/' + id, { ...body, enabled: e.target.checked })
        })} /><span className="mono">{r.number}{r.match_type === 'prefix' ? '…' : ''}</span></label>
        <span>{r.description}</span>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { const { id, scope: _, ...body } = r; setForm({ ...body, enabled: !!body.enabled }); setEditId(id) }}>Edit</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => run(() => request('DELETE', '/rules/' + r.id))}>Remove</button>
      </div>)}
      {!rules.length && <p>No matching entries.</p>}
    </div>
    <div className="card blocking-card">
      <h2>Test number locally</h2>
      <form className="blocking-row" onSubmit={(e) => { e.preventDefault(); run(async () => setResult(await request('POST', '/lookup', {
        instance: scope !== '*' ? scope : testInstance || String(instances[0]?.id || ''), number: test, presentation,
      }))) }}>
        {scope === '*' && <select aria-label="Test line" value={testInstance || String(instances[0]?.id || '')} onChange={(e) => setTestInstance(e.target.value)}>
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
        </select>}
        <input aria-label="Test number" placeholder="Number (empty for unavailable)" value={test} onChange={(e) => setTest(e.target.value)} />
        <select aria-label="Caller presentation" value={presentation} onChange={(e) => setPresentation(e.target.value)}><option value="allowed">Visible</option><option value="prohib">Withheld</option><option value="unavailable">Unavailable</option></select>
        <button className="btn btn-primary" disabled={busy || !instances.length}>Test</button>
      </form>
      {result && <p role="status">{result.action} · {result.mode} · {result.normalized || 'Unknown'} · {result.source} · {result.rule || '—'} · {result.reason}{result.would_block && result.action === 'allow' ? ' (would block in Enforce)' : ''}</p>}
    </div>
    <div className="card blocking-card">
      <h2>Blocked calls and decision history</h2>
      <div className="blocking-table"><table><thead><tr>{['Date / time', 'Calling number', 'Line', 'Source', 'Matched rule', 'Decision / reason'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{(ready ? events : []).map((e) => <tr key={e.id}><td>{date(e.ts)}</td><td>{e.peer || 'Unavailable'}</td><td>{instances.find((i) => String(i.id) === e.instance)?.name || e.instance}</td><td>{e.decision.source}</td><td>{e.decision.rule || '—'}</td><td>{e.decision.action} ({e.decision.mode}) — {e.decision.reason}</td></tr>)}</tbody></table></div>
      {!events.length && <p>No events.</p>}
      <div className="blocking-row"><button className="btn btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="btn btn-ghost" disabled={events.length < 50} onClick={() => setOffset(offset + 50)}>Next</button><button className="btn btn-ghost" onClick={load}>Refresh</button></div>
    </div>
  </div>
}
