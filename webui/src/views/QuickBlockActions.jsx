import React, { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api.js'
import { tx, notice, errorNotice, renderNotice } from '../i18n/index.js'

export const communicationLabels = { calls: 'sms.calls', sms: 'sms.smsOnly', both: 'sms.both' }
export function CommunicationSelect({ value, onChange, disabled = false }) {
  return <label>{tx('sms.applyTo')}<select aria-label={tx('sms.applyTo')} disabled={disabled} value={value} onChange={e => onChange(e.target.value)}>
    {Object.entries(communicationLabels).map(([value, label]) => <option key={value} value={value}>{tx(label)}</option>)}
  </select></label>
}

export default function QuickBlockActions({ instance, peer, context = 'calls', showToast }) {
  useTranslation()
  const titleId = useId()
  const [action, setAction] = useState(null)
  const [communication, setCommunication] = useState(context)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const dialog = useRef(null)
  const trigger = useRef(null)
  useEffect(() => {
    if (!action) return
    trigger.current = document.activeElement
    dialog.current?.querySelector('select')?.focus()
    return () => trigger.current?.focus()
  }, [action])
  function open(event, action) { event.stopPropagation(); setError(null); setCommunication(context); setAction(action) }
  return <>
    <button className="btn btn-ghost" onClick={e => open(e, 'block')}>{tx('sms.blockNumber')}</button>
    <button className="btn btn-ghost" onClick={e => open(e, 'unblock')}>{tx('sms.unblockNumber')}</button>
    {action && <div style={{ position: 'fixed', inset: 0, background: '#0008', zIndex: 1000, display: 'grid', placeItems: 'center' }} onClick={e => e.stopPropagation()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="card" style={{ maxWidth: 480, margin: 16 }} onKeyDown={e => {
        if (e.key === 'Escape' && !busy) setAction(null)
        if (e.key === 'Tab') {
          const elements = [...dialog.current.querySelectorAll('button:not(:disabled),select:not(:disabled)')]
          const first = elements[0], last = elements.at(-1)
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <h2 id={titleId}>{tx(action === 'block' ? 'sms.blockQuestion' : 'sms.unblockQuestion')}</h2>
        <p className="mono">{peer}</p>
        <CommunicationSelect value={communication} onChange={setCommunication} disabled={busy} />
        <p>{tx('sms.quickHelp')}</p>
        {error && <p role="alert">{renderNotice(error)}</p>}
        <div className="blocking-row">
          <button className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try {
              await api.blocking('POST', '/quick-rule', { scope: String(instance), number: peer, communication, action })
              showToast?.(notice('sms.ruleUpdated')); setAction(null)
            } catch (error) { setError(errorNotice(error)) }
            finally { setBusy(false) }
          }}>{tx(action === 'block' ? 'sms.blockNumber' : 'sms.unblockNumber')}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setAction(null)}>{tx('blocking.cancel')}</button>
        </div>
      </div>
    </div>}
  </>
}
