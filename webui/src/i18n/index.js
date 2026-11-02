import React from 'react'
import i18n from 'i18next'
import { initReactI18next, Trans } from 'react-i18next'
import en from './locales/en.json'
import fr from './locales/fr.json'
import ru from './locales/ru.json'
import { installNativeValidation } from './validation.js'

export const languages = ['en', 'fr', 'ru']

export function detectLanguage(storage, browser = globalThis.navigator) {
  try {
    const saved = (storage === undefined ? globalThis.localStorage : storage)?.getItem('vowifi-language')
    if (languages.includes(saved)) return saved
  } catch { /* Browser policy may disable storage; detection still works. */ }
  const preferences = browser?.languages?.length ? browser.languages : [browser?.language]
  for (const preference of preferences) {
    const code = String(preference || '').toLowerCase().split(/[-_]/)[0]
    if (languages.includes(code)) return code
  }
  return 'en'
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr }, ru: { translation: ru } },
  lng: detectLanguage(),
  fallbackLng: 'en',
  supportedLngs: languages,
  initAsync: false,
  // Plain translations are rendered as React text, never as HTML.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  returnNull: false
})

function updateDocument(language) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
  document.title = i18n.t('common.documentTitle')
}
i18n.on('languageChanged', updateDocument)
updateDocument(i18n.language)
const removeValidation = typeof document === 'undefined' ? () => {} : installNativeValidation(i18n, document)
if (import.meta.hot) import.meta.hot.dispose(removeValidation)

export function changeLanguage(language) {
  if (!languages.includes(language)) return
  try { localStorage.setItem('vowifi-language', language) } catch { /* In-memory switching remains available. */ }
  return i18n.changeLanguage(language)
}

// The stable translator is safe in long-lived WebSocket/phone callbacks. Components
// subscribe with useTranslation; language never becomes a lifecycle dependency.
export function tx(key, values) {
  if (!key) return ''
  const resolved = values && Object.fromEntries(Object.entries(values).map(([name, value]) => [
    name, value?.i18nKey || value?.i18nMessages ? renderNotice(value) : value
  ]))
  return i18n.t(key, resolved)
}
export const notice = (key, values = {}) => ({ i18nKey: key, values })
export const renderNotice = value => value?.i18nMessages ? value.i18nMessages.map(renderNotice).join('; ') : value?.i18nKey ? tx(value.i18nKey, value.values) : value

export function formatDate(value, options = { dateStyle: 'short', timeStyle: 'medium' }) {
  if (value == null || !Number.isFinite(new Date(value).getTime())) return '—'
  return new Intl.DateTimeFormat(i18n.language, options).format(new Date(value))
}
export const formatNumber = (value, options) => new Intl.NumberFormat(i18n.language, options).format(value)

export function RichMessage({ id, values, components }) {
  // Escape values before Trans parses fixed catalog markup, then decode only text
  // nodes. A caller/SIM name containing <0> or <img> cannot create markup or links.
  return React.createElement(Trans, {
    i18nKey: id, values, components,
    tOptions: { interpolation: { escapeValue: true } }, shouldUnescape: true
  })
}

const legacyDisplayCodes = { 'no answer': 'noAnswer', 'Unsaved changes': 'unsaved' }
export function statusLabel(group, code, fallback = code || '—') {
  const key = group + '.' + (legacyDisplayCodes[code] || code)
  return i18n.exists(key) ? tx(key) : fallback
}

// Exact, documented API errors only. Unknown provider/server diagnostics stay raw.
const authErrors = {
  'Administrator login required': 'administratorLoginRequired',
  'Invalid username or password': 'invalidCredentials',
  'Invalid setup code': 'invalidSetupCode',
  'Current password incorrect': 'wrongCurrentPassword',
  'Use a password of at least 12 characters': 'passwordTooShort',
  'Administrator already configured': 'alreadyConfigured',
  'Too many login attempts; retry in 15 minutes': 'loginThrottled',
  'Cross-origin request rejected': 'originRejected',
  'Cross-site request rejected': 'originRejected',
  'Use a French number or international +/00 number; no wildcards or regex': 'invalidPhoneNumber',
  'Use an exact 2-6 digit service number starting 1-9, a French number or international +/00 number; no wildcards or regex': 'invalidPhoneNumber',
  'This rule is disabled; edit it in Personal lists before blocking': 'disabledQuickRule',
  'This rule already exists': 'duplicateRule',
  'Rule not found': 'ruleNotFound',
  'Unknown instance': 'unknownLine',
  'Call Blocking access token required': 'blockingTokenRequired'
}
export function errorNotice(error) {
  if (error?.i18nKey) return notice(error.i18nKey, error.values)
  if (Array.isArray(error?.data?.detail)) return validationNotice(error.data.detail)
  const key = authErrors[error?.data?.detail]
  return key ? notice('errors.' + key) : error?.message || String(error)
}
export function localizedError(key, values) {
  return Object.assign(new Error(tx(key, values)), { i18nKey: key, values })
}

const decisionReasons = {
  'Local SMS lookup failed; SMS allowed': 'sms.lookupFailed',
  'SMS policy handoff failed; SMS allowed': 'sms.handoffFailed',
  'No enabled rule matched': 'blocking.noMatchReason',
  'Filtering disabled': 'blocking.disabledReason',
  'Personal whitelist': 'blocking.whitelistSource',
  'Personal blacklist': 'blocking.blacklistSource',
  'ARCEP verified automated-calling range': 'blocking.arcepReason',
  'Saracroche allowlist': 'blocking.allowReason',
  'Saracroche blocklist': 'blocking.blockReason',
  'Withheld caller ID': 'blocking.hiddenSource',
  'Unavailable caller ID': 'blocking.unavailableSource'
}
export const decisionReason = reason => decisionReasons[reason] ? tx(decisionReasons[reason]) : reason
export default i18n

const validationFields = {
  interval_hours: 'blocking.updateIntervalHours', country_codes: 'blocking.countryCodes',
  selected_list_ids: 'blocking.listHeading', number: 'blocking.numberOrPrefix',
  description: 'blocking.description', match_type: 'blocking.matchType',
  username: 'authentication.username', password: 'authentication.password',
  current_password: 'settings.currentPassword', new_password: 'settings.newPasswordAtLeast12Characters',
  'ntfy.server': 'settings.ntfyServerUrl', 'ntfy.topic': 'settings.topic'
}
export function fieldNotice(item) {
  const context = item.ctx || {}
  const types = {
    missing: notice('validation.required'), string_too_short: notice('validation.minLength', { count: context.min_length }),
    string_too_long: notice('validation.maxLength', { count: context.max_length }),
    greater_than_equal: notice('validation.minValue', { min: context.ge }),
    less_than_equal: notice('validation.maxValue', { max: context.le }),
    string_pattern_mismatch: notice('validation.pattern'), int_parsing: notice('validation.number'),
    float_parsing: notice('validation.number'), bool_parsing: notice('validation.type'), literal_error: notice('validation.type')
  }
  return types[item.type] || item.msg
}
export function validationNotice(items) {
  return { i18nMessages: items.map(item => {
    const path = (item.loc || []).filter(part => part !== 'body').join('.')
    const key = validationFields[path]
    return notice('validation.fieldError', { field: key ? notice(key) : path || notice('validation.request'), detail: fieldNotice(item) })
  }) }
}
