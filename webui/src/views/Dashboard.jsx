import { useTranslation } from 'react-i18next'
import { tx, notice, renderNotice, statusLabel, errorNotice } from '../i18n/index.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import ProvisionModal from './ProvisionModal.jsx'
import SipInfoModal from './SipInfoModal.jsx'

function StateBadge({ st }) {
  useTranslation()
  const state = st?.state || 'STOPPED'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
      <span className={`dot st-${state}`} />
      {statusLabel('lineStatus', st?.state, st?.label || tx('dashboard.unknown'))}
    </span>
  )
}

const STEPS = [
  ['NO_CARD', 'dashboard.stepNO_CARD'],
  ['EPDG_UNRESOLVED', 'dashboard.stepEPDG_UNRESOLVED'],
  ['TUNNEL_DOWN', 'dashboard.stepTUNNEL_DOWN'],
  ['REGISTERING', 'dashboard.stepREGISTERING'],
  ['OK', 'dashboard.stepOK'],
]
const RANK = { STOPPED: -1, NO_CARD: 0, PIN_PROBLEM: 0, EPDG_UNRESOLVED: 1, TUNNEL_DOWN: 2, REGISTERING: 3, OK: 4 }

function Pipeline({ st }) {
  useTranslation()
  const rank = RANK[st?.state] ?? -1
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
      {STEPS.map(([k, label], idx) => {
        const done = rank > idx
        const cur = rank === idx
        const bg = done ? '#22c55e' : cur ? (st.state === 'OK' ? '#22c55e' : '#eab308') : "var(--border-strong)"
        return (
          <div key={k} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ height: 5, borderRadius: 3, background: bg }} />
            <div style={{ fontSize: 10, color: 'var(--text-mute)', marginTop: 4 }}>{tx(label)}</div>
          </div>
        )
      })}
    </div>
  )
}

// Build one row per PHYSICAL reader. Each reader has: {index, name, present, card, instance}.
// - present + matched instance  -> live line status
// - present + unprovisioned card -> provision prompt
// - no card                     -> empty state
// Provisioned lines whose reader is unplugged are NOT shown here — the dashboard
// reflects physical readers only (their config stays available under SIM Config, and
// the line reappears automatically when its reader/card returns).
function buildReaders(cards, instances) {
  return [...cards]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((c) => {
      let inst = null
      if (c.matched) inst = instances.find((i) => String(i.id) === String(c.matched))
      if (!inst && c.iccid) inst = instances.find((i) => i.iccid === c.iccid)
      return { index: c.index, name: c.name, present: !!c.present, card: c, instance: inst }
    })
}

function readerTitle(r) {
  const port = r.index != null ? tx("dashboard.reader", {value1: r.index}) : 'Reader'
  // "Alcor Link AK9563 00 00" — keep the human name after the port label
  return r.name ? `${port} · ${r.name}` : port
}

const PIN_RE = /^\d{4,8}$/  // basic client-side validity: 4–8 digits, numeric only

