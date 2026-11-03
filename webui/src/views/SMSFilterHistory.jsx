import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api.js'
import { tx, formatDate, errorNotice, renderNotice, decisionReason } from '../i18n/index.js'
import { modes } from './blockingPresentation.js'

export default function SMSFilterHistory({ instances }) {
  useTranslation()
  const [instance, setInstance] = useState('')
  const [decision, setDecision] = useState('')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState({ events: [], has_more: false })
  const [error, setError] = useState(null)
  useEffect(() => {
    let current = true
    async function load() {
      try {
        const query = new URLSearchParams({ limit: 50, offset })
        if (instance) query.set('instance', instance)
        if (decision) query.set('decision', decision)
        const response = await api.blocking('GET', '/sms-events?' + query)
        if (current) { setData(response); setError(null) }
      } catch (error) { if (current) setError(errorNotice(error)) }
    }
    load(); const timer = setInterval(load, 25000)
    return () => { current = false; clearInterval(timer) }
  }, [instance, decision, offset, refresh])
  return <section id="sms-history" className="card blocking-card" aria-label={tx('sms.history')}>
    <h2>{tx('sms.history')}</h2><p>{tx('sms.historyHelp')}</p>
    <div className="blocking-row">
      <label>{tx('blocking.line')}<select aria-label={tx('sms.historySim')} value={instance} onChange={e => { setInstance(e.target.value); setOffset(0) }}>
        <option value="">{tx('blocking.allSims')}</option>{instances.map(i => <option key={i.id} value={String(i.id)}>{i.name || i.id}</option>)}
      </select></label>
      <label>{tx('blocking.decision')}<select aria-label={tx('sms.historyDecision')} value={decision} onChange={e => { setDecision(e.target.value); setOffset(0) }}>
        <option value="">{tx('blocking.allDecisions')}</option><option value="allowed">{tx('blocking.allowed')}</option><option value="suppressed">{tx('sms.suppressed')}</option>
      </select></label>
    </div>
    {error && <p role="alert">{renderNotice(error)}</p>}
    <div className="blocking-table"><table><thead><tr>{['blocking.dateTime','blocking.line','sms.sender','blocking.matchedRule','sms.mode','blocking.decision'].map(key => <th key={key}>{tx(key)}</th>)}</tr></thead>
      <tbody>{data.events.map(event => <tr key={event.id}><td>{formatDate(event.ts * 1000)}</td><td>{instances.find(i => String(i.id) === event.instance)?.name || event.instance}</td><td>{event.peer}</td><td>{event.decision.rule || '—'}</td><td>{tx(modes[event.decision.mode])}</td><td>{tx(event.decision.action === 'reject' ? 'sms.suppressed' : 'blocking.allowed')} — {decisionReason(event.decision.reason)}</td></tr>)}</tbody>
    </table></div>
    {!data.events.length && <p>{tx('blocking.noEvents')}</p>}
    <div className="blocking-row"><button className="btn btn-ghost" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>{tx('blocking.previous')}</button><button className="btn btn-ghost" disabled={!data.has_more} onClick={() => setOffset(offset + 50)}>{tx('blocking.next')}</button><button className="btn btn-ghost" onClick={() => setRefresh(value => value + 1)}>{tx('blocking.refreshHistory')}</button></div>
  </section>
}
