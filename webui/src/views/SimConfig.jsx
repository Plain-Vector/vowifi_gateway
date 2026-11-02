import { useTranslation } from 'react-i18next'
import { tx, RichMessage, notice, renderNotice, errorNotice } from '../i18n/index.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import SimSelector from './SimSelector.jsx'

const PANI_ACCESS_TYPES = [
  'IEEE-802.11', 'IEEE-802.11a', 'IEEE-802.11b', 'IEEE-802.11g', 'IEEE-802.11n',
  'IEEE-802.11ac', 'IEEE-802.11ax', 'IEEE-802.11be', '3GPP-WLAN',
]

// Preview-only MCC→ISO hints (authoritative table lives in control/app/mcc_country.py).
const PREVIEW_MCC_ISO = {
  '202': 'GR', '204': 'NL', '206': 'BE', '208': 'FR', '214': 'ES', '216': 'HU',
  '219': 'HR', '222': 'IT', '226': 'RO', '228': 'CH', '230': 'CZ', '232': 'AT',
  '234': 'GB', '235': 'GB', '238': 'DK', '240': 'SE', '242': 'NO', '244': 'FI',
  '250': 'RU', '255': 'UA', '260': 'PL', '262': 'DE', '268': 'PT', '272': 'IE',
  '286': 'TR', '302': 'CA', '310': 'US', '311': 'US', '312': 'US', '313': 'US',
  '314': 'US', '315': 'US', '316': 'US', '334': 'MX', '404': 'IN', '405': 'IN',
  '440': 'JP', '441': 'JP', '450': 'KR', '454': 'HK', '455': 'MO', '460': 'CN',
  '461': 'CN', '466': 'TW', '502': 'MY', '505': 'AU', '510': 'ID', '515': 'PH',
  '520': 'TH', '525': 'SG', '530': 'NZ', '602': 'EG', '655': 'ZA', '724': 'BR',
}

const emptyInstance = () => ({
  id: '', name: '', imsi: '', mcc: '', mnc: '', imei: '', imeisv: '', pin: '', reader: '',
  reader_index: 0, reader_port: '', msisdn: '', smsc: '', enabled: true, apn: 'ims', idr_mode: 'apn', cp_mode: 'auto',
  use_reauth_id: true,
  sip: {
    listen_addr: '0.0.0.0', transport: 'udp', external: [], webrtc: { enable: true },
    pani_country_enable: true, pani_country: '',
    pani_node_id_enable: false, pani_node_id: '',
    pani_access_type: 'IEEE-802.11',
  },
  debug: { asterisk: true, charon: false },
})

function Field({ label, children }) {
  useTranslation()
  const id = React.useId()
  const controls = React.Children.map(children, (child, index) => React.isValidElement(child) && ['input', 'select', 'textarea'].includes(child.type) ? React.cloneElement(child, { id: child.props.id || id + '-' + index }) : child)
  const target = React.Children.toArray(controls).find(child => React.isValidElement(child) && ['input', 'select', 'textarea'].includes(child.type))
  return <div><label htmlFor={target?.props.id}>{label}</label>{controls}</div>
}

function normalizePreviewCountry(c) {
  const s = String(c || '').trim().toUpperCase().replace(/[^A-Z]/g, '')
  return s.length === 2 ? s : ''
}

