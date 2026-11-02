import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { modes, sources, verdict } from './blockingPresentation.js'
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
  const [hasMore, setHasMore] = useState(false)
  const [historyLine, setHistoryLine] = useState('scope')
  const [historyDecision, setHistoryDecision] = useState('')
  const [historySource, setHistorySource] = useState('')
  const [historyPeriod, setHistoryPeriod] = useState('')
  const [ruleErrors, setRuleErrors] = useState({})
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const [token, setToken] = useState(() => sessionStorage.getItem('blocking-token') || '')

  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const q = new URLSearchParams({ scope, kind, search })
      if (filter !== 'all') q.set('enabled', filter)
      const eventScope = historyLine === 'scope' ? scope : historyLine
      const eventQuery = new URLSearchParams({ limit: 50, offset })
      if (eventScope !== '*') eventQuery.set('instance', eventScope)
      if (historyDecision) eventQuery.set('decision', historyDecision)
      if (historySource) eventQuery.set('source', historySource)
      if (historyPeriod) eventQuery.set('since', Math.floor(Date.now() / 1000) - Number(historyPeriod) * 3600)
      const [r, e, p] = await Promise.all([
        request('GET', '/rules?' + q),
        request('GET', '/events?' + eventQuery),
        request('GET', '/providers'),
      ])
      if (current !== generation.current) return
      setLoadedScope(scope)
      setRules(r.rules); setEvents(e.events); setHasMore(e.has_more ?? e.events.length === 50); setProvider(p.providers[0]); setError('')
    } catch (e) { if (current === generation.current) setError(e.message) }
  }, [scope, kind, search, filter, offset, historyLine, historyDecision, historySource, historyPeriod])
  const latestLoad = useRef(load)
  latestLoad.current = load
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => { clearInterval(timer); ++generation.current } }, [load])
  useEffect(() => { setEditId(null); setForm({ ...empty, kind }); setOffset(0); setResult(null); setRuleErrors({}) }, [scope, kind])
  useEffect(() => { setOffset(0) }, [historyLine, historyDecision, historySource, historyPeriod])

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
  async function updateDatabase() {
    setUpdating(true); setUpdateError('')
    try {
      const result = await request('POST', '/providers/saracroche/update')
      if (!result.ok) throw new Error(result.error)
      showToast('Database updated'); setError('')
    } catch (e) { setUpdateError(e.message) }
    finally { setUpdating(false); await latestLoad.current() }
  }
  async function saveRule(event) {
    event.preventDefault(); setBusy(true); setRuleErrors({})
    try {
      await request(editId ? 'PUT' : 'POST', '/rules' + (editId ? '/' + editId : ''), { ...form, scope, kind })
      setForm({ ...empty, kind }); setEditId(null); showToast('Personal rule saved'); await load()
    } catch (e) {
      const details = e.data?.detail
      const fields = Array.isArray(details) ? Object.fromEntries(details.map(item => [item.loc?.at(-1), item.msg]))
        : { [[409, 422].includes(e.status) ? 'number' : 'form']: e.message }
      setRuleErrors(fields)
    } finally { setBusy(false) }
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

  const live = settings?.effective
  const scopeName = scope === '*' ? 'Global — all lines' : instances.find(i => String(i.id) === scope)?.name || scope
  return <div className="blocking-page">
    <div className="card blocking-card">
      <div className="blocking-summary" aria-label="Saved filtering status">
        <strong>{scopeName}</strong>
        <span className={'blocking-badge ' + (live?.mode || 'disabled')}>{modes[live?.mode] || 'Loading'}</span>
        <span>Saracroche: {live?.saracroche ? 'On' : 'Off'}</span>
        <span>Database: {provider?.entries ? 'Loaded' : 'Not loaded'}</span>
        {(settingsForm.dirty || providerDirty) && <span className="blocking-badge monitor">Unsaved changes</span>}
      </div>
      <nav className="blocking-row" aria-label="Call Blocking sections">
        {[['filtering', 'Filtering'], ['saracroche', 'Saracroche'], ['personal-lists', 'Personal lists'], ['number-test', 'Number test'], ['call-history', 'Call history']].map(([id, text]) => <a key={id} href={'#' + id}>{text}</a>)}
      </nav>
      <label>Settings and personal rules for
        <select value={scope} disabled={saving || busy} onChange={(e) => { if (!settingsForm.dirty || window.confirm('Discard unsaved settings for this scope?')) setScope(e.target.value) }}>
          <option value="*">Global — all lines</option>
          {instances.map((i) => <option key={i.id} value={String(i.id)}>{i.name || i.msisdn || i.id}</option>)}
        </select>
      </label>
      <p>Global defaults apply unless a SIM overrides them. Personal whitelist matches take priority.</p>
      <details><summary>Access token (if configured by administrator)</summary>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('blocking-token', token); load(); if (!settingsForm.draft) settingsForm.discard() }} className="blocking-row">
          <input aria-label="Call Blocking access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-ghost">Connect</button>
        </form>
      </details>
      {error && <div role="alert" style={{ color: '#ef4444' }}>{error}</div>}
    </div>
    {settingsForm.error && <p role="alert">{settingsForm.error} {!settingsForm.draft && <button className="btn btn-ghost" onClick={settingsForm.discard}>Retry settings load</button>}</p>}
    {effective && <section id="filtering" className="card blocking-card" aria-label="Filtering settings">
      <h2>{scope === '*' ? 'Global filtering settings' : 'Line filtering settings'}</h2>
      <p>{scope === '*' ? 'Defaults for all SIMs. Global Disabled stops all filtering.' : 'Changes affect only this SIM; unmodified fields inherit Global.'}</p>
      <div className="blocking-save" aria-live="polite">
        <strong>{settingsForm.status === 'Error' ? 'Error — edits retained' : settingsForm.dirty && !saving ? 'Unsaved changes' : settingsForm.status === 'Unsaved changes' ? 'Saved' : settingsForm.status}</strong>
        <button className="btn btn-primary" disabled={!settingsForm.dirty || saving} onClick={async () => { await settingsForm.save(); await load() }}>Save changes</button>
        <button className="btn btn-ghost" disabled={saving || !settingsForm.dirty} onClick={settingsForm.discard}>Discard changes</button>
      </div>
      <fieldset disabled={saving}>
        <legend>Operation mode</legend>
        <p>Disabled: off · Monitor: log matches, allow calls · Enforce: reject matching calls.</p>
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
        ].map(([key, label, help]) => <div key={key} className="blocking-option">
          <label className="blocking-check"><input type="checkbox" role="switch" checked={!!effective[key]} onChange={e => config(key, e.target.checked)} />{label}</label>
          <small>{inheritance(key)}{changed(key)}</small><details className="blocking-help"><summary>About {label}</summary><p>{help}</p></details>
          {scope !== '*' && Object.hasOwn(settingsForm.draft, key) && <button className="btn btn-ghost" onClick={() => inherit(key)}>Inherit {label}</button>}
        </div>)}
      </fieldset>
      {scope !== '*' && <button className="btn btn-danger" disabled={saving} onClick={() => {
        if (window.confirm('Reset all line settings to Global? This changes the draft; use Save changes to apply.')) Object.keys(settingsForm.draft).forEach(inherit)
      }}>Reset all line settings to global</button>}
      <a className="blocking-subtle" href="https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation.html" target="_blank" rel="noreferrer">ARCEP numbering plan</a>
    </section>}
    {provider && providerDraft && <section id="saracroche" className="card blocking-card" aria-label="Saracroche database settings">
      <h2>Saracroche</h2>
      <p>Shared database for all SIMs; matching is scoped above. Downloads refresh data. Only Enforce rejects calls.</p>
      <div className="blocking-stat-grid" aria-label="Database status">
        {[
          ['Connection', updating || provider.updating ? 'Updating…' : provider.error ? 'Update failed — cached database retained' : provider.entries ? 'Database ready' : 'No database'],
          ['Stored rules', provider.entries.toLocaleString()],
          ['Blocking / allow', `${provider.coverage?.block ?? '—'} / ${provider.coverage?.allow ?? '—'}`],
          ['Covered numbers', provider.coverage?.blocked_numbers?.toLocaleString() ?? 'Not available'],
          ['Last success', date(provider.last_success)], ['Next update', date(provider.next_update)],
          ['Version', provider.version || 'Not loaded'], ['Automatic updates', provider.auto_update && provider.connection.source === 'remote' ? 'On' : 'Off'],
        ].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
      </div>
      {!provider.entries && <p role="alert">Zero applicable Saracroche rules. Download or import a database first.</p>}
      {provider.error && <p role="alert">{provider.error} — last valid database retained.</p>}
      {updateError && <p role="alert">{updateError}</p>}
      {provider.connection.source === 'remote' && <div className="blocking-row">
        <button className="btn btn-primary" disabled={busy || savingProvider || providerDirty || updating || provider.updating || !provider.enabled} onClick={updateDatabase}>{updating || provider.updating ? 'Updating database…' : 'Update database now'}</button>
        {!provider.enabled && <small>Enable filtering and save Saracroche matching first.</small>}
        {providerDirty && <small>Save database changes before updating.</small>}
      </div>}
      <details className="blocking-advanced"><summary>Database configuration{providerDirty ? ' — unsaved changes' : ''}</summary>
      <div className="blocking-save" aria-live="polite">
        <strong>{providerState === 'Error' ? 'Error — edits retained' : providerDirty && !savingProvider ? 'Unsaved changes' : providerState === 'Unsaved changes' ? 'Saved' : providerState}</strong>
        <button className="btn btn-primary" disabled={!providerDirty || savingProvider || busy || updating} onClick={providerSave}>Save database changes</button>
        <button className="btn btn-ghost" disabled={!providerDirty || savingProvider || busy || updating} onClick={() => { setProviderDraft(providerSaved); setProviderState('Saved'); setProviderError('') }}>Discard database changes</button>
      </div>
      <fieldset disabled={savingProvider || busy || updating}>
        <legend>Database connection and updates</legend>
        <label>Database source<select aria-label="Saracroche source" value={providerDraft.source} onChange={e => providerEdit('source', e.target.value)}><option value="remote">Remote Saracroche database</option><option value="local">Local Android NDJSON file</option></select></label>
        {providerDraft.source === 'remote' ? <>
          <label className="blocking-check"><input type="checkbox" checked={providerDraft.auto_update} onChange={e => providerEdit('auto_update', e.target.checked)} />Automatic database updates</label>
          <p>Downloads require saved matching enabled for at least one active scope.</p>
          <label>Update interval (hours)<input type="number" min="1" max="720" value={providerDraft.interval_hours} onChange={e => providerEdit('interval_hours', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>Country codes<input aria-label="Saracroche country codes" value={providerDraft.country_codes} onChange={e => providerEdit('country_codes', e.target.value.toUpperCase())} /></label>
          <p>Use comma-separated codes, e.g. FR,BE. List changes apply on the next download.</p>
          <button className="btn btn-ghost" onClick={() => providerEdit('selected_list_ids', null)}>Use Android default lists</button>
          <p>{providerDraft.selected_list_ids === null ? 'Android default selection' : 'Explicit list selection'} — allow/block priorities are preserved; lower priority values win.</p>
          <div className="blocking-table"><table><caption>Saracroche lists — selection for next download</caption><thead><tr>{['List', 'Type', 'Priority', 'Entries', 'Enabled'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
          {provider.catalog.map(list => <tr key={list.id}><td>{list.name}</td><td>{list.type}</td><td>{list.priority}</td><td>{list.item_count.toLocaleString()}</td><td><label className="blocking-check">
            <input aria-label={list.name} type="checkbox" checked={providerDraft.selected_list_ids === null ? (list.is_enabled_by_default ?? list.selected) : providerDraft.selected_list_ids.includes(list.id)} onChange={e => {
              const ids = providerDraft.selected_list_ids ?? provider.catalog.filter(i => i.is_enabled_by_default ?? i.selected).map(i => i.id)
              providerEdit('selected_list_ids', e.target.checked ? [...new Set([...ids, list.id])] : ids.filter(id => id !== list.id))
            }} /><span className="sr-only">{list.name}</span></label></td></tr>)}
          </tbody></table></div>
          {!provider.catalog.length && <p>Save settings, enable matching, then download to discover available lists.</p>}
        </> : <p>Automatic downloads are inactive for a local source. Import a new file to update the database.</p>}
      </fieldset>
      {providerError && <p role="alert">{providerError}</p>}
      {provider.connection.source === 'local' && <form className="blocking-row" onSubmit={e => { e.preventDefault(); run(async () => {
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
      </details>
      <details className="blocking-help"><summary>Source, author and license</summary><p>Lists from <a href="https://saracroche.org/" target="_blank" rel="noreferrer">Saracroche</a>. Author: <a href="https://cbouvat.com" target="_blank" rel="noreferrer">Camille Bouvat</a> / La bonne patte. <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0 — noncommercial, attribution and share-alike</a>. Commercial use requires separate terms.</p><p>Covered numbers include possibly unallocated numbers. The last loaded database remains active until a successful update.</p></details>
    </section>}
    <section id="personal-lists" className="card blocking-card" aria-label="Personal lists">
      <h2>Personal lists</h2>
      <div className="blocking-row">
        <div role="tablist" aria-label="Personal list type">{[['block', 'Blacklist'], ['allow', 'Whitelist']].map(([value, label]) => <button key={value} id={'list-tab-' + value} aria-controls="personal-rules-panel" tabIndex={kind === value ? 0 : -1} role="tab" aria-selected={kind === value} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'block' : e.key === 'End' ? 'allow' : kind === 'block' ? 'allow' : 'block'; setKind(next); document.getElementById('list-tab-' + next)?.focus() } }} className={'btn ' + (kind === value ? 'btn-primary' : 'btn-ghost')} disabled={busy} onClick={() => setKind(value)}>{label}</button>)}</div>
        <input aria-label="Search rules" placeholder="Search number or description" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Rule status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All entries</option><option value="true">Enabled</option><option value="false">Disabled</option></select>
      </div>
      <div id="personal-rules-panel" role="tabpanel" aria-labelledby={'list-tab-' + kind} className="blocking-rule-panel">
      <form className="blocking-row" onSubmit={saveRule}>
        <label className="blocking-field">Number or prefix<input disabled={busy} aria-invalid={!!ruleErrors.number} aria-describedby={ruleErrors.number ? 'rule-number-error' : undefined} required maxLength={128} aria-label="Number or prefix" placeholder="0612345678 or +33612" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />{ruleErrors.number && <small id="rule-number-error" role="alert">{ruleErrors.number}</small>}</label>
        <select disabled={busy} aria-label="Match type" value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}><option value="exact">Complete number</option><option value="prefix">Explicit prefix</option></select>
        <input disabled={busy} maxLength={500} aria-label="Description" placeholder="Optional description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <label className="blocking-check"><input disabled={busy} type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label>
        <button disabled={busy || !ready} className="btn btn-primary">{editId ? 'Save' : 'Add'}</button>
        {editId && <button type="button" className="btn btn-ghost" onClick={() => { setEditId(null); setForm({ ...empty, kind }) }}>Cancel</button>}
      </form>
      {Object.entries(ruleErrors).filter(([key]) => key !== 'number').map(([key, message]) => <p key={key} role="alert">{key === 'form' ? '' : key + ': '}{message}</p>)}
      <details className="blocking-help"><summary>Number format and list priority</summary><p>French domestic numbers use +33; use international format elsewhere. Select Prefix explicitly; wildcards and regex are rejected. Global and SIM rules both apply; a personal whitelist wins.</p></details>
      {(ready ? rules : []).map((r) => <div key={r.id} className="blocking-row blocking-rule">
        <label className="blocking-check"><input type="checkbox" disabled={busy} checked={!!r.enabled} onChange={(e) => run(() => {
          const { id, ...body } = r; return request('PUT', '/rules/' + id, { ...body, enabled: e.target.checked })
        })} /><span className="mono">{r.number}{r.match_type === 'prefix' ? '…' : ''}</span></label>
        <span>{r.match_type === 'prefix' ? 'Prefix' : 'Exact'} · {r.description || 'No description'}</span>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { const { id, scope: _, ...body } = r; setForm({ ...body, enabled: !!body.enabled }); setEditId(id) }}>Edit</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => run(async () => { await request('DELETE', '/rules/' + r.id); showToast('Personal rule deleted') })}>Delete</button>
      </div>)}
      {!rules.length && <p>No matching entries.</p>}
      </div>
    </section>
    <section id="number-test" className="card blocking-card" aria-label="Number test">
      <h2>Number test</h2>
      <form className="blocking-row" onSubmit={(e) => { e.preventDefault(); run(async () => setResult(await request('POST', '/lookup', {
        instance: scope !== '*' ? scope : testInstance || String(instances[0]?.id || ''), number: test, presentation,
      }))) }}>
        {scope === '*' && <select aria-label="Test line" value={testInstance || String(instances[0]?.id || '')} onChange={(e) => setTestInstance(e.target.value)}>
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
        </select>}
        <input aria-label="Test number" placeholder="Number (empty for unavailable)" value={test} onChange={(e) => setTest(e.target.value)} />
        <select aria-label="Caller presentation" value={presentation} onChange={(e) => setPresentation(e.target.value)}><option value="allowed">Visible</option><option value="prohib">Withheld</option><option value="unavailable">Unavailable</option></select>
        <button className="btn btn-primary" disabled={busy || !instances.length}>Test number</button>
      </form>
      {scope !== '*' && <p>Testing line: {scopeName}</p>}
      {result && <div role="status" className={'blocking-result ' + verdict(result).key}>
        <strong>{verdict(result).label}</strong>
        <p>{sources[result.source] || result.source} · {result.rule || 'No matched rule'} · {modes[result.mode]}<br />{result.normalized || 'Unknown caller'} — {result.reason}</p>
      </div>}
      <p>Local simulation only: no call is placed. This does not verify carrier call rejection.</p>
    </section>
    <section id="call-history" className="card blocking-card" aria-label="Call history">
      <h2>Call history</h2>
      <div className="blocking-row">
        <label>SIM<select aria-label="SIM" value={historyLine} onChange={e => setHistoryLine(e.target.value)}><option value="scope">Current scope</option><option value="*">All SIMs</option>{instances.map(i => <option key={i.id} value={String(i.id)}>{i.name || i.id}</option>)}</select></label>
        <label>Decision<select aria-label="Decision" value={historyDecision} onChange={e => setHistoryDecision(e.target.value)}><option value="">All decisions</option><option value="allowed">Allowed</option><option value="rejected">Rejected</option><option value="would_block">Would block in Enforce</option></select></label>
        <label>Rule source<select aria-label="Rule source" value={historySource} onChange={e => setHistorySource(e.target.value)}><option value="">All sources</option>{Object.entries(sources).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        <label>Time period<select aria-label="Time period" value={historyPeriod} onChange={e => setHistoryPeriod(e.target.value)}><option value="">All time</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option></select></label>
      </div>
      <p>Rejected = a reported reject decision; Monitor matches were allowed. History alone does not prove carrier behavior.</p>
      <div className="blocking-table blocking-history"><table><thead><tr>{['Date / time', 'Calling number', 'Line', 'Source', 'Matched rule', 'Decision / reason'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{(ready ? events : []).map((e) => <tr key={e.id}><td data-label="Date / time">{date(e.ts)}</td><td data-label="Calling number">{e.peer || 'Unavailable'}</td><td data-label="Line">{instances.find((i) => String(i.id) === e.instance)?.name || e.instance}</td><td data-label="Source">{sources[e.decision.source] || e.decision.source}</td><td data-label="Matched rule">{e.decision.rule || '—'}</td><td data-label="Decision / reason"><span className={'blocking-badge ' + verdict(e.decision).key}>{e.decision.action === 'reject' ? 'Rejected' : verdict(e.decision).label}</span><br />{modes[e.decision.mode]} — {e.decision.reason}</td></tr>)}</tbody></table></div>
      {!events.length && <p>No events.</p>}
      <div className="blocking-row"><span>Page {Math.floor(offset / 50) + 1}</span><button className="btn btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button className="btn btn-ghost" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>Next</button><button className="btn btn-ghost" onClick={load}>Refresh history</button></div>
    </section>
  </div>
}
