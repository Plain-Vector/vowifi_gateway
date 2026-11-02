import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n, { changeLanguage, tx } from '../i18n/index.js'
import LanguageSelector from '../i18n/LanguageSelector.jsx'
import AuthGate from '../AuthGate.jsx'
import Dashboard from '../views/Dashboard.jsx'
import Softphone from '../views/Softphone.jsx'
import Messages from '../views/Messages.jsx'
import SimConfig from '../views/SimConfig.jsx'
import ProvisionModal from '../views/ProvisionModal.jsx'
import Esim from '../views/Esim.jsx'
import Settings from '../views/Settings.jsx'
import Logs from '../views/Logs.jsx'
import { api } from '../api.js'

const phone = vi.hoisted(() => ({ start:vi.fn(), stop:vi.fn(), setAudioEl:vi.fn(), callback:null, created:0 }))
vi.mock('../softphone.js', () => ({ Softphone: class {
  constructor(callback) { phone.callback=callback; phone.created++ }
  start(...args) { phone.start(...args) }
  stop() { phone.stop() }
  setAudioEl(element) { phone.setAudioEl(element) }
} }))
vi.mock('../api.js', () => ({ api:{ auth:vi.fn(), calls:vi.fn(), softphone:vi.fn(), readers:vi.fn(), portsSuggest:vi.fn(), settings:vi.fn(), threads:vi.fn(), esimStatus:vi.fn(), logs:vi.fn() }, connectWs:vi.fn(() => () => {}) }))
const selected={id:'1',name:'Synthetic line',imsi:'208010000000000',status:{state:'OK',label:'Working'},sip:{external:[],webrtc:{enable:true}},ports:{},debug:{}}
const cards=[{index:0,name:'Synthetic reader',present:true,matched:'1',pin_enabled:true,pin_tries:3}]
const subscribe=vi.fn(() => () => {})
beforeEach(async()=>{
  await i18n.changeLanguage('en'); phone.created=0; phone.callback=null; phone.start.mockReset();phone.stop.mockReset();phone.setAudioEl.mockReset()
  api.auth.mockResolvedValue({configured:true,authenticated:false})
  api.calls.mockResolvedValue({calls:[]}); api.softphone.mockResolvedValue({enabled:true,host:'test.invalid'})
  api.readers.mockResolvedValue({readers:[]});api.portsSuggest.mockResolvedValue({auto_sip_udp:5060,auto_sip_tls:5061})
  api.settings.mockResolvedValue({tls:{self_signed:true},debug:{},retry:{},rekey:{},ntfy:{enabled:false,server:'https://ntfy.sh',topic:'',events:{}}})
  api.threads.mockResolvedValue({threads:[]});api.esimStatus.mockResolvedValue({available:false})
  api.logs.mockResolvedValue({engine:'REGISTER sip:example.invalid\n<img src=x onerror=alert(1)>',charon:'IKE_SA_INIT'})
})
afterEach(cleanup)
it.each(['en','ru','fr'])('renders authentication and PIN safety text in %s without sending credentials', async language=>{
  await i18n.changeLanguage(language)
  render(<AuthGate />)
  await screen.findByText(tx('authentication.administratorLogin'))
  const password=screen.getByLabelText(tx('authentication.password'))
  fireEvent.change(password,{target:{value:'synthetic-unsent-password'}})
  expect(api.auth.mock.calls.every(([method])=>method==='GET')).toBe(true)
  await act(async()=>changeLanguage(language==='ru'?'fr':'ru'))
  expect(password.value).toBe('synthetic-unsent-password')
  cleanup();await i18n.changeLanguage(language)
  render(<ProvisionModal card={cards[0]} onClose={vi.fn()} />)
  expect(screen.getByText(tx('provisioning.simPinChv1',{value1:tx('provisioning.required')}))).toBeTruthy()
  expect(screen.getByPlaceholderText(tx('provisioning.48Digits'))).toBeTruthy()
  expect(screen.getByRole('button',{name:tx('provisioning.provisionStart')}).disabled).toBe(true)
})
it('preserves an incoming and active phone session, audio element, SIM and subscriptions through all languages', async()=>{
  const setSelected=vi.fn();render(<><LanguageSelector/><Softphone selected={selected} instances={[selected]} cards={cards} subscribe={subscribe} setSelected={setSelected} showToast={vi.fn()}/></>)
  await waitFor(()=>expect(phone.start).toHaveBeenCalledTimes(1))
  const audio=document.querySelector('audio');const calls=api.calls.mock.calls.length;const provision=api.softphone.mock.calls.length
  act(()=>{phone.callback('registered',true);phone.callback('incoming',{from:'+33612345678'})})
  for(const language of ['ru','fr','en']){
    await act(async()=>changeLanguage(language))
    expect(screen.getByRole('button',{name:tx('softphone.answer')})).toBeTruthy()
    expect(document.querySelector('audio')).toBe(audio)
    expect(document.querySelector('.sim-label-short').textContent).toBe(tx('lineSelector.activeShort'))
  }
  act(()=>phone.callback('active'))
  for(const language of ['fr','ru','en']){
    await act(async()=>changeLanguage(language))
    expect(screen.getByText(tx('softphone.hangUp'))).toBeTruthy()
  }
  expect(phone.created).toBe(1);expect(phone.start).toHaveBeenCalledTimes(1);expect(phone.stop).not.toHaveBeenCalled();expect(setSelected).not.toHaveBeenCalled()
  expect(phone.setAudioEl.mock.calls.every(([element])=>element===audio)).toBe(true)
  expect(api.calls.mock.calls).toHaveLength(calls);expect(api.softphone.mock.calls).toHaveLength(provision)
})
it.each(['en','ru','fr'])('renders representative operational views in %s', async language=>{
  await i18n.changeLanguage(language)
  const props={instances:[selected],cards,selected,setSelected:vi.fn(),subscribe,refresh:vi.fn(),showToast:vi.fn()}
  render(<Dashboard {...props} cardsKnown={true}/>)
  expect(screen.getAllByText(tx('lineStatus.OK'))[0]).toBeTruthy();cleanup()
  render(<Messages {...props} selected={null}/>)
  expect(screen.getByText(tx('messages.selectASimLineToViewAndSendMessages'))).toBeTruthy();cleanup()
  render(<Esim {...props} cards={[]}/>)
  expect(screen.getByText(tx('esim.noSimPresentInsertAnEuiccIntoAPc'))).toBeTruthy();cleanup()
  render(<Settings/>);await screen.findByText(tx('settings.ntfyNotifications'));cleanup()
  render(<SimConfig {...props}/>);await screen.findByText(tx('sim.simCard'));cleanup()
  render(<Logs {...props} selected={null}/>)
  expect(screen.getByText(tx('logs.selectASimLineToViewItsEngineAnd'))).toBeTruthy()
})

it('keeps log payloads literal and unchanged while translating the log controls', async()=>{
  render(<Logs selected={selected} instances={[selected]} cards={cards} setSelected={vi.fn()}/>)
  await waitFor(()=>expect(document.querySelector('pre').textContent).toContain('REGISTER sip:example.invalid'))
  const log=document.querySelector('pre');const content=log.textContent;const calls=api.logs.mock.calls.length
  await act(async()=>changeLanguage('ru'))
  expect(log.textContent).toBe(content);expect(document.querySelector('img')).toBeNull()
  expect(screen.getByRole('button',{name:tx('logs.refresh')})).toBeTruthy()
  expect(api.logs.mock.calls).toHaveLength(calls)
})
