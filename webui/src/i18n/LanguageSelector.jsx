import React from 'react'
import { useTranslation } from 'react-i18next'
import { changeLanguage } from './index.js'
export default function LanguageSelector() {
  const { t, i18n } = useTranslation()
  return <label className="language-selector"><span>{t('common.language')}</span><select aria-label={t('common.language')} value={i18n.resolvedLanguage || 'en'} onChange={e => changeLanguage(e.target.value)}><option value="ru">Русский</option><option value="fr">Français</option><option value="en">English</option></select></label>
}