// A detected-but-unprovisioned SIM. Two states:
//  - LOCKED (PIN required, IMSI not yet readable): show basic info + a PIN field, no Provision.
//    Entering a correct PIN unlocks IMSI+SMSC on the backend and the card refreshes.
//  - READY (PIN disabled, or unlocked): show identity + SMSC, offer Provision.
function UnprovisionedCard({ card, refresh, onProvision }) {
  useTranslation()
  const [pinInput, setPinInput] = useState('')
  const [pin, setPin] = useState('')          // remembered correct PIN, forwarded to provisioning
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const unlocked = !!card.imsi                  // could read IMSI => PIN satisfied or disabled
  const pinOk = PIN_RE.test(pinInput)

  const unlock = async (e) => {
    e.stopPropagation()
    if (!pinOk) { setErr(notice("dashboard.pinMustBe48Digits")); return }
    setBusy(true); setErr('')
    try {
      const r = await api.verifyPin(pinInput, card.index, card.name)
      if (r.ok) { setPin(pinInput); await refresh() }   // card entry updates -> re-renders as READY
      else setErr(notice("dashboard.value0Value1",{value0:r.error,value1:r.tries != null ? notice("dashboard.triesLeft", {
  value1: r.tries
}) : ''}))
    } catch (e2) { setErr(errorNotice(e2)) }
    setBusy(false)
  }

  const row = (k, v, mono) => (<>
    <span style={{ color: 'var(--text-mute)' }}>{k}</span>
    <span className={mono ? 'mono' : ''} style={mono ? { fontSize: 11 } : undefined}>{v}</span>
  </>)

  if (!unlocked) {
    // LOCKED
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <div style={{ marginTop: 14, fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', color: 'var(--text-soft)' }}>
          {row('ICCID', card.iccid || '—', true)}
          {row('Status', <span style={{ color: '#eab308' }}>{tx("dashboard.simLockedPinRequired")}</span>)}
          {card.pin_tries != null && row(tx("dashboard.pinTries"), card.pin_tries)}
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--text-mute)' }}>{tx("dashboard.enterSimPinChv1")}</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input type="password" inputMode="numeric" value={pinInput} maxLength={8}
              onChange={(e) => { setPinInput(e.target.value.replace(/[^0-9]/g, '')); setErr('') }}
              onKeyDown={(e) => { if (e.key === 'Enter' && pinOk) unlock(e) }}
              placeholder={tx("dashboard.48Digits")} className="mono" style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={busy || !pinOk} onClick={unlock}>
              {busy ? tx("dashboard.unlocking") : tx("dashboard.unlock")}
            </button>
          </div>
          {pinInput && !pinOk && <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 6 }}>{tx("dashboard.pinMustBe48Digits")}</div>}
          {err && <div style={{ fontSize: 12.5, color: '#ef4444', marginTop: 8 }}>{renderNotice(err)}</div>}
        </div>
      </div>
    )
  }

  // READY (unlocked or PIN disabled)
  const smscMissing = !card.smsc
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div style={{ marginTop: 14, fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', color: 'var(--text-soft)' }}>
        {row('ICCID', card.iccid || '—', true)}
        {row('IMSI', card.imsi || '—', true)}
        {card.mcc && card.mnc && row('Carrier', `${card.mcc}-${card.mnc}`)}
        {row('SMSC', card.smsc
          ? <span className="mono">{card.smsc} <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.fromSim")}</span></span>
          : <span style={{ color: '#eab308' }}>{tx("dashboard.couldNotReadFromSimEnterManuallyWhenProvisioning")}</span>)}
        {row('PIN', card.pin_enabled === false ? tx("dashboard.disabled") : tx("dashboard.unlocked"))}
      </div>
      <button className="btn btn-primary" style={{ marginTop: 16 }}
        onClick={(e) => { e.stopPropagation(); onProvision(pin) }}>{tx("dashboard.provisionThisSim", {value1: smscMissing ? tx("dashboard.enterSmsc") : ''})}</button>
    </div>
  )
}

