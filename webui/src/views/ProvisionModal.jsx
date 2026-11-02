import { useTranslation } from 'react-i18next'
import { tx, RichMessage, notice, renderNotice, errorNotice } from '../i18n/index.js'
import React, { useState, useEffect } from 'react'
import { api } from '../api.js'

const PIN_RE = /^\d{4,8}$/
const PORT_RE = /^\d{1,5}$/

// Final provisioning confirmation for a detected SIM. The PIN was already entered/verified
// on the dashboard card (passed in as `pin`); we collect IMEI + device identity + SIP options
// and confirm the SMSC. SMSC is auto (read from the SIM's EF_SMSP) or manual — no carrier preset.
export default function ProvisionModal({ card, pin: pinProp, onClose, onDone }) {
  const localizationId = React.useId()
  useTranslation()
  const simSmsc = card.smsc || ''
  const [f, setF] = useState({
    name: '', imei: '', imeisv: '', webrtc: true, transport: 'udp', listen_addr: '0.0.0.0',
    user_agent: 'iOS/26.6 iPhone',
    apn: 'ims',                              // VoWiFi APN (default IMS APN)
    idrMode: 'apn',                          // ePDG IDr encoding: 'apn' (bare, default) | 'fqdn'
    cpMode: 'auto',                          // IMS PDN address family: 'auto' (default) | 'dual' | 'v6' | 'v4'
    smscMode: simSmsc ? 'auto' : 'manual',   // force manual if the SIM didn't yield one
    smscManual: '',
    portMode: 'auto',                        // 'auto' (conflict-checked) | 'manual'
    sipPort: '',                             // manual SIP UDP port
    pin: pinProp || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [autoPort, setAutoPort] = useState(null)   // {auto_sip_udp, auto_sip_tls, min, max}
  const upd = (p) => setF((x) => ({ ...x, ...p }))

  // Fetch the port the automatic allocator would pick right now (also used as the manual
  // field's placeholder/default). Best-effort; the modal still works if it fails.
  useEffect(() => {
    let alive = true
    api.portsSuggest().then((p) => { if (alive) setAutoPort(p) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const needPin = card.pin_enabled !== false     // PIN-enabled (or unknown) => provisioning needs it
  const pinOk = !needPin || PIN_RE.test(f.pin)
  const manualOk = f.smscMode !== 'manual' || f.smscManual.trim().length > 0
  const portMin = autoPort?.min ?? 1024, portMax = autoPort?.max ?? 65535
  const portNum = parseInt(f.sipPort, 10)
  const portOk = f.portMode !== 'manual' ||
    (PORT_RE.test(f.sipPort) && portNum >= portMin && portNum <= portMax)

  const submit = async () => {
    if (!f.imei) return setErr(notice("provisioning.imeiIsRequired"))
    if (needPin && !PIN_RE.test(f.pin)) return setErr(notice("provisioning.aValidSimPin48DigitsIsRequired"))
    if (f.smscMode === 'manual' && !f.smscManual.trim()) return setErr(notice("provisioning.enterTheSmsCentreNumberOrSwitchToAuto"))
    if (f.portMode === 'manual' && !portOk) return setErr(notice("provisioning.enterAValidSipPort", {
  portMin: portMin,
  portMax: portMax
}))
    setBusy(true); setErr('')
    try {
      const body = {
        reader_index: card.index, reader: card.name,   // name re-resolves the index server-side
        pin: f.pin, imei: f.imei, imeisv: f.imeisv.trim() || undefined, name: f.name,
        apn: f.apn.trim() || 'ims', idr_mode: f.idrMode, cp_mode: f.cpMode,
        smsc: f.smscMode === 'manual' ? f.smscManual.trim() : undefined,   // undefined => backend reads SIM
        webrtc: f.webrtc,
        port_mode: f.portMode,
        sip_port: f.portMode === 'manual' ? portNum : undefined,
        sip: { listen_addr: f.listen_addr, transport: f.transport, external: [],
               user_agent: f.user_agent, webrtc: { enable: f.webrtc } },
      }
      await api.provision(body)
      onDone && onDone()
      onClose()
    } catch (e) {
      // Backend signals an unreadable SIM SMSC with 422 — switch the user to manual entry.
      if (e.status === 422 && /smsc/i.test(e.message)) {
        upd({ smscMode: 'manual' })
        setErr(notice("provisioning.couldNotReadTheSmsCentreFromTheSim"))
      } else if (e.status === 422 && /port/i.test(e.message)) {
        // Port conflict / invalid — surface the server's precise reason and stay on manual.
        setErr(notice('provisioning.portError', {detail: e.message.replace(/^port_error:\s*/, '')}))
      } else setErr(errorNotice(e))
    }
    setBusy(false)
  }

  const radio = (mode, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: simSmsc || mode === 'manual' ? 'pointer' : 'not-allowed', opacity: (!simSmsc && mode === 'auto') ? .5 : 1 }}>
      <input type="radio" name="smscMode" checked={f.smscMode === mode} disabled={!simSmsc && mode === 'auto'}
        onChange={() => upd({ smscMode: mode })} style={{ width: 'auto' }} />
      {label}
    </label>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}>
      <div className="card localized-form" style={{ padding: 24, width: 460, maxWidth: '92vw', maxHeight: '92vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{tx("provisioning.provisionSim")}</h2>
        <div className="mono" style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.6 }}><RichMessage id="provisioning.readerIccidImsi" values={{index: card.index, name: card.name, value1: card.iccid || '—', value2: card.imsi || '—'}} components={[<br />, <br />]} /></div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div><label htmlFor={localizationId + '-1'}>{tx("provisioning.name")}</label><input id={localizationId + '-1'} value={f.name} onChange={(e) => upd({ name: e.target.value })} placeholder={tx("provisioning.autoMccMnc")} /></div>
          {needPin && (
            <div><label htmlFor={localizationId + '-2'}>{tx("provisioning.simPinChv1", {value1: pinProp ? tx("provisioning.verifiedReConfirmIfNeeded") : tx("provisioning.required")})}</label>
              <input id={localizationId + '-2'} type="password" inputMode="numeric" className="mono" value={f.pin} maxLength={8}
                onChange={(e) => upd({ pin: e.target.value.replace(/[^0-9]/g, '') })} placeholder={tx("provisioning.48Digits")} /></div>
          )}
          <div><label htmlFor={localizationId + '-3'}>{tx("provisioning.imeiRequired")}</label><input id={localizationId + '-3'} className="mono" value={f.imei} onChange={(e) => upd({ imei: e.target.value })} placeholder="35123456-789012-3" /></div>
          <div><label htmlFor={localizationId + '-4'}>{tx("provisioning.imeisvOptional")}</label><input id={localizationId + '-4'} className="mono" value={f.imeisv} onChange={(e) => upd({ imeisv: e.target.value.replace(/[^0-9]/g, '') })} maxLength={16} placeholder={tx("provisioning.autoFromImeiRandomSvn")} />
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{tx("provisioning.16DigitsForTheCarrierSDeviceIdentityRequest")}</div>
          </div>

          <div>
            <label>{tx("provisioning.smsCentreSmsc")}</label>
            <div style={{ display: 'flex', gap: 16, margin: '6px 0' }}>
              {radio('auto', tx("provisioning.autoFromSim"))}
              {radio('manual', 'Manual')}
            </div>
            {f.smscMode === 'auto'
              ? <div className="mono" style={{ fontSize: 12, color: simSmsc ? 'var(--text-soft)' : '#eab308' }}>
                  {simSmsc ? tx("provisioning.readFromSim", {simSmsc: simSmsc}) : tx("provisioning.simDidNotProvideAnSmscChooseManual")}
                </div>
              : <input className="mono" value={f.smscManual} onChange={(e) => upd({ smscManual: e.target.value })} placeholder="+1..." />}
          </div>

          <div><label htmlFor={localizationId + '-5'}>{tx("provisioning.deviceUserAgentHowTheLineIdentifiesToThe")}</label><input id={localizationId + '-5'} className="mono" value={f.user_agent} onChange={(e) => upd({ user_agent: e.target.value })} placeholder={"iOS/26.6 iPhone"} /></div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label htmlFor={localizationId + '-6'}>APN</label>
              <input id={localizationId + '-6'} className="mono" value={f.apn} onChange={(e) => upd({ apn: e.target.value })} placeholder={tx("provisioning.ims")} />
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}><RichMessage id="provisioning.vowifiAccessPointDefaultIms" components={[<code>ims</code>]} /></div>
            </div>
            <div><label htmlFor={localizationId + '-7'}>{tx("provisioning.epdgIdentityIdr")}</label>
              <select id={localizationId + '-7'} value={f.idrMode} onChange={(e) => upd({ idrMode: e.target.value })}>
                <option value="apn">{tx("provisioning.bareApnDefault")}</option>
                <option value="fqdn">{tx("provisioning.apnFqdn")}</option>
              </select>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{tx("provisioning.howTheApnIsSentToTheEpdgMost")}</div>
            </div>
            <div><label htmlFor={localizationId + '-8'}>{tx("provisioning.imsAddressFamilyCp")}</label>
              <select id={localizationId + '-8'} value={f.cpMode} onChange={(e) => upd({ cpMode: e.target.value })}>
                <option value="auto">{tx("provisioning.autoDetectRecommended")}</option>
                <option value="dual">{tx("provisioning.dualStackIpv4Ipv6")}</option>
                <option value="v6">{tx("provisioning.ipv6Only")}</option>
                <option value="v4">{tx("provisioning.ipv4Only")}</option>
              </select>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}><RichMessage id="provisioning.addressFamilyOfTheImsPdnAutoDiscoversIt" components={[<b>Auto</b>]} /></div>
            </div>
          </div>

          <div>
            <label>{tx("provisioning.localSipPortMapping")}</label>
            <div style={{ display: 'flex', gap: 16, margin: '6px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" name="portMode" checked={f.portMode === 'auto'}
                  onChange={() => { upd({ portMode: 'auto' }); setErr('') }} style={{ width: 'auto' }} />{tx("provisioning.automatic")}</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="radio" name="portMode" checked={f.portMode === 'manual'}
                  onChange={() => { upd({ portMode: 'manual', sipPort: f.sipPort || String(autoPort?.auto_sip_udp || '') }); setErr('') }} style={{ width: 'auto' }} />{tx("provisioning.manual")}</label>
            </div>
            {f.portMode === 'auto'
              ? <div className="mono" style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                  {autoPort ? tx("provisioning.willUseHostPortUdpTcpTlsAutoAdvanced", {value1: autoPort.auto_sip_udp, value2: autoPort.auto_sip_tls})
                            : tx("provisioning.picksTheNextFreeHostPortAutomatically")}
                </div>
              : <>
                  <input type="number" className="mono" value={f.sipPort} min={portMin} max={portMax}
                    onChange={(e) => { upd({ sipPort: e.target.value.replace(/[^0-9]/g, '') }); setErr('') }}
                    placeholder={String(autoPort?.auto_sip_udp || '5060')} />
                  <div style={{ fontSize: 11.5, color: f.sipPort && !portOk ? '#ef4444' : 'var(--text-mute)', marginTop: 4 }}>
                    {f.sipPort && !portOk
                      ? tx("provisioning.enterAValidPort", {portMin: portMin, portMax: portMax})
                      : tx("provisioning.sipUdpPortOnTheHostTlsUsesThis", {portMin: portMin, portMax: portMax})}
                  </div>
                </>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label htmlFor={localizationId + '-9'}>{tx("provisioning.sipListen")}</label>
              <select id={localizationId + '-9'} value={f.listen_addr} onChange={(e) => upd({ listen_addr: e.target.value })}>
                <option value="0.0.0.0">{tx("provisioning.0000All")}</option><option value="127.0.0.1">127.0.0.1</option>
              </select></div>
            <div><label htmlFor={localizationId + '-10'}>{tx("provisioning.sipTransport")}</label>
              <select id={localizationId + '-10'} value={f.transport} onChange={(e) => upd({ transport: e.target.value })}>
                <option value="udp">UDP</option><option value="tcp">TCP</option><option value="tls">TLS</option>
              </select></div>
          </div>
          <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={f.webrtc} onChange={(e) => upd({ webrtc: e.target.checked })} />{tx("provisioning.enableBrowserSoftphoneWebrtc")}</label>
        </div>
        {err && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 12 }}>{renderNotice(err)}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>{tx("provisioning.cancel")}</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !f.imei || !pinOk || !manualOk || !portOk}>
            {busy ? tx("provisioning.provisioning") : tx("provisioning.provisionStart")}
          </button>
        </div>
      </div>
    </div>
  )
}
