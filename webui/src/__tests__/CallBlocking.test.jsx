import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CallBlocking from '../views/CallBlocking.jsx'
import { api } from '../api.js'
import i18n, { changeLanguage } from '../i18n/index.js'
import LanguageSelector from '../i18n/LanguageSelector.jsx'
vi.mock('../api.js', () => ({ api: { blocking: vi.fn() } }))

const defaults = { mode: 'monitor', arcep: false, saracroche: false, block_withheld: false, block_unavailable: false }
let configs, provider, poll, failSave, pendingRead, personalRules, historyEvents, lookupResult, updateResult
const instances = [{ id: '1', name: 'SIM one' }, { id: '2', name: 'SIM two' }]
const filterForm = () => within(screen.getByRole('region', { name: 'Filtering settings' }))
const databaseForm = () => within(screen.getByRole('region', { name: 'Saracroche database settings' }))
const scopeSelect = () => screen.getByLabelText('Settings and personal rules for')
const mount = async () => { render(<CallBlocking instances={instances} showToast={vi.fn()} />); await screen.findByRole('region', { name: 'Filtering settings' }); await screen.findByRole('region', { name: 'Saracroche database settings' }) }
const save = async () => { fireEvent.click(filterForm().getByText('Save changes')); await waitFor(() => expect(filterForm().getByText('Saved')).toBeTruthy()) }
const switchScope = async (scope) => { fireEvent.change(scopeSelect(), { target: { value: scope } }); await waitFor(() => expect(filterForm().getByRole('heading').textContent).toBe(scope === '*' ? 'Global filtering settings' : 'Line filtering settings')) }
beforeEach(async () => {
  await i18n.changeLanguage('en')
  personalRules = []; historyEvents = []; lookupResult = { action: 'allow', would_block: false, source: 'none', mode: 'monitor', reason: 'No match' }; updateResult = { ok: true }
  configs = { '*': { ...defaults }, '1': {}, '2': {} }; failSave = false; pendingRead = null
  provider = { connection: { source: 'remote', country_codes: 'FR', selected_list_ids: null }, auto_update: false, interval_hours: 24, entries: 0, catalog: [], coverage: {}, enabled: false }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const realInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...args) => {
    if (ms === 15000) { poll = fn; return 123 }
    return realInterval(fn, ms, ...args)
  })
  api.blocking.mockReset().mockImplementation(async (method, path, body) => {
    const url = new URL(path, 'https://test/'); const scope = url.searchParams.get('scope') || '*'
    if (url.pathname === '/settings') {
      if (method === 'PUT') { if (failSave) throw new Error('Write failed: disk full'); configs[scope] = { ...body } }
      if (method === 'GET' && pendingRead) return pendingRead(scope)
      const effective = { ...configs['*'], ...configs[scope] }
      if (configs['*'].mode === 'disabled') effective.mode = 'disabled'
      return structuredClone({ scope, global: configs['*'], override: scope === '*' ? {} : configs[scope], effective })
    }
    if (url.pathname === '/providers/saracroche' && method === 'PUT') {
      if (!Number.isInteger(body.interval_hours) || body.interval_hours < 1) throw new Error('interval_hours: must be at least 1')
      provider = { ...provider, auto_update: body.auto_update, interval_hours: body.interval_hours, connection: { source: body.source, country_codes: body.country_codes, selected_list_ids: body.selected_list_ids } }
    }
    if (url.pathname === '/providers' || url.pathname === '/providers/saracroche') return { providers: [structuredClone(provider)] }
    if (url.pathname === '/providers/saracroche/update') return updateResult
    if (url.pathname === '/lookup') return lookupResult
    if (url.pathname.startsWith('/rules')) {
      if (method === 'POST' || method === 'PUT') {
        if (body.number === 'invalid') throw Object.assign(new Error('Use a valid international number'), { status: 422 })
        const id = method === 'POST' ? personalRules.length + 1 : Number(url.pathname.split('/').at(-1))
        personalRules = personalRules.filter(rule => rule.id !== id).concat({ ...body, id })
        return { id }
      }
      if (method === 'DELETE') { personalRules = personalRules.filter(rule => rule.id !== Number(url.pathname.split('/').at(-1))); return { ok: true } }
      return { rules: personalRules.filter(rule => rule.scope === scope && rule.kind === url.searchParams.get('kind')) }
    }
    if (url.pathname === '/events') return { events: structuredClone(historyEvents), has_more: false }
    throw new Error('Unexpected request ' + method + ' ' + path)
  })
})
afterEach(cleanup)