// A PIN prompt shown when starting a line whose card needs a PIN we don't have (deleted,
// or the saved one no longer verifies). Verifies + saves the PIN, then starts the line.
function StartPinModal({ inst, tries, error, onClose, onDone }) {
  useTranslation()
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(error || '')
  const ok = PIN_RE.test(pin)

  const submit = async () => {
    if (!ok) { setErr(notice("dashboard.pinMustBe48Digits")); return }
    setBusy(true); setErr('')
    try {
      await api.start(inst.id, { pin })
      onDone && await onDone()
      onClose()
    } catch (e) {
      const code = e?.data?.detail?.code
      if (code === 'pin_invalid' || /PIN error/i.test(e.message)) {
        const t = e?.data?.detail?.tries
        setErr(t != null ? notice('dashboard.wrongPinWithTries', {count: t}) : notice('dashboard.wrongPinPlain'))
      } else if (code === 'no_card') setErr(notice("dashboard.simCardIsNotPresentInTheReader"))
      else setErr(errorNotice(e))
      setPin('')
    }
    setBusy(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}>
      <div className="card" style={{ padding: 24, width: 380, maxWidth: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{tx("dashboard.enterSimPin")}</h2>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 14, lineHeight: 1.6 }}>{tx("dashboard.needsItsSimPinToStartNoValidSaved", {value1: inst?.name || tx("dashboard.line", {value1: inst?.id})})}</div>
        <input type="password" inputMode="numeric" className="mono" value={pin} maxLength={8} autoFocus
          onChange={(e) => { setPin(e.target.value.replace(/[^0-9]/g, '')); setErr('') }}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) submit() }}
          placeholder={tx("dashboard.48Digits")} style={{ width: '100%' }} />
        {tries != null && !err && <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 6 }}>{tx("dashboard.triesLeft3", {tries: tries})}</div>}
        {err && <div style={{ fontSize: 12.5, color: '#ef4444', marginTop: 8 }}>{renderNotice(err)}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>{tx("dashboard.cancel")}</button>
          <button className="btn btn-primary" disabled={busy || !ok} onClick={submit}>
            {busy ? tx("dashboard.starting") : tx("dashboard.unlockStart")}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Dashboard({ instances, cards = [], noReaders, cardsKnown, refresh, setSelected, selected, setView, showToast }) {
  useTranslation()
  const [busy, setBusy] = useState(null)
  const [provision, setProvision] = useState(null)
  const [sipInfo, setSipInfo] = useState(null)
  const [pinPrompt, setPinPrompt] = useState(null)   // {inst, tries, error} when a start needs a PIN

  // A start/reprovision may be refused (409) because the card needs a PIN we don't have
  // (deleted, or the saved one is now wrong). Surface that as a PIN prompt instead of an
  // opaque error; anything else is shown as an alert.
  const pinError = (e) => {
    const code = e?.data?.detail?.code
    return (code === 'pin_required' || code === 'pin_invalid')
      ? { code, tries: e.data.detail.tries } : null
  }

  const act = async (id, fn) => {
    setBusy(id)
    try { await fn(); await refresh() }
    catch (e) {
      const pe = pinError(e)
      if (pe) setPinPrompt({ inst: instances.find((i) => String(i.id) === String(id)), tries: pe.tries,
                             error: pe.code === 'pin_invalid' ? tx("dashboard.savedPinWasWrongEnterItAgain") : '' })
      else alert(e.message)
    }
    setBusy(null)
  }

  const rows = buildReaders(cards, instances)

  // Nothing known yet (first /api/cards still in flight) — render nothing instead of
  // flashing a wrong "no readers" message.
  if (!cardsKnown && rows.length === 0) {
    return <div style={{ color: 'var(--text-mute)', fontSize: 13 }}>{tx("dashboard.detectingCardReaders")}</div>
  }

  return (
    <div>
      {/* No PC/SC reader connected at all — friendly hint; the reader monitor updates
          this live, so the banner disappears the moment a reader is plugged in. */}
      {noReaders && (
        <div className="card" style={{ padding: '32px 28px', textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 36 }}>🔌</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>{tx("dashboard.noPcScSmartCardReaderFound")}</div>
          <div style={{ fontSize: 13, color: 'var(--text-mute)', marginTop: 8, lineHeight: 1.6, maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>{tx("dashboard.connectAUsbSmartCardReaderWithYourSim")}</div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(360px,1fr))', gap: 16 }}>
        {!noReaders && rows.length === 0 && (
          <div className="card" style={{ padding: 24, color: 'var(--text-dim)' }}>{tx("dashboard.noCardReadersDetectedPlugInAPcSc")}</div>
        )}
        {rows.map((r) => {
          const inst = r.instance
          const isSel = inst && selected?.id === inst.id
          const d = inst?.status?.detail || {}
          const clickable = !!inst
          return (
            <div key={`rdr-${r.name || r.index}`} className="card"
              onClick={() => clickable && setSelected(inst.id)}
              style={{ padding: 20, cursor: clickable ? 'pointer' : 'default',
                outline: isSel ? '2px solid var(--primary)' : '1px solid transparent', outlineOffset: 2 }}>

              {/* ---- Header: reader as the identity ---- */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{readerTitle(r)}</span>
                    {isSel && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', border: '1px solid var(--primary)', borderRadius: 6, padding: '1px 6px' }}>{tx("dashboard.active")}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 3 }}>
                    {inst ? (inst.name || tx("dashboard.line", {value1: inst.id})) : r.present ? tx("dashboard.unprovisionedSim") : tx("dashboard.empty")}
                  </div>
                </div>
                {inst
                  ? <StateBadge st={inst.status} />
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: r.present ? '#eab308' : 'var(--text-mute)' }}>
                      <span className={`dot st-${r.present ? 'REGISTERING' : 'NO_CARD'}`} />
                      {r.present ? tx("dashboard.simDetected") : tx("dashboard.noSimCard")}
                    </span>}
              </div>

              {/* ---- Provisioned line: pipeline + reason + details ---- */}
              {inst && (
                <>
                  <Pipeline st={inst.status} />
                  {inst.status?.state !== 'OK' && inst.status?.state !== 'STOPPED' && inst.status?.reason && (
                    <div style={{
                      marginTop: 12, padding: '8px 11px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.4,
                      color: 'var(--text-soft)',
                      background: inst.status.state === 'ERROR' ? 'rgba(239,68,68,.12)' : 'rgba(234,179,8,.12)',
                      border: '1px solid ' + (inst.status.state === 'ERROR' ? 'rgba(239,68,68,.45)' : 'rgba(234,179,8,.4)'),
                    }}>
                      {statusLabel('reasons', inst.status.reason_code, inst.status.reason)}
                      {inst.status.retry && inst.status.retry.count > 0 && inst.status.state !== 'ERROR' &&
                        <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.attempt", {count: inst.status.retry.count, max: inst.status.retry.max})}</span>}
                      {inst.status.state === 'ERROR' && setView &&
                        <span> · <a onClick={(e) => { e.stopPropagation(); setSelected(inst.id); setView('logs') }}
                          style={{ cursor: 'pointer', textDecoration: 'underline' }}>{tx("dashboard.viewLogs")}</a></span>}
                    </div>
                  )}
                  <div style={{ marginTop: 16, fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', color: 'var(--text-soft)' }}>
                    <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.carrier")}</span><span>{`${inst.mcc}-${inst.mnc}`}</span>
                    <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.number")}</span><span className="mono">{d.msisdn || inst.msisdn || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>IMSI</span><span className="mono" style={{ fontSize: 11 }}>{inst.imsi || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>ICCID</span><span className="mono" style={{ fontSize: 11 }}>{r.card?.iccid || inst.iccid || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>SMSC</span><span className="mono">{d.smsc || inst.smsc || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.pCscf")}</span><span className="mono" style={{ fontSize: 11 }}>{d.pcscf || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>{tx("dashboard.imsReg")}</span><span>{d.registration || '—'}</span>
                    <span style={{ color: 'var(--text-mute)' }}>PIN</span><span>{d.pin?.state || '—'}{d.pin?.tries_left != null ? tx("dashboard.tries", {value1: d.pin.tries_left}) : ''}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                    {inst.status?.state === 'STOPPED'
                      ? <button className="btn btn-primary" disabled={busy === inst.id} onClick={() => act(inst.id, () => api.start(inst.id))}>{tx("dashboard.start")}</button>
                      : inst.status?.state === 'ERROR'
                      ? <button className="btn btn-primary" disabled={busy === inst.id} onClick={() => act(inst.id, () => api.reprovision(inst.id))}>{tx("dashboard.reProvision")}</button>
                      : <button className="btn btn-ghost" disabled={busy === inst.id} onClick={() => act(inst.id, () => api.stop(inst.id))}>{tx("dashboard.stop")}</button>}
                    {inst.status?.state !== 'STOPPED' && inst.status?.state !== 'ERROR' &&
                      <button className="btn btn-ghost" disabled={busy === inst.id} onClick={() => act(inst.id, () => api.register(inst.id))}>{tx("dashboard.reRegister")}</button>}
                    {inst.status?.state !== 'STOPPED' && inst.status?.state !== 'ERROR' &&
                      <button className="btn btn-ghost" disabled={busy === inst.id} onClick={() => act(inst.id, () => api.reprovision(inst.id))}>{tx("dashboard.reProvision")}</button>}
                    <button className="btn btn-ghost" onClick={() => setSipInfo(inst)}>{tx("dashboard.sipInfo")}</button>
                    <button className="btn btn-ghost" onClick={() => { setSelected(inst.id); setView && setView('sims') }}>{tx("dashboard.configure")}</button>
                  </div>
                </>
              )}

              {/* ---- Unprovisioned card in this reader (PIN-gated flow) ---- */}
              {!inst && r.present && (
                <UnprovisionedCard card={r.card} refresh={refresh}
                  onProvision={(pin) => setProvision({ card: r.card, pin })} />
              )}

              {/* ---- Empty reader ---- */}
              {!inst && !r.present && (
                <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-mute)' }}>{tx("dashboard.noSimCardInsertedInThisReader")}</div>
              )}
            </div>
          )
        })}
      </div>
      {provision && <ProvisionModal card={provision.card} pin={provision.pin}
        onClose={() => setProvision(null)} onDone={refresh} />}
      {sipInfo && <SipInfoModal instance={sipInfo} onClose={() => setSipInfo(null)}
        setView={setView} setSelected={setSelected} />}
      {pinPrompt && <StartPinModal inst={pinPrompt.inst} tries={pinPrompt.tries} error={pinPrompt.error}
        onClose={() => setPinPrompt(null)} onDone={refresh} />}
    </div>
  )
}
