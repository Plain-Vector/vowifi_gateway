import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useTranslation } from 'react-i18next'
import i18n, { detectLanguage, changeLanguage, tx, notice, renderNotice, RichMessage, formatDate, formatNumber, errorNotice } from '../i18n/index.js'
import LanguageSelector from '../i18n/LanguageSelector.jsx'
import en from '../i18n/locales/en.json'
import ru from '../i18n/locales/ru.json'
import fr from '../i18n/locales/fr.json'
import { validateCatalogs, flatten } from '../../scripts/check-i18n.mjs'

beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage('en') })
afterEach(cleanup)
it('detects regional browser languages and honors explicit preferences', () => {
  for (const [languages, expected] of [[['ru-RU'],'ru'], [['fr-CA'],'fr'], [['de-DE'],'en'], [['de','fr-FR'],'fr'], [['en-US','ru'],'en']]) {
    expect(detectLanguage({ getItem: () => null }, { languages })).toBe(expected)
  }
  expect(detectLanguage({ getItem: () => 'fr' }, { languages: ['ru-RU'] })).toBe('fr')
  expect(detectLanguage({ getItem: () => 'invalid' }, { language: 'ru-UA' })).toBe('ru')
  expect(detectLanguage({ getItem: () => { throw new Error('blocked') } }, { language: 'fr-FR' })).toBe('fr')
})
it('validates all keys, placeholders and fixed React markup in each locale', () => {
  expect(validateCatalogs({en, ru, fr})).toEqual([])
  const broken = structuredClone(fr); delete broken.common.language
  expect(validateCatalogs({en, ru, fr:broken})).toContain('fr: missing or extra key common.language')
  const changed = structuredClone(ru); changed.navigation.smsFrom = 'SMS {{wrong}}'
  expect(validateCatalogs({en, ru:changed, fr}).some(message => message.includes('placeholders navigation.smsFrom'))).toBe(true)
  expect(Object.keys(flatten(en)).length).toBeGreaterThan(700)
})
it('switches instantly, persists explicit choice, updates html language and falls back to English', async () => {
  render(<LanguageSelector />)
  fireEvent.change(screen.getByLabelText('Language'), {target:{value:'ru'}})
  await screen.findByLabelText('Язык')
  expect(localStorage.getItem('vowifi-language')).toBe('ru')
  expect(document.documentElement.lang).toBe('ru')
  expect(detectLanguage(localStorage, {language:'fr'})).toBe('ru')
  i18n.addResource('en', 'translation', 'testOnly.englishFallback', 'English fallback')
  expect(tx('testOnly.englishFallback')).toBe('English fallback')
  expect(document.title).toBe('VoWiFi Gateway')
  await act(async () => changeLanguage('fr'))
  expect(screen.getByLabelText('Langue').value).toBe('fr')
})
it('uses Intl dates/numbers with the viewer timezone and Russian plural categories', async () => {
  const stamp = Date.UTC(2026, 10, 2, 14, 5, 6)
  for (const language of ['en','ru','fr']) {
    await i18n.changeLanguage(language)
    expect(formatDate(stamp)).toBe(new Intl.DateTimeFormat(language,{dateStyle:'short',timeStyle:'medium'}).format(stamp))
    expect(formatNumber(15463210)).toBe(new Intl.NumberFormat(language).format(15463210))
  }
  await i18n.changeLanguage('ru')
  for (const [count, word] of [[0,'профилей'],[1,'профиль'],[2,'профиля'],[5,'профилей'],[11,'профилей'],[21,'профиль'],[22,'профиля'],[25,'профилей']]) expect(tx('esim.profileCount',{count})).toBe(`${count} ${word}`)
  expect(tx('messages.deleteSelected',{count:22})).toBe('Удалить 22 выбранных сообщения?')
})
it('retranslates a visible toast descriptor and renders hostile caller data as text', async () => {
  const caller = '<img src=x onerror="alert(1)">'
  const message = notice('navigation.smsFrom',{value1:caller})
  function Toast() { useTranslation(); return <div role="status">{renderNotice(message)}</div> }
  render(<Toast />)
  expect(screen.getByRole('status').textContent).toBe('SMS from '+caller)
  expect(document.querySelector('img')).toBeNull()
  await act(async () => changeLanguage('ru'))
  expect(screen.getByRole('status').textContent).toBe('SMS от '+caller)
})
it('keeps markup fixed while rich-message interpolation remains literal text', () => {
  const hostile = '<img src=x onerror="alert(1)"><0 href="https://evil.invalid">bad</0>'
  render(<RichMessage id="provisioning.readerIccidImsi" values={{index:1,name:hostile,value1:'test',value2:'test'}} components={[<br key="a"/>,<br key="b"/>]}/>)
  expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('a')).toBeNull()
  expect(document.body.textContent).toContain(hostile)
})