describe('explicit settings lifecycle', () => {
  it('keeps rapid checkbox edits through polling; writes once and survives remount', async () => {
    await mount()
    fireEvent.click(screen.getByLabelText('ARCEP automated-calling ranges'))
    fireEvent.click(screen.getByLabelText('Withheld caller IDs'))
    fireEvent.click(screen.getByLabelText('Enable Saracroche matching'))
    await act(async () => { await poll() })
    expect(screen.getByLabelText('ARCEP automated-calling ranges').checked).toBe(true)
    expect(api.blocking.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0)
    await save()
    expect(configs['*']).toMatchObject({ arcep: true, block_withheld: true, saracroche: true })
    cleanup(); await mount()
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(true)
  })
  it('confirms scope changes, isolates SIM overrides, and restores individual inheritance', async () => {
    await mount(); await switchScope('1')
    fireEvent.click(screen.getByLabelText('Withheld caller IDs'))
    window.confirm.mockReturnValueOnce(false)
    fireEvent.change(scopeSelect(), { target: { value: '2' } })
    expect(scopeSelect().value).toBe('1')
    await save(); await switchScope('2')
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(false)
    await switchScope('1')
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(true)
    fireEvent.click(screen.getByText('Inherit Withheld caller IDs')); await save()
    expect(configs['1']).toEqual({}); expect(configs['*']).toEqual(defaults)
  })
  it('preserves drafts and actual errors after failed save, then retries', async () => {
    await mount(); fireEvent.click(screen.getByLabelText('Withheld caller IDs')); failSave = true
    fireEvent.click(screen.getByText('Save changes'))
    await screen.findByText('Write failed: disk full')
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(true)
    failSave = false; await save()
  })
  it('ignores late settings reads from a previously selected SIM', async () => {
    await mount()
    let resolve
    pendingRead = scope => scope === '1' ? new Promise(r => { resolve = r }) : Promise.resolve({ scope, global: defaults, override: {}, effective: defaults })
    fireEvent.change(scopeSelect(), { target: { value: '1' } })
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    await switchScope('2')
    await act(async () => resolve({ scope: '1', global: defaults, override: { arcep: true }, effective: { ...defaults, arcep: true } }))
    expect(scopeSelect().value).toBe('2'); expect(screen.getByLabelText('ARCEP automated-calling ranges').checked).toBe(false)
  })
  it('requires confirmation for Enforce and saves all three modes explicitly', async () => {
    await mount()
    for (const mode of ['disabled', 'monitor', 'enforce']) {
      fireEvent.change(screen.getByLabelText('Operation mode'), { target: { value: mode } }); await save()
      expect(configs['*'].mode).toBe(mode)
    }
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('legitimate incoming calls'))
  })
  it('discards unsaved edits and confirms resetting line overrides', async () => {
    configs['1'] = { arcep: true, mode: 'enforce' }; await mount(); await switchScope('1')
    window.confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getByText('Reset all line settings to global'))
    expect(screen.getByLabelText('ARCEP automated-calling ranges').checked).toBe(true)
    fireEvent.click(screen.getByText('Reset all line settings to global'))
    expect(screen.getByLabelText('ARCEP automated-calling ranges').checked).toBe(false)
    fireEvent.click(screen.getByText('Discard changes'))
    await waitFor(() => expect(screen.getByLabelText('ARCEP automated-calling ranges').checked).toBe(true))
  })
  it('keeps one save in flight and does not let an older poll erase saved settings', async () => {
    await mount()
    const original = api.blocking.getMockImplementation()
    let release
    api.blocking.mockImplementation((method, path, body) => method === 'PUT' && path.startsWith('/settings')
      ? new Promise(resolve => { release = async () => resolve(await original(method, path, body)) })
      : original(method, path, body))
    fireEvent.click(screen.getByLabelText('Withheld caller IDs'))
    fireEvent.click(screen.getByText('Save changes'))
    expect(screen.getByLabelText('Withheld caller IDs').matches(':disabled')).toBe(true)
    expect(scopeSelect().disabled).toBe(true)
    await act(async () => { await poll() })
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(true)
    await act(async () => { await release() })
    await waitFor(() => expect(filterForm().getByText('Saved')).toBeTruthy())
    expect(configs['*'].block_withheld).toBe(true)
  })
  it('ignores an old operational response after switching lines', async () => {
    await mount()
    const original = api.blocking.getMockImplementation()
    let release
    api.blocking.mockImplementation((method, path, body) => path.startsWith('/rules?') && new URL(path, 'https://test').searchParams.get('scope') === '*'
      ? new Promise(resolve => { release = resolve }) : original(method, path, body))
    let refresh
    await act(async () => { refresh = poll(); await Promise.resolve() })
    expect(release).toBeTypeOf('function')
    await switchScope('2')
    await act(async () => { release({ rules: [{ id: 99, number: 'STALE GLOBAL RULE' }] }); await refresh })
    expect(screen.queryByText('STALE GLOBAL RULE')).toBeNull()
  })
  it('warns on browser close with unsaved edits and requires explicit list selection saves', async () => {
    provider.catalog = [{ id: 1, name: 'List A', type: 'block', priority: 100, item_count: 2, selected: true, is_enabled_by_default: true, license: 'CC BY-NC-SA 4.0' }]
    await mount()
    fireEvent.click(screen.getByLabelText(/List A/))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(api.blocking.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0)
    fireEvent.click(screen.getByText('Use Android default lists'))
    expect(screen.getByLabelText(/List A/).checked).toBe(true)
  })
  it('keeps provider drafts through polling, validates, saves and reloads', async () => {
    await mount()
    fireEvent.click(screen.getByLabelText('Automatic database updates'))
    fireEvent.change(screen.getByLabelText('Update interval (hours)'), { target: { value: '0' } })
    fireEvent.click(screen.getByText('Save database changes'))
    await screen.findByText('interval_hours: must be at least 1')
    fireEvent.change(screen.getByLabelText('Update interval (hours)'), { target: { value: '48' } })
    fireEvent.change(screen.getByLabelText('Saracroche country codes'), { target: { value: 'FR,BE' } })
    await act(async () => { await poll() })
    expect(screen.getByLabelText('Automatic database updates').checked).toBe(true)
    expect(screen.getByLabelText('Update interval (hours)').value).toBe('48')
    fireEvent.click(screen.getByText('Save database changes'))
    await waitFor(() => expect(databaseForm().getByText('Saved')).toBeTruthy())
    cleanup(); await mount()
    expect(screen.getByLabelText('Saracroche country codes').value).toBe('FR,BE')
    fireEvent.change(screen.getByLabelText('Saracroche source'), { target: { value: 'local' } })
    fireEvent.click(screen.getByText('Save database changes'))
    await waitFor(() => expect(databaseForm().getByText('Saved')).toBeTruthy())
    expect(provider.connection.source).toBe('local')
  })
  it('shows saved effective status independently from an unsaved mode draft', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('Operation mode'), { target: { value: 'enforce' } })
    expect(within(screen.getByLabelText('Saved filtering status')).getByText('Monitor')).toBeTruthy()
    await save()
    expect(within(screen.getByLabelText('Saved filtering status')).getByText('Enforce')).toBeTruthy()
    await switchScope('1')
    configs['*'].mode = 'disabled'
    await switchScope('*'); await switchScope('1')
    expect(within(screen.getByLabelText('Saved filtering status')).getByText('Disabled')).toBeTruthy()
  })
  it('adds, edits and deletes personal rules in separate blacklist/whitelist tabs', async () => {
    await mount()
    const section = within(screen.getByRole('region', { name: 'Personal lists' }))
    fireEvent.change(screen.getByLabelText('Number or prefix'), { target: { value: '+33612345678' } })
    fireEvent.click(section.getByRole('button', { name: 'Add', exact: true }))
    await section.findByRole('button', { name: 'Edit' })
    fireEvent.click(section.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Known test rule' } })
    fireEvent.click(section.getByRole('button', { name: 'Save', exact: true }))
    await section.findByText('Exact · Known test rule')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Blacklist' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Whitelist' }))
    await waitFor(() => expect(section.queryByRole('button', { name: 'Edit' })).toBeNull())
    fireEvent.change(screen.getByLabelText('Number or prefix'), { target: { value: '+33600000000' } })
    fireEvent.click(section.getByRole('button', { name: 'Add', exact: true }))
    await section.findByRole('button', { name: 'Edit' })
    expect(personalRules.find(rule => rule.number === '+33600000000').kind).toBe('allow')
    fireEvent.click(section.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(section.queryByRole('button', { name: 'Edit' })).toBeNull())
    expect(personalRules).toHaveLength(1)
  })
  it('places rule validation errors next to the number and preserves the input', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('Number or prefix'), { target: { value: 'invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }))
    await screen.findByText('Use a valid international number')
    expect(screen.getByLabelText('Number or prefix').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('Number or prefix').value).toBe('invalid')
  })
  it('shows update busy/error states and does not lose errors during polling', async () => {
    provider.enabled = true
    let release; updateResult = new Promise(resolve => { release = resolve })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Update database now' }))
    expect(screen.getByRole('button', { name: 'Updating database…' }).disabled).toBe(true)
    await act(async () => { release({ ok: false, error: 'Synthetic provider failure' }) })
    await screen.findByText('Synthetic provider failure')
    await act(async () => { await poll() })
    expect(screen.getByText('Synthetic provider failure')).toBeTruthy()
  })
  it('refreshes the latest SIM when a database update finishes after switching scope', async () => {
    provider.enabled = true
    let release; updateResult = new Promise(resolve => { release = resolve })
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Update database now' }))
    await switchScope('2')
    await act(async () => { release({ ok: true }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update database now' }).disabled).toBe(false))
    const reads = api.blocking.mock.calls.filter(([method, path]) => method === 'GET' && path.startsWith('/rules?'))
    expect(new URL(reads.at(-1)[1], 'https://test').searchParams.get('scope')).toBe('2')
  })
  it.each([
    ['allow', false, 'none', 'Allowed'],
    ['allow', true, 'saracroche', 'Would be blocked in Enforce'],
    ['reject', true, 'blacklist', 'Blocked by current settings'],
  ])('presents simulated %s / %s decisions without generating calls', async (action, would_block, source, label) => {
    lookupResult = { action, would_block, source, mode: action === 'reject' ? 'enforce' : 'monitor', rule: '+33612', reason: 'Synthetic test' }
    await mount(); fireEvent.click(screen.getByRole('button', { name: 'Test number', exact: true }))
    await within(screen.getByRole('region', { name: 'Number test' })).findByText(label)
    expect(screen.getByText(/does not verify carrier call rejection/)).toBeTruthy()
    expect(api.blocking.mock.calls.filter(([method]) => method === 'POST').map(([, path]) => path)).toEqual(['/lookup'])
  })
  it('shows distinct history outcomes and sends all filters to the paginated API', async () => {
    historyEvents = [
      { id: 1, ts: 1000, peer: '+33611111111', instance: '1', decision: { action: 'reject', would_block: true, mode: 'enforce', source: 'blacklist', reason: 'Matched' } },
      { id: 2, ts: 1001, peer: '+33622222222', instance: '2', decision: { action: 'allow', would_block: true, mode: 'monitor', source: 'saracroche', reason: 'Matched' } },
    ]
    await mount()
    const history = within(screen.getByRole('region', { name: 'Call history' }))
    expect(history.getByText('Rejected', { selector: 'span' })).toBeTruthy(); expect(history.getByText('Would be blocked in Enforce')).toBeTruthy()
    fireEvent.change(history.getByLabelText('SIM'), { target: { value: '2' } })
    fireEvent.change(history.getByLabelText('Decision'), { target: { value: 'would_block' } })
    fireEvent.change(history.getByLabelText('Rule source'), { target: { value: 'saracroche' } })
    fireEvent.change(history.getByLabelText('Time period'), { target: { value: '24' } })
    await waitFor(() => expect(api.blocking.mock.calls.some(([method, path]) => method === 'GET' && path.includes('instance=2') && path.includes('decision=would_block') && path.includes('source=saracroche') && path.includes('since='))).toBe(true))
    expect(history.getByRole('button', { name: 'Next' }).disabled).toBe(true)
  })

  it('switches RU/FR/EN without writes, scope changes or loss of pending settings', async () => {
    render(<><LanguageSelector /><CallBlocking instances={instances} showToast={vi.fn()} /></>)
    await screen.findByRole('region', { name: 'Filtering settings' }); await switchScope('1')
    const scope = scopeSelect()
    fireEvent.click(screen.getByLabelText('Withheld caller IDs'))
    fireEvent.change(screen.getByLabelText('Saracroche country codes'), {target:{value:'FR,BE'}})
    const calls = api.blocking.mock.calls.length
    await act(async () => changeLanguage('ru'))
    expect(screen.getByLabelText('Скрытые номера').checked).toBe(true)
    expect(screen.getByLabelText('Коды стран Saracroche').value).toBe('FR,BE')
    expect(scope.value).toBe('1')
    fireEvent.click(screen.getByText('Источник, автор и лицензия'))
    const license = document.querySelector('a[href="https://creativecommons.org/licenses/by-nc-sa/4.0/"]')
    expect(license.textContent).toContain('некоммерческое')
    expect(document.querySelector('a[href="https://saracroche.org/"]')).toBeTruthy()
    await act(async () => changeLanguage('fr'))
    expect(license.textContent).toContain('non commercial')
    expect(screen.getByLabelText('Numéros masqués').checked).toBe(true)
    expect(scope.value).toBe('1')
    expect(api.blocking.mock.calls.length).toBe(calls)
    fireEvent.click(screen.getByRole('button',{name:'Enregistrer les modifications',exact:true}))
    await waitFor(() => expect(configs['1'].block_withheld).toBe(true))
    expect(configs['*'].block_withheld).toBe(false)
    await act(async () => changeLanguage('en'))
    expect(screen.getByLabelText('Withheld caller IDs').checked).toBe(true)
  })

})