function normalizePreviewNodeId(m) {
  const s = String(m || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return /^[0-9a-f]{12}$/.test(s) ? s : ''
}

/** Client-side preview of the P-Access-Network-Info header that will be sent. */
function previewPani(sip, mcc) {
  const s = sip || {}
  if ((s.pani || '').trim()) return s.pani.trim()
  const parts = [s.pani_access_type || 'IEEE-802.11']
  if (s.pani_country_enable !== false) {
    let c = normalizePreviewCountry(s.pani_country)
    if (!c) {
      const key = String(mcc || '').replace(/\D/g, '').slice(0, 3).padStart(3, '0')
      c = PREVIEW_MCC_ISO[key] || ''
    }
    if (c) parts.push(`country=${c}`)
    else if (mcc) parts.push('country=<from SIM MCC>')
  }
  if (s.pani_node_id_enable) {
    const n = normalizePreviewNodeId(s.pani_node_id)
    if (n) parts.push(`i-wlan-node-id=${n}`)
  }
  return parts.join(';')
}

function sipUsernameConflict(sip) {
  const accounts = sip?.external || []
  const webrtcUser = String(sip?.webrtc?.username || 'webrtc').trim()
  const reserved = new Set([
    'global', 'system', 'volte_ims', 'endpoint-local', 'auth-local', 'aor-local',
    'transport-local', 'transport-wss', webrtcUser,
  ].filter(Boolean))
  const seen = new Map()
  for (let i = 0; i < accounts.length; i++) {
    const username = String(accounts[i]?.username || '').trim()
    if (!username) continue
    if (reserved.has(username)) {
      return tx("sim.sipUsernameIsReservedForTheBuiltInSoftphone", {username: username})
    }
    if (seen.has(username)) {
      return tx("sim.sipUsernameIsUsedMoreThanOnceAccountsAnd", {username: username, value2: seen.get(username) + 1, value3: i + 1})
    }
    seen.set(username, i)
  }
  return ''
}

export default function SimConfig({ instances, selected, refresh, cards, setSelected }) {
  const localizationId = React.useId()
  useTranslation()
  const [readers, setReaders] = useState([])
  const [card, setCard] = useState(null)
  const [pin, setPin] = useState('')
  const [pinMsg, setPinMsg] = useState('')
  const [form, setForm] = useState(emptyInstance())
  const [saving, setSaving] = useState(false)
  const [smscMode, setSmscMode] = useState('auto')   // 'auto' = read from SIM, 'manual' = typed

  // Refresh the physical-reader list whenever the detected-card set changes (hotplug), so
  // the reader picker never lists a reader that has been unplugged.
  useEffect(() => { api.readers().then((r) => setReaders(r.readers)).catch(() => {}) }, [cards.map((c) => c.name).join(',')])
  useEffect(() => {
    if (!selected) return
    // Deep-merge sip so new PANI knobs keep their defaults when an older saved
    // instance has no pani_* keys yet (shallow spread would drop emptyInstance.sip).
    const base = emptyInstance()
    setForm({ ...base, ...selected, sip: { ...base.sip, ...(selected.sip || {}) } })
  }, [selected?.id])
  // Keep the reader selection valid for the CURRENT hardware. A stored reader_index can be
  // stale — saved when more readers were attached — and point past the live reader list; the
  // <select> then has no matching option and "Detect card" probes a phantom reader ("No SIM
  // card in reader N"). Clamp any out-of-range index back onto a reader that actually exists.
  useEffect(() => {
    if (!readers.length) return
    setForm((f) => (f.reader_index >= readers.length || f.reader_index < 0)
      ? { ...f, reader_index: 0 } : f)
  }, [readers.length])
  // Keep the "PIN saved?" indicator in sync when it changes server-side (delete-PIN,
  // start-with-PIN) without a full line switch — mirror the fresh value onto the form.
  useEffect(() => { if (selected) setForm((f) => ({ ...f, has_pin: selected.has_pin })) }, [selected?.has_pin])

  const upd = (patch) => setForm((f) => ({ ...f, ...patch }))
  const updSip = (patch) => setForm((f) => ({ ...f, sip: { ...f.sip, ...patch } }))
  // The reader index to act on, clamped to a reader that currently exists (never probe a
  // stale/out-of-range index that would report a phantom empty reader).
  const readerIdx = () => (form.reader_index >= 0 && form.reader_index < readers.length) ? form.reader_index : 0
  // Stable USB port path of a reader index (from the live card monitor). A line binds to this
  // port, not the enumeration index, so it sticks to the physical reader socket even when pcscd
  // re-enumerates two identical readers in a different order.
  const portForIdx = (i) => (cards.find((c) => c.index === i) || {}).reader_port || ''

  const detect = async () => {
    setPinMsg(notice("sim.detecting"))
    try {
      const c = await api.detect(readerIdx())
      setCard(c)
      if (!c.present) {
        setPinMsg(notice("sim.noSimCardInThisReader"))
        return
      }
      const patch = { imsi: c.imsi || form.imsi, mcc: c.mcc || form.mcc, mnc: c.mnc || form.mnc }
      if (c.smsc && smscMode === 'auto') patch.smsc = c.smsc   // SMSC from the SIM (EF_SMSP)
      if (c.imsi) patch.reader = `imsi:${c.imsi}`
      // Bind the line to the reader's stable physical USB port (from the detected card, else the
      // live monitor). Persisted so start-time re-resolves the correct index for this socket.
      const port = c.reader_port || portForIdx(readerIdx())
      if (port) patch.reader_port = port
      if (!form.id) patch.id = String(instances.length + 1)
      upd(patch)
      setPinMsg(c.imsi ? notice("sim.cardRead") : notice("sim.cardPresentEnterPinToReadImsiIccidTries", {
  value1: c.iccid || '?',
  value2: c.pin_tries ?? '?'
}))
    } catch (e) { setPinMsg(notice("sim.errorValue0",{value0:e.message})) }
  }

  const verifyPin = async () => {
    setPinMsg(notice("sim.verifying"))
    try {
      const r = await api.verifyPin(pin, readerIdx())
      setPinMsg(r.ok ? notice("sim.pinOk") : notice("sim.failedTriesLeft", {
  value1: r.error,
  value2: r.tries
}))
      if (r.ok) {
        const p = { pin }
        if (r.card?.smsc && smscMode === 'auto') p.smsc = r.card.smsc   // now-readable SMSC from SIM
        upd(p)
        await detect()
      }
    } catch (e) { setPinMsg(notice("sim.errorValue0",{value0:e.message})) }
  }

  const save = async () => {
    setSaving(true)
    try {
      const sipError = sipUsernameConflict(form.sip)
      if (sipError) throw new Error(sipError)
      const body = { ...form, mnc: String(form.mnc).padStart(3, '0') }
      // Strip runtime-only fields that ride along on the instance object from /api/instances
      // (they are computed per-request, not config — never persist them).
      delete body.status; delete body.has_pin
      // Never send an empty PIN — the stored PIN (tied to this IMSI) must survive edits to
      // unrelated fields. `pin` state is only set when the user re-enters/verifies a PIN
      // here; only then do we forward it to update the saved credential.
      delete body.pin
      if (pin) body.pin = pin
      // An empty password field means "keep the saved secret", not "replace it with
      // empty". A deliberate password change is sent normally.
      if (body.sip) {
        body.sip = {
          ...body.sip,
          external: (body.sip.external || []).map((account) => {
            const row = { username: account.username || '' }
            if (String(account.password || '').trim()) row.password = account.password
            return row
          }),
        }
      }
      const res = await api.saveInstance(body)
      await refresh()
      if (res?.restart_required) {
        const message = notice("sim.savedRestartThisLineStopStartForSipImei")
        setPinMsg(message)
        alert(renderNotice(message))
      } else {
        setPinMsg(notice("sim.saved"))
      }
    } catch (e) { setPinMsg(errorNotice(e)); alert(e.message) }
    setSaving(false)
  }

  const del = async () => {
    if (!confirm(tx("sim.deleteThisInstance"))) return
    await api.deleteInstance(form.id); await refresh(); setForm(emptyInstance())
  }

  const deleteSavedPin = async () => {
    if (!form.id) return
    if (!confirm(tx("sim.deleteTheSavedSimPinForThisLineThe2", {}))) return
    try {
      const r = await api.clearPin(form.id)
      upd({ has_pin: false })          // reflect immediately (form is local state)
      await refresh()
      setPinMsg(r.had_pin ? notice("sim.savedPinDeletedTheLineWillAskForIt") : notice("sim.noSavedPinToDelete"))
    } catch (e) { alert(e.message) }
  }

  const addAccount = () => updSip({ external: [...(form.sip.external || []), { username: '', password: '' }] })
  const setAccount = (i, k, v) => updSip({ external: form.sip.external.map((a, idx) => idx === i ? { ...a, [k]: v } : a) })
  const sipUserError = sipUsernameConflict(form.sip)

  return (
    <div className="sim-config-page localized-form" style={{ maxWidth: 1000 }}>
      {instances.length > 1 &&
        <SimSelector instances={instances} cards={cards} selected={selected} setSelected={setSelected} labelKey="lineSelector.config" />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Card / PIN panel */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("sim.simCard")}</h3>
        <Field label={tx("sim.reader")}>
          <select value={form.reader_index} onChange={(e) => upd({ reader_index: +e.target.value, reader_port: portForIdx(+e.target.value) || form.reader_port })}>
            {readers.map((r, i) => <option key={i} value={i}>{i}: {r}{portForIdx(i) ? tx("sim.usb", {value1: portForIdx(i)}) : ''}</option>)}
            {readers.length === 0 && <option>{tx("sim.noReaders")}</option>}
          </select>
        </Field>
        {form.reader_port &&
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}>{tx("sim.boundToUsbPortStableAcrossReaderReEnumeration", {reader_port: form.reader_port})}</div>}
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={detect}>{tx("sim.detectCard")}</button>
        {card && (
          <div className="mono" style={{ fontSize: 12, color: card.present ? 'var(--text-dim)' : '#ef4444', marginTop: 12, lineHeight: 1.6 }}>
            {card.present ? (<>{tx("sim.iccid")}{card.iccid || '—'}<br />{tx("sim.imsi2")}{card.imsi || tx("sim.locked")}<br />
              {card.reader_port && <>{tx("sim.usbPort")}{card.reader_port}<br /></>}{tx("sim.pin")}{card.pin_enabled ? tx("sim.enabledTries", {value1: card.pin_tries}) : tx("sim.disabled")}
            </>) : (<>{tx("sim.noSimCardInReader")}{card.reader_index}.</>)}
          </div>
        )}
        <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />
        <Field label={tx("sim.pinChv1")}>
          <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={tx("sim.eG123456")} />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={verifyPin} disabled={!pin}>{tx("sim.verifyPin")}</button>
          {form.id && form.has_pin &&
            <button className="btn btn-ghost" style={{ color: '#ef4444' }} onClick={deleteSavedPin}>{tx("sim.deleteSavedPin")}</button>}
        </div>
        {form.id && (
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginTop: 8 }}>
            {form.has_pin
              ? tx("sim.aPinIsSavedForThisLineAndUsed")
              : tx("sim.noPinSavedYouLlBeAskedForIt")}
          </div>
        )}
        {pinMsg && <div style={{ fontSize: 13, marginTop: 10, color: ['sim.pinOk', 'sim.cardRead', 'sim.saved', 'sim.savedRestartThisLineStopStartForSipImei', 'sim.savedPinDeletedTheLineWillAskForIt'].includes(pinMsg?.i18nKey) ? '#22c55e' : '#eab308' }}>{renderNotice(pinMsg)}</div>}
      </div>

      {/* Instance form */}
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("sim.lineConfiguration")}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={tx("sim.instanceId")}><input value={form.id} onChange={(e) => upd({ id: e.target.value })} placeholder="1" /></Field>
          <Field label={tx("sim.name")}><input value={form.name} onChange={(e) => upd({ name: e.target.value })} placeholder={tx("sim.telus")} /></Field>
          <Field label="IMSI"><input className="mono" value={form.imsi} onChange={(e) => upd({ imsi: e.target.value })} /></Field>
          <Field label="MCC"><input value={form.mcc} onChange={(e) => upd({ mcc: e.target.value })} /></Field>
          <Field label="MNC"><input value={form.mnc} onChange={(e) => upd({ mnc: e.target.value })} /></Field>
          <Field label="IMEI"><input className="mono" value={form.imei} onChange={(e) => upd({ imei: e.target.value })} placeholder="35123456-789012-3" /></Field>
          <Field label="IMEISV"><input className="mono" value={form.imeisv || ''} onChange={(e) => upd({ imeisv: e.target.value.replace(/[^0-9]/g, '') })} maxLength={16} placeholder={tx("sim.autoFromImeiDeviceIdentity")} /></Field>
          <Field label={tx("sim.phoneNumberMsisdn")}><input className="mono" value={form.msisdn} onChange={(e) => upd({ msisdn: e.target.value })} placeholder={tx("sim.autoLearned")} /></Field>
          <Field label={tx("sim.smsCentreSmsc")}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 13 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="radio" name="scmode" checked={smscMode === 'auto'} style={{ width: 'auto' }}
                  onChange={() => { setSmscMode('auto'); if (card?.smsc) upd({ smsc: card.smsc }) }} />{tx("sim.autoFromSim")}</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input type="radio" name="scmode" checked={smscMode === 'manual'} style={{ width: 'auto' }}
                  onChange={() => setSmscMode('manual')} />{tx("sim.manual")}</label>
            </div>
            <input className="mono" value={form.smsc} readOnly={smscMode === 'auto'}
              onChange={(e) => upd({ smsc: e.target.value })}
              placeholder={smscMode === 'auto' ? tx("sim.detectCardVerifyPinToReadFromSim") : '+1...'}
              style={smscMode === 'auto' ? { opacity: .7 } : undefined} />
          </Field>
          <Field label={tx("sim.readerMatch")}><input className="mono" value={form.reader} onChange={(e) => upd({ reader: e.target.value })} placeholder={"imsi:302..."} /></Field>
          <Field label="APN"><input className="mono" value={form.apn ?? 'ims'} onChange={(e) => upd({ apn: e.target.value })} placeholder={tx("sim.ims")} /></Field>
          <Field label={tx("sim.epdgIdentityIdr")}>
            <select value={form.idr_mode ?? 'apn'} onChange={(e) => upd({ idr_mode: e.target.value })}>
              <option value="apn">{tx("sim.bareApnDefault")}</option>
              <option value="fqdn">{tx("sim.apnFqdn")}</option>
            </select>
          </Field>
          <Field label={tx("sim.imsAddressFamilyCp")}>
            <select value={form.cp_mode ?? 'auto'} onChange={(e) => upd({ cp_mode: e.target.value })}>
              <option value="auto">{tx("sim.autoDetectRecommended")}</option>
              <option value="dual">{tx("sim.dualStackIpv4Ipv6")}</option>
              <option value="v6">{tx("sim.ipv6Only")}</option>
              <option value="v4">{tx("sim.ipv4Only")}</option>
            </select>
            {form.cp_mode && form.cp_mode !== 'auto' && form.cp_mode_source === 'auto' && (
              <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 2 }}>{tx("sim.autoDetectedSwitchBackToAutoDetectToRe", {value1: form.cp_mode.toUpperCase()})}</div>
            )}
          </Field>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}><RichMessage id="sim.idrIsHowTheApnIsPresentedToThe" values={{apnExample: '<apn>.apn.epc.mnc…mcc….pub.3gppnetwork.org'}} components={[<b>Bare APN</b>, <b>APN-FQDN</b>, <code>&lt;apn&gt;.apn.epc.mnc…mcc….pub.3gppnetwork.org</code>]} /></div>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}><RichMessage id="sim.imsAddressFamilyMustMatchTheCarrierSIms" components={[<b>IMS address family</b>, <b>Auto-detect</b>]} /></div>

        <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }}
            checked={form.use_reauth_id !== false}
            onChange={(e) => upd({ use_reauth_id: e.target.checked })} />{tx("sim.useEapAkaFastReAuthentication")}</label>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4 }}><RichMessage id="sim.onByDefaultAfterASuccessfulAttachTheCarrier" components={[<b>off</b>]} /></div>

        <h4 style={{ marginBottom: 6 }}>{tx("sim.localSipAccess")}</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={tx("sim.listenAddress")}>
            <select value={form.sip.listen_addr} onChange={(e) => updSip({ listen_addr: e.target.value })}>
              <option value="0.0.0.0">{tx("sim.0000All")}</option>
              <option value="127.0.0.1">{tx("sim.127001Local")}</option>
              {selected?.status && <option value="lan">LAN IP</option>}
            </select>
          </Field>
          <Field label={tx("sim.transport")}>
            <select value={form.sip.transport} onChange={(e) => updSip({ transport: e.target.value })}>
              <option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option>
            </select>
          </Field>
        </div>
        <label style={{ marginTop: 8 }}>
          <input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!form.sip.webrtc?.enable}
            onChange={(e) => updSip({ webrtc: { ...form.sip.webrtc, enable: e.target.checked } })} />{tx("sim.enableBrowserSoftphoneWebrtc")}</label>

        <div style={{ marginTop: 12 }}>
          <label htmlFor={localizationId + '-1'}>{tx("sim.deviceUserAgentIdentifyToTheCarrierAsThis")}</label>
          <input id={localizationId + '-1'} className="mono" value={form.sip.user_agent || ''} onChange={(e) => updSip({ user_agent: e.target.value })} placeholder={"iOS/26.6 iPhone"} />
        </div>

        <h4 style={{ marginBottom: 6, marginTop: 16 }}>P-Access-Network-Info</h4>
        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 8 }}><RichMessage id="sim.sentOnImsRegisterSipToIdentifyTheWi" values={{headerExample: 'IEEE-802.11;country=<SIM home country>'}} components={[<code style={{
  marginLeft: 4
}}>IEEE-802.11;country=&lt;SIM home country&gt;</code>]} /></div>
        <Field label={tx("sim.accessType")}>
          <select value={form.sip.pani_access_type || 'IEEE-802.11'}
            onChange={(e) => updSip({ pani_access_type: e.target.value })}>
            {PANI_ACCESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }}
            checked={form.sip.pani_country_enable !== false}
            onChange={(e) => updSip({ pani_country_enable: e.target.checked })} />{tx("sim.reportCountryCode")}</label>
        {form.sip.pani_country_enable !== false && (
          <div style={{ marginTop: 6 }}>
            <input className="mono" maxLength={2}
              value={form.sip.pani_country || ''}
              onChange={(e) => updSip({ pani_country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })}
              placeholder={tx("sim.simMccGb")} />
          </div>
        )}
        <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }}
            checked={!!form.sip.pani_node_id_enable}
            onChange={(e) => updSip({ pani_node_id_enable: e.target.checked })} />{tx("sim.reportWiFiApBssidIWlanNodeId")}</label>
        {!!form.sip.pani_node_id_enable && (
          <div style={{ marginTop: 6 }}>
            <input className="mono"
              value={form.sip.pani_node_id || ''}
              onChange={(e) => updSip({ pani_node_id: e.target.value })}
              placeholder={"000cf1126028"} />
          </div>
        )}
        <div className="mono" style={{ marginTop: 10, fontSize: 12, padding: '8px 10px',
          background: 'var(--bg-elev, rgba(0,0,0,.25))', borderRadius: 6, color: 'var(--text-dim)' }}>{tx("sim.previewPAccessNetworkInfo", {value1: previewPani(form.sip, form.mcc)})}</div>

        <div style={{ marginTop: 12 }}>
          <label>{tx("sim.externalSipAccounts")}</label>
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 6 }}>{tx("sim.eachAccountNeedsAUniqueUsernameAndCannotReuse")}</div>
          {(form.sip.external || []).map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input placeholder={tx("sim.username")} value={a.username} onChange={(e) => setAccount(i, 'username', e.target.value)} />
              <input type="password" placeholder={tx("sim.password")} value={a.password} onChange={(e) => setAccount(i, 'password', e.target.value)} />
            </div>
          ))}
          {sipUserError && (
            <div style={{ color: '#ef4444', fontSize: 12.5, marginTop: 6 }} role="alert">
              {sipUserError}
            </div>
          )}
          <button className="btn btn-ghost" onClick={addAccount}>{tx("sim.addAccount")}</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.id || !form.imsi}>{tx("sim.save")}</button>
          {form.id && <button className="btn btn-danger" onClick={del}>{tx("sim.delete")}</button>}
        </div>
      </div>
      </div>
    </div>
  )
}
