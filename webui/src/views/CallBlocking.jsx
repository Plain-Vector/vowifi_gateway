import { useTranslation } from 'react-i18next'
import { fieldNotice, tx, RichMessage, notice, renderNotice, statusLabel, decisionReason, localizedError, errorNotice, formatDate, formatNumber } from '../i18n/index.js'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { CommunicationSelect, communicationLabels } from './QuickBlockActions.jsx'
import SMSFilterHistory from './SMSFilterHistory.jsx'
import { modes, sources, verdict } from './blockingPresentation.js'
import { providerValues, same, useBlockingSettings } from './useBlockingSettings.js'

const request = api.blocking
const date = (ts) => ts ? formatDate(ts * 1000) : '—'
const empty = { communication: 'calls', kind: 'block', number: '', match_type: 'exact', description: '', enabled: true }

export default function CallBlocking({ instances, showToast }) {
  const localizationId = React.useId()
  useTranslation()
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
    } catch (e) { if (current === generation.current) setError(errorNotice(e)) }
  }, [scope, kind, search, filter, offset, historyLine, historyDecision, historySource, historyPeriod])
  const latestLoad = useRef(load)
  latestLoad.current = load
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => { clearInterval(timer); ++generation.current } }, [load])
  useEffect(() => { setEditId(null); setForm({ ...empty, kind }); setOffset(0); setResult(null); setRuleErrors({}) }, [scope, kind])
  useEffect(() => { setOffset(0) }, [historyLine, historyDecision, historySource, historyPeriod])

  async function run(fn) {
    setBusy(true)
    try { await fn(); await load() } catch (e) { setError(errorNotice(e)) }
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
      if (providerDraft.selected_list_ids?.length === 0) throw localizedError('blocking.selectAtLeastOneList')
      await request('PUT', '/providers/saracroche', providerDraft)
      const result = await request('GET', '/providers')
      if (id !== providerEpoch.current) return
      const values = providerValues(result.providers[0])
      if (!same(values, providerDraft)) throw localizedError("blocking.serverValuesDifferFromSubmittedProviderSettings")
      setProvider(result.providers[0]); setProviderDraft(values); setProviderSaved(values); setProviderState('Saved')
    } catch (e) { if (id === providerEpoch.current) { setProviderState('Error'); setProviderError(errorNotice(e)) } }
  }
  async function updateDatabase() {
    setUpdating(true); setUpdateError('')
    try {
      const result = await request('POST', '/providers/saracroche/update')
      if (!result.ok) throw new Error(result.error)
      showToast(notice("blocking.databaseUpdated")); setError('')
    } catch (e) { setUpdateError(errorNotice(e)) }
    finally { setUpdating(false); await latestLoad.current() }
  }
  async function saveRule(event) {
    event.preventDefault(); setBusy(true); setRuleErrors({})
    try {
      await request(editId ? 'PUT' : 'POST', '/rules' + (editId ? '/' + editId : ''), { ...form, scope, kind })
      setForm({ ...empty, kind }); setEditId(null); showToast(notice("blocking.personalRuleSaved")); await load()
    } catch (e) {
      const details = e.data?.detail
      const fields = Array.isArray(details) ? Object.fromEntries(details.map(item => [item.loc?.at(-1), fieldNotice(item)]))
        : { [[409, 422].includes(e.status) ? 'number' : 'form']: errorNotice(e) }
      setRuleErrors(fields)
    } finally { setBusy(false) }
  }
  const ready = loadedScope === scope
  const settings = settingsForm.server
  const effective = settings && settingsForm.draft ? { ...settings.global, ...settingsForm.draft } : null
  const saving = ['Saving', 'Loading'].includes(settingsForm.status)
  function config(key, value) {
    if (key === 'mode' && value === 'enforce' && effective.mode !== 'enforce' && !window.confirm(tx("blocking.enforceCanRejectLegitimateIncomingCallsContinueEditingThis"))) return
    settingsForm.edit(key, value)
  }
  function inherit(key) { settingsForm.edit(key, undefined) }
  const inheritance = (key) => scope === '*' ? tx("blocking.globalDefault") : Object.hasOwn(settingsForm.draft, key) ? tx("blocking.lineOverride") : tx("blocking.inheritedFromGlobal")
  const changed = (key) => !same(settingsForm.draft?.[key], settingsForm.saved?.[key]) ? tx("blocking.modifiedLocally") : ''
  const savingProvider = ['Saving', 'Loading'].includes(providerState)

  const live = settings?.effective
  const scopeName = scope === '*' ? tx("blocking.globalAllLines") : instances.find(i => String(i.id) === scope)?.name || scope
  return <div className="blocking-page">
    <div className="card blocking-card">
      <div className="blocking-summary" aria-label={tx("blocking.savedFilteringStatus")}>
        <strong>{scopeName}</strong>
        <span className={'blocking-badge ' + (live?.mode || 'disabled')}>{tx(modes[live?.mode]) || tx("blocking.loading")}</span>
        <span>{tx('sms.mode')}: {tx(modes[live?.sms_mode || 'disabled'])}</span>
        <span>{tx("blocking.saracroche", {value1: live?.saracroche ? tx("blocking.on") : tx("blocking.off")})}</span>
        <span>{tx("blocking.database", {value1: provider?.entries ? tx("blocking.loaded") : tx("blocking.notLoaded")})}</span>
        {(settingsForm.dirty || providerDirty) && <span className="blocking-badge monitor">{tx("blocking.unsavedChanges")}</span>}
      </div>
      <nav className="blocking-row" aria-label={tx("blocking.callBlockingSections")}>
        {[['filtering', tx("blocking.filtering")], ['saracroche', tx("blocking.saracroche2")], ['personal-lists', tx("blocking.personalLists")], ['number-test', tx("blocking.numberTest")], ['call-history', tx("blocking.callHistory")], ['sms-history', tx('sms.history')]].map(([id, text]) => <a key={id} href={'#' + id}>{text}</a>)}
      </nav>
      <label>{tx("blocking.settingsAndPersonalRulesFor")}<select value={scope} disabled={saving || busy} onChange={(e) => { if (!settingsForm.dirty || window.confirm(tx("blocking.discardUnsavedSettingsForThisScope"))) setScope(e.target.value) }}>
          <option value="*">{tx("blocking.globalAllLines")}</option>
          {instances.map((i) => <option key={i.id} value={String(i.id)}>{i.name || i.msisdn || i.id}</option>)}
        </select>
      </label>
      <p>{tx("blocking.globalDefaultsApplyUnlessASimOverridesThemPersonal")}</p>
      <details><summary>{tx("blocking.accessTokenIfConfiguredByAdministrator")}</summary>
        <form onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('blocking-token', token); load(); if (!settingsForm.draft) settingsForm.discard() }} className="blocking-row">
          <input aria-label={tx("blocking.callBlockingAccessToken")} type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-ghost">{tx("blocking.connect")}</button>
        </form>
      </details>
      {error && <div role="alert" style={{ color: '#ef4444' }}>{renderNotice(error)}</div>}
    </div>
    {settingsForm.error && <p role="alert">{renderNotice(settingsForm.error)} {!settingsForm.draft && <button className="btn btn-ghost" onClick={settingsForm.discard}>{tx("blocking.retrySettingsLoad")}</button>}</p>}
    {effective && <section id="filtering" className="card blocking-card" aria-label={tx("blocking.filteringSettings")}>
      <h2>{scope === '*' ? tx("blocking.globalFilteringSettings") : tx("blocking.lineFilteringSettings")}</h2>
      <p>{scope === '*' ? tx("blocking.defaultsForAllSimsGlobalDisabledStopsAllFiltering") : tx("blocking.changesAffectOnlyThisSimUnmodifiedFieldsInheritGlobal")}</p>
      <div className="blocking-save" aria-live="polite">
        <strong>{settingsForm.status === 'Error' ? tx("blocking.errorEditsRetained") : settingsForm.dirty && !saving ? tx("blocking.unsavedChanges") : settingsForm.status === 'Unsaved changes' ? tx("blocking.saved") : statusLabel('saveStatus', settingsForm.status)}</strong>
        <button className="btn btn-primary" disabled={!settingsForm.dirty || saving} onClick={async () => { await settingsForm.save(); await load() }}>{tx("blocking.saveChanges")}</button>
        <button className="btn btn-ghost" disabled={saving || !settingsForm.dirty} onClick={settingsForm.discard}>{tx("blocking.discardChanges")}</button>
      </div>
      <fieldset disabled={saving}>
        <legend>{tx("blocking.operationMode")}</legend>
        <p>{tx("blocking.disabledOffMonitorLogMatchesAllowCallsEnforceReject")}</p>
        <label>{tx("blocking.operationMode")}<select aria-label={tx("blocking.operationMode")} value={effective.mode} onChange={e => config('mode', e.target.value)}>
          <option value="disabled">{tx("blocking.disabled")}</option><option value="monitor">{tx("blocking.monitor")}</option><option value="enforce">{tx("blocking.enforce")}</option>
        </select></label>
        <p>{inheritance('mode')}{changed('mode')}</p>
        {scope !== '*' && <button className="btn btn-ghost" onClick={() => inherit('mode')}>{tx("blocking.inheritMode")}</button>}
        <label>{tx('sms.filteringMode')}<select aria-label={tx('sms.filteringMode')} value={effective.sms_mode || 'disabled'} onChange={e => {
          if (e.target.value !== 'enforce' || window.confirm(tx('sms.enforceConfirm'))) config('sms_mode', e.target.value)
        }}>{['disabled','monitor','enforce'].map(value => <option key={value} value={value}>{tx(modes[value])}</option>)}</select></label>
        <p>{tx('sms.modeHelp')} {inheritance('sms_mode')}{changed('sms_mode')}</p>
        {scope !== '*' && <button className="btn btn-ghost" onClick={() => inherit('sms_mode')}>{tx('sms.inherit')}</button>}
        {[
          ['arcep', tx("blocking.arcepAutomatedCallingRanges"), tx("blocking.frenchRangesReservedForAutomatedCallingLegitimateBusinessesAnd")],
          ['block_withheld', tx("blocking.withheldCallerIds"), tx("blocking.theCallerDeliberatelyHidesTheirNumberDoctorsAndOther")],
          ['block_unavailable', tx("blocking.unavailableInvalidCallerIds"), tx("blocking.noUsableNumberWasSuppliedNetworkOrInternationalRouting")],
          ['saracroche', tx("blocking.enableSaracrocheMatching"), tx("blocking.useTheLocallyLoadedDatabaseForThisScopeThis")],
        ].map(([key, label, help]) => <div key={key} className="blocking-option">
          <label className="blocking-check"><input type="checkbox" role="switch" checked={!!effective[key]} onChange={e => config(key, e.target.checked)} />{label}</label>
          <small>{inheritance(key)}{changed(key)}</small><details className="blocking-help"><summary>{tx("blocking.about", {label: label})}</summary><p>{help}</p></details>
          {scope !== '*' && Object.hasOwn(settingsForm.draft, key) && <button className="btn btn-ghost" onClick={() => inherit(key)}>{tx("blocking.inherit", {label: label})}</button>}
        </div>)}
      </fieldset>
      {scope !== '*' && <button className="btn btn-danger" disabled={saving} onClick={() => {
        if (window.confirm(tx("blocking.resetAllLineSettingsToGlobalThisChangesThe"))) Object.keys(settingsForm.draft).forEach(inherit)
      }}>{tx("blocking.resetAllLineSettingsToGlobal")}</button>}
      <a className="blocking-subtle" href="https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation.html" target="_blank" rel="noreferrer">{tx("blocking.arcepNumberingPlan")}</a>
    </section>}
    {provider && providerDraft && <section id="saracroche" className="card blocking-card" aria-label={tx("blocking.saracrocheDatabaseSettings")}>
      <h2>Saracroche</h2>
      <p>{tx("blocking.sharedDatabaseForAllSimsMatchingIsScopedAbove")}</p>
      <div className="blocking-stat-grid" aria-label={tx("blocking.databaseStatus")}>
        {[
          ['Connection', updating || provider.updating ? tx("blocking.updating") : provider.error ? tx("blocking.updateFailedCachedDatabaseRetained") : provider.entries ? tx("blocking.databaseReady") : tx("blocking.noDatabase")],
          [tx("blocking.storedRules"), formatNumber(provider.entries)],
          [tx("blocking.blockingAllow"), `${provider.coverage?.block != null ? formatNumber(provider.coverage.block) : '—'} / ${provider.coverage?.allow != null ? formatNumber(provider.coverage.allow) : '—'}`],
          [tx("blocking.coveredNumbers"), (provider.coverage?.blocked_numbers != null ? formatNumber(provider.coverage.blocked_numbers) : undefined) ?? tx("blocking.notAvailable")],
          [tx("blocking.lastSuccess"), date(provider.last_success)], [tx("blocking.nextUpdate"), date(provider.next_update)],
          ['Version', provider.version || tx("blocking.notLoaded")], [tx("blocking.automaticUpdates"), provider.auto_update && provider.connection.source === 'remote' ? tx("blocking.on") : tx("blocking.off")],
        ].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
      </div>
      {!provider.entries && <p role="alert">{tx("blocking.zeroApplicableSaracrocheRulesDownloadOrImportADatabase")}</p>}
      {provider.error && <p role="alert">{tx("blocking.lastValidDatabaseRetained", {error: provider.error})}</p>}
      {updateError && <p role="alert">{renderNotice(updateError)}</p>}
      {provider.connection.source === 'remote' && <div className="blocking-row">
        <button className="btn btn-primary" disabled={busy || savingProvider || providerDirty || updating || provider.updating || !provider.enabled} onClick={updateDatabase}>{updating || provider.updating ? tx("blocking.updatingDatabase") : tx("blocking.updateDatabaseNow")}</button>
        {!provider.enabled && <small>{tx("blocking.enableFilteringAndSaveSaracrocheMatchingFirst")}</small>}
        {providerDirty && <small>{tx("blocking.saveDatabaseChangesBeforeUpdating")}</small>}
      </div>}
      <details className="blocking-advanced"><summary>{tx("blocking.databaseConfiguration", {value1: providerDirty ? tx("blocking.unsavedChanges2") : ''})}</summary>
      <div className="blocking-save" aria-live="polite">
        <strong>{providerState === 'Error' ? tx("blocking.errorEditsRetained") : providerDirty && !savingProvider ? tx("blocking.unsavedChanges") : providerState === 'Unsaved changes' ? tx("blocking.saved") : statusLabel('saveStatus', providerState)}</strong>
        <button className="btn btn-primary" disabled={!providerDirty || savingProvider || busy || updating} onClick={providerSave}>{tx("blocking.saveDatabaseChanges")}</button>
        <button className="btn btn-ghost" disabled={!providerDirty || savingProvider || busy || updating} onClick={() => { setProviderDraft(providerSaved); setProviderState('Saved'); setProviderError('') }}>{tx("blocking.discardDatabaseChanges")}</button>
      </div>
      <fieldset disabled={savingProvider || busy || updating}>
        <legend>{tx("blocking.databaseConnectionAndUpdates")}</legend>
        <label>{tx("blocking.databaseSource")}<select aria-label={tx("blocking.saracrocheSource")} value={providerDraft.source} onChange={e => providerEdit('source', e.target.value)}><option value="remote">{tx("blocking.remoteSaracrocheDatabase")}</option><option value="local">{tx("blocking.localAndroidNdjsonFile")}</option></select></label>
        {providerDraft.source === 'remote' ? <>
          <label className="blocking-check"><input type="checkbox" checked={providerDraft.auto_update} onChange={e => providerEdit('auto_update', e.target.checked)} />{tx("blocking.automaticDatabaseUpdates")}</label>
          <p>{tx("blocking.downloadsRequireSavedMatchingEnabledForAtLeastOne")}</p>
          <label>{tx("blocking.updateIntervalHours")}<input type="number" min="1" max="720" value={providerDraft.interval_hours} onChange={e => providerEdit('interval_hours', e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label>{tx("blocking.countryCodes")}<input aria-label={tx("blocking.saracrocheCountryCodes")} value={providerDraft.country_codes} onChange={e => providerEdit('country_codes', e.target.value.toUpperCase())} /></label>
          <p>{tx("blocking.useCommaSeparatedCodesEGFrBeList")}</p>
          <button className="btn btn-ghost" onClick={() => providerEdit('selected_list_ids', null)}>{tx("blocking.useAndroidDefaultLists")}</button>
          <p>{tx("blocking.allowBlockPrioritiesArePreservedLowerPriorityValuesWin", {value1: providerDraft.selected_list_ids === null ? tx("blocking.androidDefaultSelection") : tx("blocking.explicitListSelection")})}</p>
          <div className="blocking-table"><table><caption>{tx("blocking.saracrocheListsSelectionForNextDownload")}</caption><thead><tr>{[tx('blocking.listHeading'), tx('blocking.typeHeading'), tx('blocking.priorityHeading'), tx('blocking.entriesHeading'), tx('blocking.enabled')].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
          {provider.catalog.map(list => <tr key={list.id}><td>{list.name}</td><td>{statusLabel('listType', list.type)}</td><td>{formatNumber(list.priority)}</td><td>{formatNumber(list.item_count)}</td><td><label className="blocking-check">
            <input aria-label={list.name} type="checkbox" checked={providerDraft.selected_list_ids === null ? (list.is_enabled_by_default ?? list.selected) : providerDraft.selected_list_ids.includes(list.id)} onChange={e => {
              const ids = providerDraft.selected_list_ids ?? provider.catalog.filter(i => i.is_enabled_by_default ?? i.selected).map(i => i.id)
              providerEdit('selected_list_ids', e.target.checked ? [...new Set([...ids, list.id])] : ids.filter(id => id !== list.id))
            }} /><span className="sr-only">{list.name}</span></label></td></tr>)}
          </tbody></table></div>
          {!provider.catalog.length && <p>{tx("blocking.saveSettingsEnableMatchingThenDownloadToDiscoverAvailable")}</p>}
        </> : <p>{tx("blocking.automaticDownloadsAreInactiveForALocalSourceImport")}</p>}
      </fieldset>
      {providerError && <p role="alert">{renderNotice(providerError)}</p>}
      {provider.connection.source === 'local' && <form className="blocking-row" onSubmit={e => { e.preventDefault(); run(async () => {
        if (!database || database.size > 64 * 1024 * 1024) throw new Error('Choose a database file up to 64 MiB')
        const query = new URLSearchParams({ version: databaseVersion, license_info: databaseLicense })
        const result = await request('POST', '/providers/saracroche/import?' + query, database)
        showToast(notice("blocking.importedValue0RulesMatchingAndEnforcementAreControlledSeparately",{value0:result.entries}))
      }) }}>
        <input type="file" aria-label={tx("blocking.androidDatabaseFile")} accept=".ndjson,.jsonl" onChange={e => setDatabase(e.target.files?.[0] || null)} />
        <input aria-label={tx("blocking.databaseVersion")} placeholder={tx("blocking.versionOptional")} value={databaseVersion} onChange={e => setDatabaseVersion(e.target.value)} />
        <input aria-label={tx("blocking.databaseLicense")} placeholder={tx("blocking.licenseSource")} value={databaseLicense} onChange={e => setDatabaseLicense(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || providerDirty || savingProvider || !database}>{tx("blocking.importDatabase")}</button>
      </form>}
      </details>
      <details className="blocking-help"><summary>{tx("blocking.sourceAuthorAndLicense")}</summary><p><RichMessage id="blocking.listsFromSaracrocheAuthorCamilleBouvatLaBonnePatte" components={[<a href="https://saracroche.org/" target="_blank" rel="noreferrer">Saracroche</a>, <a href="https://cbouvat.com" target="_blank" rel="noreferrer">Camille Bouvat</a>, <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0 — noncommercial, attribution and share-alike</a>]} /></p><p>{tx("blocking.coveredNumbersIncludePossiblyUnallocatedNumbersTheLastLoaded")}</p></details>
    </section>}
    <section id="personal-lists" className="card blocking-card" aria-label={tx("blocking.personalLists")}>
      <h2>{tx("blocking.personalLists")}</h2>
      <div className="blocking-row">
        <div role="tablist" aria-label={tx("blocking.personalListType")}>{[['block', tx("blocking.blacklist")], ['allow', tx("blocking.whitelist")]].map(([value, label]) => <button key={value} id={'list-tab-' + value} aria-controls="personal-rules-panel" tabIndex={kind === value ? 0 : -1} role="tab" aria-selected={kind === value} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'block' : e.key === 'End' ? 'allow' : kind === 'block' ? 'allow' : 'block'; setKind(next); document.getElementById('list-tab-' + next)?.focus() } }} className={'btn ' + (kind === value ? 'btn-primary' : 'btn-ghost')} disabled={busy} onClick={() => setKind(value)}>{label}</button>)}</div>
        <input aria-label={tx("blocking.searchRules")} placeholder={tx("blocking.searchNumberOrDescription")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label={tx("blocking.ruleStatus")} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">{tx("blocking.allEntries")}</option><option value="true">{tx("blocking.enabled")}</option><option value="false">{tx("blocking.disabled")}</option></select>
      </div>
      <div id="personal-rules-panel" role="tabpanel" aria-labelledby={'list-tab-' + kind} className="blocking-rule-panel">
      <form className="blocking-row" onSubmit={saveRule}>
        <label className="blocking-field">{tx("blocking.numberOrPrefix")}<input disabled={busy} aria-invalid={!!ruleErrors.number} aria-describedby={ruleErrors.number ? 'rule-number-error' : undefined} required maxLength={128} aria-label={tx("blocking.numberOrPrefix")} placeholder={tx("blocking.0612345678Or33612")} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />{ruleErrors.number && <small id="rule-number-error" role="alert">{renderNotice(ruleErrors.number)}</small>}</label>
        <select id={localizationId + '-1'} disabled={busy} aria-label={tx("blocking.matchType")} value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}><option value="exact">{tx("blocking.completeNumber")}</option><option value="prefix">{tx("blocking.explicitPrefix")}</option></select>
        <CommunicationSelect value={form.communication || 'calls'} disabled={busy} onChange={communication => setForm({ ...form, communication })} />
        <input disabled={busy} maxLength={500} aria-label={tx("blocking.description")} placeholder={tx("blocking.optionalDescription")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <label className="blocking-check"><input disabled={busy} type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />{tx("blocking.enabled")}</label>
        <button disabled={busy || !ready} className="btn btn-primary">{editId ? tx("blocking.save") : tx("blocking.add")}</button>
        {editId && <button type="button" className="btn btn-ghost" onClick={() => { setEditId(null); setForm({ ...empty, kind }) }}>{tx("blocking.cancel")}</button>}
      </form>
      {Object.entries(ruleErrors).filter(([key]) => key !== 'number').map(([key, message]) => <p key={key} role="alert">{key === 'form' ? '' : key + ': '}{renderNotice(message)}</p>)}
      <details className="blocking-help"><summary>{tx("blocking.numberFormatAndListPriority")}</summary><p>{tx("blocking.frenchDomesticNumbersUse33UseInternationalFormatElsewhere")}</p></details>
      {(ready ? rules : []).map((r) => <div key={r.id} className="blocking-row blocking-rule">
        <label className="blocking-check"><input type="checkbox" disabled={busy} checked={!!r.enabled} onChange={(e) => run(() => {
          const { id, ...body } = r; return request('PUT', '/rules/' + id, { ...body, enabled: e.target.checked })
        })} /><span className="mono">{r.number}{r.match_type === 'prefix' ? '…' : ''}</span></label>
        <span>{tx(communicationLabels[r.communication || 'calls'])}</span>
        <span>{r.match_type === 'prefix' ? tx("blocking.prefix") : tx("blocking.exact")} · {r.description || tx("blocking.noDescription")}</span>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { const { id, scope: _, ...body } = r; setForm({ ...body, enabled: !!body.enabled }); setEditId(id) }}>{tx("blocking.edit")}</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => run(async () => { await request('DELETE', '/rules/' + r.id); showToast(notice("blocking.personalRuleDeleted")) })}>{tx("blocking.delete")}</button>
      </div>)}
      {!rules.length && <p>{tx("blocking.noMatchingEntries")}</p>}
      </div>
    </section>
    <section id="number-test" className="card blocking-card" aria-label={tx("blocking.numberTest")}>
      <h2>{tx("blocking.numberTest")}</h2>
      <form className="blocking-row" onSubmit={(e) => { e.preventDefault(); run(async () => setResult(await request('POST', '/lookup', {
        instance: scope !== '*' ? scope : testInstance || String(instances[0]?.id || ''), number: test, presentation,
      }))) }}>
        {scope === '*' && <select aria-label={tx("blocking.testLine")} value={testInstance || String(instances[0]?.id || '')} onChange={(e) => setTestInstance(e.target.value)}>
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
        </select>}
        <input aria-label={tx("blocking.testNumber")} placeholder={tx("blocking.numberEmptyForUnavailable")} value={test} onChange={(e) => setTest(e.target.value)} />
        <select aria-label={tx("blocking.callerPresentation")} value={presentation} onChange={(e) => setPresentation(e.target.value)}><option value="allowed">{tx("blocking.visible")}</option><option value="prohib">{tx("blocking.withheld")}</option><option value="unavailable">{tx("blocking.unavailable")}</option></select>
        <button className="btn btn-primary" disabled={busy || !instances.length}>{tx("blocking.testNumber")}</button>
      </form>
      {scope !== '*' && <p>{tx("blocking.testingLine", {scopeName: scopeName})}</p>}
      {result && <div role="status" className={'blocking-result ' + verdict(result).key}>
        <strong>{verdict(result).label}</strong>
        <p>{tx(sources[result.source]) || result.source} · {result.rule || tx("blocking.noMatchedRule")} · {tx(modes[result.mode])}<br />{result.normalized || tx("blocking.unknownCaller")} — {decisionReason(result.reason)}</p>
      </div>}
      <p>{tx("blocking.localSimulationOnlyNoCallIsPlacedThisDoes")}</p>
    </section>
    <section id="call-history" className="card blocking-card" aria-label={tx("blocking.callHistory")}>
      <h2>{tx("blocking.callHistory")}</h2>
      <div className="blocking-row">
        <label>SIM<select aria-label="SIM" value={historyLine} onChange={e => setHistoryLine(e.target.value)}><option value="scope">{tx("blocking.currentScope")}</option><option value="*">{tx("blocking.allSims")}</option>{instances.map(i => <option key={i.id} value={String(i.id)}>{i.name || i.id}</option>)}</select></label>
        <label>{tx("blocking.decision")}<select aria-label={tx("blocking.decision")} value={historyDecision} onChange={e => setHistoryDecision(e.target.value)}><option value="">{tx("blocking.allDecisions")}</option><option value="allowed">{tx("blocking.allowed")}</option><option value="rejected">{tx("blocking.rejected")}</option><option value="would_block">{tx("blocking.wouldBlockInEnforce")}</option></select></label>
        <label>{tx("blocking.ruleSource")}<select aria-label={tx("blocking.ruleSource")} value={historySource} onChange={e => setHistorySource(e.target.value)}><option value="">{tx("blocking.allSources")}</option>{Object.entries(sources).map(([value, name]) => <option key={value} value={value}>{tx(name)}</option>)}</select></label>
        <label>{tx("blocking.timePeriod")}<select aria-label={tx("blocking.timePeriod")} value={historyPeriod} onChange={e => setHistoryPeriod(e.target.value)}><option value="">{tx("blocking.allTime")}</option><option value="24">{tx("blocking.last24Hours")}</option><option value="168">{tx("blocking.last7Days")}</option><option value="720">{tx("blocking.last30Days")}</option></select></label>
      </div>
      <p>{tx("blocking.rejectedAReportedRejectDecisionMonitorMatchesWereAllowed")}</p>
      <div className="blocking-table blocking-history"><table><thead><tr>{[tx("blocking.dateTime"), tx("blocking.callingNumber"), tx("blocking.line"), tx("blocking.source"), tx("blocking.matchedRule"), tx("blocking.decisionReason")].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{(ready ? events : []).map((e) => <tr key={e.id}><td data-label={tx("blocking.dateTime")}>{date(e.ts)}</td><td data-label={tx("blocking.callingNumber")}>{e.peer || tx("blocking.unavailable")}</td><td data-label={tx("blocking.line")}>{instances.find((i) => String(i.id) === e.instance)?.name || e.instance}</td><td data-label={tx("blocking.source")}>{tx(sources[e.decision.source]) || e.decision.source}</td><td data-label={tx("blocking.matchedRule")}>{e.decision.rule || '—'}</td><td data-label={tx("blocking.decisionReason")}><span className={'blocking-badge ' + verdict(e.decision).key}>{e.decision.action === 'reject' ? tx("blocking.rejected") : verdict(e.decision).label}</span><br />{tx(modes[e.decision.mode])} — {decisionReason(e.decision.reason)}</td></tr>)}</tbody></table></div>
      {!events.length && <p>{tx("blocking.noEvents")}</p>}
      <div className="blocking-row"><span>{tx("blocking.page", {value1: Math.floor(offset / 50) + 1})}</span><button className="btn btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>{tx("blocking.previous")}</button><button className="btn btn-ghost" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>{tx("blocking.next")}</button><button className="btn btn-ghost" onClick={load}>{tx("blocking.refreshHistory")}</button></div>
    </section>
    <SMSFilterHistory instances={instances} />
  </div>
}
