import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { providerValues, same, useBlockingSettings } from './useBlockingSettings.js'

const request = api.blocking
const date = (ts) => ts ? new Date(ts * 1000).toLocaleString() : '—'
const empty = { kind: 'block', number: '', match_type: 'exact', description: '', enabled: true }

export default function CallBlocking({ instances, showToast }) {
  const [scope, setScope] = useState('*')
  const generation = useRef(0)
  const [loadedScope, setLoadedScope] = useState(null)
  const settingsForm = useBlockingSettings(request, scope)
  const [providerDraft, setProviderDraft] = useState(null)
  const [providerSaved, setProviderSaved] = useState(null)
  const [providerState, setProviderState] = useState('Loading')
  const [providerError, setProviderError] = useState('')
  const providerEpoch = useRef(0)
  const providerDirty = providerDraft && !same(providerDraft, providerSaved)
  const [rules, setRules] = useState([])
  const [events, setEvents] = useState([])
  const [provider, setProvider] = useState(null)
  const [database, setDatabase] = useState(null)
  const [databaseVersion, setDatabaseVersion] = useState('')
  const [databaseLicense, setDatabaseLicense] = useState('')
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
      const [r, e, p] = await Promise.all([
        request('GET', '/rules?' + q),
        request('GET', '/events?' + new URLSearchParams({ ...(scope === '*' ? {} : { instance: scope }), limit: 50, offset })),
        request('GET', '/providers'),
      ])
      if (current !== generation.current) return
      setLoadedScope(scope)
      setRules(r.rules); setEvents(e.events); setProvider(p.providers[0]); setError('')
    } catch (e) { if (current === generation.current) setError(e.message) }
  }, [scope, kind, search, filter, offset])
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => { clearInterval(timer); ++generation.current } }, [load])
  useEffect(() => { setEditId(null); setForm({ ...empty, kind }); setOffset(0); setResult(null) }, [scope, kind])

  async function run(fn) {
    setBusy(true)
    try { await fn(); await load() } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (provider && providerDraft === null) {
      const values = providerValues(provider)
      setProviderDraft(values); setProviderSaved(values); setProviderState('Saved')
    }
  }, [provider])
  useEffect(() => () => { ++providerEpoch.current }, [])
  useEffect(() => {
    const warn = (event) => { if (settingsForm.dirty || providerDirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [settingsForm.dirty, providerDirty])
  function providerEdit(key, value) {
    setProviderDraft(p => ({ ...p, [key]: value })); setProviderState('Unsaved changes'); setProviderError('')
  }
  async function providerSave() {
    const id = ++providerEpoch.current
    setProviderState('Saving'); setProviderError('')
    try {
      await request('PUT', '/providers/saracroche', providerDraft)
      const result = await request('GET', '/providers')
      if (id !== providerEpoch.current) return
      const values = providerValues(result.providers[0])
      if (!same(values, providerDraft)) throw new Error('Server values differ from submitted provider settings')
      setProvider(result.providers[0]); setProviderDraft(values); setProviderSaved(values); setProviderState('Saved')
    } catch (e) { if (id === providerEpoch.current) { setProviderState('Error'); setProviderError(e.message) } }
  }
  const ready = loadedScope === scope
  const settings = settingsForm.server
  const effective = settings && settingsForm.draft ? { ...settings.global, ...settingsForm.draft } : null
  const saving = ['Saving', 'Loading'].includes(settingsForm.status)
  function config(key, value) {
    if (key === 'mode' && value === 'enforce' && effective.mode !== 'enforce' && !window.confirm('Enforce can reject legitimate incoming calls. Continue editing this mode? Changes apply only after Save changes.')) return
    settingsForm.edit(key, value)
  }
  function inherit(key) { settingsForm.edit(key, undefined) }
  const inheritance = (key) => scope === '*' ? 'Global default' : Object.hasOwn(settingsForm.draft, key) ? 'Line override' : 'Inherited from Global'
  const changed = (key) => !same(settingsForm.draft?.[key], settingsForm.saved?.[key]) ? ' · modified locally' : ''
  const savingProvider = ['Saving', 'Loading'].includes(providerState)

  return <div className="blocking-page">
    <div className="card blocking-card">
      <label>Settings and personal rules for
        <select value={scope} disabled={saving || busy} onChange={(e) => { if (!settingsForm.dirty || window.confirm('Discard unsaved settings for this scope?')) setScope(e.target.value) }}>
          <option value="*">Global — all lines</option>
          {instances.map((i) => <option key={i.id} value={String(i.id)}>{i.name || i.msisdn || i.id}</option>)}
        </select>
      </label>
      <p>Line settings inherit global values unless overridden. Global and line rules both apply; any personal whitelist match wins.</p>
      <details><summary>Access token (if configured by administrator)</summary>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('blocking-token', token); load(); if (!settingsForm.draft) settingsForm.discard() }} className="blocking-row">
          <input aria-label="Call Blocking access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-ghost">Connect</button>
        </form>
      </details>
      {error && <div role="alert" style={{ color: '#ef4444' }}>{error}</div>}
    </div>
    {settingsForm.error && <p role="alert">{settingsForm.error} {!settingsForm.draft && <button className="btn btn-ghost" onClick={settingsForm.discard}>Retry settings load</button>}</p>}
    {effective && <section className="card blocking-card" aria-label="Filtering settings">
      <h2>{scope === '*' ? 'Global filtering settings' : 'Line filtering settings'}</h2>
      <p>Global values are defaults for all SIMs. A line override affects only the selected SIM. Global Disabled is an emergency stop for every line.</p>
      <div className="blocking-save" aria-live="polite">
        <strong>{settingsForm.status === 'Error' ? 'Error — edits retained' : settingsForm.dirty && !saving ? 'Unsaved changes' : settingsForm.status === 'Unsaved changes' ? 'Saved' : settingsForm.status}</strong>
        <button className="btn btn-primary" disabled={!settingsForm.dirty || saving} onClick={async () => { await settingsForm.save(); await load() }}>Save changes</button>
        <button className="btn btn-ghost" disabled={saving || !settingsForm.dirty} onClick={settingsForm.discard}>Discard changes</button>
      </div>
      <fieldset disabled={saving}>
        <legend>Operation mode</legend>
        <p>Disabled: filtering is inactive. Monitor: evaluate and log rules, always allow calls. Enforce: reject matching incoming calls. Enabling a rule source does not enable enforcement.</p>
        <label>Operation mode<select aria-label="Operation mode" value={effective.mode} onChange={e => config('mode', e.target.value)}>
          <option value="disabled">Disabled</option><option value="monitor">Monitor</option><option value="enforce">Enforce</option>
        </select></label>
        <p>{inheritance('mode')}{changed('mode')}</p>
        {scope !== '*' && <button className="btn btn-ghost" onClick={() => inherit('mode')}>Inherit mode</button>}
        {scope !== '*' && settings.global.mode === 'disabled' && <p role="status">Global Disabled overrides this line's mode at runtime. Enable filtering globally first.</p>}
        {[
          ['arcep', 'ARCEP automated-calling ranges', 'French ranges reserved for automated calling. Legitimate businesses and services may use them; review Monitor results before enforcing.'],
          ['block_withheld', 'Withheld caller IDs', 'The caller deliberately hides their number. Doctors and other legitimate callers may do this.'],
          ['block_unavailable', 'Unavailable / invalid caller IDs', 'No usable number was supplied. Network or international routing issues may affect legitimate calls.'],
          ['saracroche', 'Enable Saracroche matching', 'Use the locally loaded database for this scope. This does not download data or enable Enforce.'],
        ].map(([key, label, help]) => <div key={key}>
          <label className="blocking-check"><input type="checkbox" checked={!!effective[key]} onChange={e => config(key, e.target.checked)} />{label}</label>
          <p>{help}<br />{inheritance(key)}{changed(key)}</p>
          {scope !== '*' && Object.hasOwn(settingsForm.draft, key) && <button className="btn btn-ghost" onClick={() => inherit(key)}>Inherit {label}</button>}
        </div>)}
      </fieldset>
      {scope !== '*' && <button className="btn btn-danger" disabled={saving} onClick={() => {
        if (window.confirm('Reset all line settings to Global? This changes the draft; use Save changes to apply.')) Object.keys(settingsForm.draft).forEach(inherit)
      }}>Reset all line settings to global</button>}
      <a href="https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation.html" target="_blank" rel="noreferrer">ARCEP numbering plan</a>
    </section>}
    {provider && providerDraft && <section className="card blocking-card" aria-label="Saracroche database settings">
      <h2>Saracroche database — shared by all SIMs</h2>
      <p>Matching is enabled separately above for Global or a line. Database connection and schedule below are shared by every line. Save connection changes before downloading.</p>
      <p>Lists from <a href="https://saracroche.org/" target="_blank" rel="noreferrer">Saracroche</a>. Author: <a href="https://cbouvat.com" target="_blank" rel="noreferrer">Camille Bouvat</a> / La bonne patte. License: <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0 — noncommercial, attribution and share-alike</a>. Commercial use needs separate terms.</p>
      <div className="blocking-save" aria-live="polite">
        <strong>{providerState === 'Error' ? 'Error — edits retained' : providerDirty && !savingProvider ? 'Unsaved changes' : providerState === 'Unsaved changes' ? 'Saved' : providerState}</strong>
        <button className="btn btn-primary" disabled={!providerDirty || savingProvider || busy} onClick={providerSave}>Save database changes</button>
        <button className="btn btn-ghost" disabled={!providerDirty || savingProvider || busy} onClick={() => { setProviderDraft(providerSaved); setProviderState('Saved'); setProviderError('') }}>Discard database changes</button>
      </div>
      <fieldset disabled={savingProvider || busy}>
        <legend>Database connection and updates</legend>
        <label>Database source<select aria-label="Saracroche source" value={providerDraft.source} onChange={e => providerEdit('source', e.target.value)}><option value="remote">Remote Saracroche database</option><option value="local">Local Android NDJSON file</option></select></label>
        {providerDraft.source === 'remote' ? <>
          <label className="blocking-check"><input type="checkbox" checked={providerDraft.auto_update} onChange={e => providerEdit('auto_update', e.target.checked)} />Automatic database updates</label>
          <p>Automatic downloads run only while Saracroche matching is enabled for at least one scope. They do not change the enforcement mode.</p>
          <label>Update interval (hours)<input type="number" min="1" max="720" value={providerDraft.interval_hours} onChange={e => providerEdit('interval_hours', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>Country codes<input aria-label="Saracroche country codes" value={providerDraft.country_codes} onChange={e => providerEdit('country_codes', e.target.value.toUpperCase())} /></label>
          <p>Comma-separated two-letter country codes, for example FR. List selection is applied at the next database update.</p>
          <button className="btn btn-ghost" onClick={() => providerEdit('selected_list_ids', null)}>Use Android default lists</button>
          <p>{providerDraft.selected_list_ids === null ? 'Android default selection' : 'Explicit list selection'} — allow/block priorities are preserved; lower priority values win.</p>
          {provider.catalog.map(list => <label className="blocking-check" key={list.id}>
            <input type="checkbox" checked={providerDraft.selected_list_ids === null ? (list.is_enabled_by_default ?? list.selected) : providerDraft.selected_list_ids.includes(list.id)} onChange={e => {
              const ids = providerDraft.selected_list_ids ?? provider.catalog.filter(i => i.is_enabled_by_default ?? i.selected).map(i => i.id)
              providerEdit('selected_list_ids', e.target.checked ? [...new Set([...ids, list.id])] : ids.filter(id => id !== list.id))
            }} />{list.name} — {list.type}, priority {list.priority}, {list.item_count} entries · {list.license}
          </label>)}
          {!provider.catalog.length && <p>Save settings, enable matching, then download to discover available lists.</p>}
        </> : <p>Automatic downloads are inactive for a local source. Import a new file to update the database.</p>}
      </fieldset>
      {providerError && <p role="alert">{providerError}</p>}
      <h3>Saved database status</h3>
      {!provider.entries && <p role="alert">Zero applicable Saracroche rules are loaded. Matching cannot block calls until a database is downloaded or imported.</p>}
      <p>{provider.entries} stored rules · Last success: {date(provider.last_success)} · Next scheduled attempt: {date(provider.next_update)}<br />Version: {provider.version || 'Not loaded'} · Failed attempts: {provider.failures}</p>
      <p>Loaded source: {provider.source_mode || 'none'} · License: {provider.license || 'Not supplied'}</p>
      {provider.coverage?.blocked_numbers != null && <p>{provider.coverage.block} blocking rules · {provider.coverage.allow} allow rules · {provider.coverage.blocked_numbers.toLocaleString()} distinct numbers covered (includes possibly unallocated numbers).</p>}
      {provider.error && <p role="alert">{provider.error} — last valid database retained; review settings and retry.</p>}
      {provider.connection.source === 'remote' ? <>
        <button className="btn btn-primary" disabled={busy || savingProvider || providerDirty || provider.updating || !provider.enabled} onClick={() => run(async () => {
          const result = await request('POST', '/providers/saracroche/update')
          if (!result.ok) throw new Error(result.error)
          showToast('Database updated')
        })}>{busy || provider.updating ? 'Updating database…' : 'Download / update now'}</button>
        {!provider.enabled && <p>Enable and save Saracroche matching before downloading.</p>}
      </> : <form className="blocking-row" onSubmit={e => { e.preventDefault(); run(async () => {
        if (!database || database.size > 64 * 1024 * 1024) throw new Error('Choose a database file up to 64 MiB')
        const query = new URLSearchParams({ version: databaseVersion, license_info: databaseLicense })
        const result = await request('POST', '/providers/saracroche/import?' + query, database)
        showToast(`Imported ${result.entries} rules. Matching and enforcement are controlled separately.`)
      }) }}>
        <input type="file" aria-label="Android database file" accept=".ndjson,.jsonl" onChange={e => setDatabase(e.target.files?.[0] || null)} />
        <input aria-label="Database version" placeholder="Version (optional)" value={databaseVersion} onChange={e => setDatabaseVersion(e.target.value)} />
        <input aria-label="Database license" placeholder="License / source" value={databaseLicense} onChange={e => setDatabaseLicense(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || providerDirty || savingProvider || !database}>Import database</button>
      </form>}
      <p>Personal rule Add/Edit/Remove, local lookup and database downloads are separate explicit actions; they do not save these forms.</p>
    </section>}
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
      <div className="blocking-row"><button className="btn btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="btn btn-ghost" disabled={events.length < 50} onClick={() => setOffset(offset + 50)}>Next</button><button className="btn btn-ghost" onClick={load}>Refresh operational data</button></div>
    </div>
  </div>
}
