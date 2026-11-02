import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CallBlocking from '../views/CallBlocking.jsx'
import { api } from '../api.js'
vi.mock('../api.js', () => ({ api: { blocking: vi.fn() } }))

const defaults = { mode: 'monitor', arcep: false, saracroche: false, block_withheld: false, block_unavailable: false }
let configs, provider, poll, failSave, pendingRead
const instances = [{ id: '1', name: 'SIM one' }, { id: '2', name: 'SIM two' }]
const filterForm = () => within(screen.getByRole('region', { name: 'Filtering settings' }))
const databaseForm = () => within(screen.getByRole('region', { name: 'Saracroche database settings' }))
const scopeSelect = () => screen.getByLabelText('Settings and personal rules for')
const mount = async () => { render(<CallBlocking instances={instances} showToast={vi.fn()} />); await screen.findByRole('region', { name: 'Filtering settings' }); await screen.findByRole('region', { name: 'Saracroche database settings' }) }
const save = async () => { fireEvent.click(filterForm().getByText('Save changes')); await waitFor(() => expect(filterForm().getByText('Saved')).toBeTruthy()) }
const switchScope = async (scope) => { fireEvent.change(scopeSelect(), { target: { value: scope } }); await waitFor(() => expect(filterForm().getByRole('heading').textContent).toBe(scope === '*' ? 'Global filtering settings' : 'Line filtering settings')) }
beforeEach(() => {
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
    if (url.pathname === '/rules') return { rules: [] }
    if (url.pathname === '/events') return { events: [] }
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
})