it('localizes documented authentication failures while keeping unknown diagnostics raw', async () => {
  const error = {message:'Invalid username or password',data:{detail:'Invalid username or password'}}
  const descriptor = errorNotice(error)
  await i18n.changeLanguage('ru');expect(renderNotice(descriptor)).toBe('Неверный логин или пароль')
  await i18n.changeLanguage('fr');expect(renderNotice(descriptor)).toBe('Identifiant ou mot de passe incorrect')
  expect(errorNotice({message:'SIP 403 / carrier diagnostic',data:{detail:'unknown diagnostic'}})).toBe('SIP 403 / carrier diagnostic')
  expect(formatDate('not-a-date')).toBe('—')
})
it('translates native validation without changing values or submitting a form', async () => {
  let submitted = false
  render(<form onSubmit={e=>{e.preventDefault();submitted=true}}><input aria-label="Synthetic required field" required /></form>)
  const field = screen.getByLabelText('Synthetic required field')
  fireEvent.invalid(field)
  expect(field.validationMessage).toBe('Fill out this field.')
  await act(async()=>changeLanguage('ru'))
  expect(field.validationMessage).toBe('Заполните это поле.')
  await act(async()=>changeLanguage('fr'))
  expect(field.validationMessage).toBe('Veuillez renseigner ce champ.')
  expect(field.value).toBe(''); expect(submitted).toBe(false)
  fireEvent.input(field,{target:{value:'synthetic input'}})
  expect(field.validationMessage).toBe('')
})
it('retains numeric constraints while localizing their messages', async () => {
  render(<input aria-label="Synthetic range" type="number" min="1" max="720" defaultValue="0"/>)
  const field=screen.getByLabelText('Synthetic range');fireEvent.invalid(field)
  await act(async()=>changeLanguage('fr'))
  expect(field.validationMessage).toBe('Valeur minimale : 1.')
  expect(field.value).toBe('0');expect(field.validity.rangeUnderflow).toBe(true)
})

it('does not leave a discarded or programmatically updated field invalid', async () => {
  const {rerender}=render(<input aria-label="Controlled range" type="number" min="1" value="0" onChange={()=>{}}/>)
  const field=screen.getByLabelText('Controlled range');fireEvent.invalid(field)
  expect(field.validity.customError).toBe(true)
  rerender(<input aria-label="Controlled range" type="number" min="1" value="24" onChange={()=>{}}/>)
  await waitFor(()=>expect(field.validity.valid).toBe(true))
  expect(field.validationMessage).toBe('');expect(field.value).toBe('24')
})
it('translates structured server validation by type, preserving raw unknown diagnostics', async () => {
  const descriptor=errorNotice({data:{detail:[{loc:['body','interval_hours'],type:'greater_than_equal',ctx:{ge:1},msg:'English server message'}]}})
  await i18n.changeLanguage('ru')
  expect(renderNotice(descriptor)).toBe('Период обновления, часы: Минимальное значение: 1.')
  await i18n.changeLanguage('fr')
  expect(renderNotice(descriptor)).toBe('Intervalle de mise à jour (heures) : Valeur minimale : 1.')
  expect(renderNotice(errorNotice({data:{detail:[{loc:['body','custom'],type:'unknown',msg:'Raw vendor diagnostic'}]}}))).toBe('custom : Raw vendor diagnostic')
})
