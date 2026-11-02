import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QuickBlockActions from '../views/QuickBlockActions.jsx'
import SMSFilterHistory from '../views/SMSFilterHistory.jsx'
import { api } from '../api.js'
import i18n, { tx } from '../i18n/index.js'
vi.mock('../api.js', () => ({ api: { blocking: vi.fn() } }))

beforeEach(async () => { await i18n.changeLanguage('en'); api.blocking.mockReset().mockResolvedValue({ ok:true }) })
afterEach(cleanup)

it.each(['calls','sms'])('defaults quick actions to %s and lets the user change both block and unblock', async context => {
  render(<QuickBlockActions instance="1" peer="666" context={context} showToast={vi.fn()} />)
  fireEvent.click(screen.getByText('Block number'))
  let dialog=within(screen.getByRole('dialog'))
  expect(dialog.getByLabelText('Apply to').value).toBe(context)
  fireEvent.change(dialog.getByLabelText('Apply to'),{target:{value:'both'}})
  fireEvent.click(dialog.getByText('Block number'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.blocking).toHaveBeenCalledWith('POST','/quick-rule',{scope:'1',number:'666',communication:'both',action:'block'})
  fireEvent.click(screen.getByText('Unblock number'))
  dialog=within(screen.getByRole('dialog'))
  expect(dialog.getByLabelText('Apply to').value).toBe(context)
  fireEvent.click(dialog.getByText('Unblock number'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.blocking).toHaveBeenCalledWith('POST','/quick-rule',{scope:'1',number:'666',communication:context,action:'unblock'})
})

it('preserves the selection and shows an error after a failed shortcut', async () => {
  api.blocking.mockRejectedValue(new Error('synthetic error'))
  render(<QuickBlockActions instance="1" peer="1023" context="sms" />)
  fireEvent.click(screen.getByText('Block number'))
  fireEvent.click(within(screen.getByRole('dialog')).getByText('Block number'))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Apply to').value).toBe('sms')
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['ru','fr','en'])('localizes quick dialogs and body-free SMS history in %s', async language => {
  await i18n.changeLanguage(language)
  api.blocking.mockResolvedValue({events:[{id:1,ts:1700000000,instance:'1',peer:'666',decision:{mode:'enforce',action:'reject',rule:'666',reason:'Personal blacklist'}}],has_more:false})
  render(<><QuickBlockActions instance="1" peer="666" context="sms" /><SMSFilterHistory instances={[{id:'1',name:'Line one'}]} /></>)
  fireEvent.click(screen.getByText(tx('sms.blockNumber')))
  expect(screen.getByRole('dialog').textContent).toContain(tx('sms.blockQuestion'))
  expect(screen.getByLabelText(tx('sms.applyTo')).value).toBe('sms')
  expect(await screen.findByText(new RegExp(tx('sms.suppressed')))).toBeTruthy()
  expect(screen.getByRole('region',{name:tx('sms.history')}).textContent).not.toContain('synthetic private body')
  fireEvent.change(screen.getByLabelText(tx('sms.historySim')),{target:{value:'1'}})
  fireEvent.change(screen.getByLabelText(tx('sms.historyDecision')),{target:{value:'suppressed'}})
  await waitFor(() => expect(api.blocking.mock.calls.some(([,path]) => path.includes('instance=1') && path.includes('decision=suppressed'))).toBe(true))
  await act(async () => i18n.changeLanguage(language==='en'?'ru':'en'))
  expect(screen.getByRole('dialog').textContent).toContain(tx('sms.blockQuestion'))
})
