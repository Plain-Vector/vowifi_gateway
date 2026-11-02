import { useTranslation } from 'react-i18next'
import { tx, RichMessage, notice, renderNotice, errorNotice } from '../i18n/index.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import PushInfoModal from './PushInfoModal.jsx'

export default function Settings() {
  const localizationId = React.useId()
  useTranslation()
  const [s, setS] = useState(null)
  const [msg, setMsg] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [info, setInfo] = useState('')   // '' | 'webhook' | 'telegram' — which help modal is open

  useEffect(() => { api.settings().then(setS).catch(() => {}) }, [])
  if (!s) return <div style={{ color: 'var(--text-dim)' }}>{tx("settings.loading")}</div>

  const upd = (patch) => setS((x) => ({ ...x, ...patch }))
  const updTls = (patch) => setS((x) => ({ ...x, tls: { ...x.tls, ...patch } }))
  const updDebug = (patch) => setS((x) => ({ ...x, debug: { ...x.debug, ...patch } }))
  // webhook / telegram helpers: patch the channel object and its nested `events` map.
  const wh = s.webhook || { enabled: false, url: '', events: {} }
  const nt = s.ntfy || { enabled: false, server: 'https://ntfy.sh', topic: '', token: '', priority: 3, include_sms_body: true, cache: false, events: {} }
  const updNt = (patch) => upd({ ntfy: { ...nt, ...patch } })
  const tg = s.telegram || { enabled: false, bot_token: '', chat_id: '', events: {} }
  const updWh = (patch) => setS((x) => ({ ...x, webhook: { ...wh, ...patch } }))
  const updWhEv = (k, v) => setS((x) => ({ ...x, webhook: { ...wh, events: { ...(wh.events || {}), [k]: v } } }))
  const updTg = (patch) => setS((x) => ({ ...x, telegram: { ...tg, ...patch } }))
  const updTgEv = (k, v) => setS((x) => ({ ...x, telegram: { ...tg, events: { ...(tg.events || {}), [k]: v } } }))

  const save = async () => {
    try {
      const next = await api.saveSettings(s)
      setS(next)
      setMsg(notice("settings.savedRestartTheControlSurfaceForTlsPortChanges"))
    }
    catch (e) { setMsg(notice("settings.errorValue0",{value0:e.message})) }
  }

  return (
    <div className="settings-page localized-form" style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.controlSurfaceWebui")}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label htmlFor={localizationId + '-1'}>{tx("settings.bindAddress")}</label><input id={localizationId + '-1'} value={s.bind || ''} onChange={(e) => upd({ bind: e.target.value })} /></div>
          <div><label htmlFor={localizationId + '-2'}>{tx("settings.httpsPort")}</label><input id={localizationId + '-2'} type="number" value={s.http_port || 8443} onChange={(e) => upd({ http_port: +e.target.value })} /></div>
        </div>
        <h4>TLS</h4>
        <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!s.tls.self_signed} onChange={(e) => updTls({ self_signed: e.target.checked })} />{tx("settings.useSelfSignedCertificate")}</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10, opacity: s.tls.self_signed ? .5 : 1 }}>
          <div><label htmlFor={localizationId + '-3'}>{tx("settings.domain")}</label><input id={localizationId + '-3'} value={s.tls.domain || ''} onChange={(e) => updTls({ domain: e.target.value })} placeholder={"gw.example.com"} /></div>
          <div />
          <div><label htmlFor={localizationId + '-4'}>{tx("settings.certPath")}</label><input id={localizationId + '-4'} className="mono" value={s.tls.cert_path || ''} onChange={(e) => updTls({ cert_path: e.target.value })} placeholder="/path/fullchain.pem" /></div>
          <div><label htmlFor={localizationId + '-5'}>{tx("settings.keyPath")}</label><input id={localizationId + '-5'} className="mono" value={s.tls.key_path || ''} onChange={(e) => updTls({ key_path: e.target.value })} placeholder="/path/privkey.pem" /></div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.sipWebrtcAdvertiseAddress")}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>{tx("settings.thisAddressIsWrittenIntoLocalSipContactAnd")}</div>
        {s.advertise_address_managed_by_env ? (
          <div style={{
            padding: '10px 12px', borderRadius: 8, marginBottom: 10,
            background: 'var(--bg-elev, rgba(0,0,0,.08))', fontSize: 13,
          }}>
            <div>{tx("settings.managedBy")}<code>{"VOWIFI_ADVERTISE_ADDR"}</code>{tx("settings.effective")}{' '}
              <span className="mono">{s.advertise_address_effective || '—'}</span>{tx("settings.thisPageCannotOverrideTheEnvironmentValue")}</div>
            <div style={{ marginTop: 8, color: 'var(--text-dim)' }}>{tx("settings.toUpdateTheInstallerManagedValueFromTheRepository")}</div>
            <pre className="mono" style={{
              margin: '8px 0 0', padding: '8px 10px', borderRadius: 6,
              overflowX: 'auto', background: 'rgba(0,0,0,.12)', fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}>{`sudo VOWIFI_ADVERTISE_ADDR=${s.advertise_address_detected || s.advertise_address_effective || "192.168.x.x"} ./install.sh reload`}</pre>
          </div>
        ) : (
          <div>
            <label htmlFor="advertise_address">{tx("settings.advertiseAddressIpOrHostname")}</label>
            <input
              id="advertise_address"
              className="mono"
              value={s.advertise_address || ''}
              onChange={(e) => upd({ advertise_address: e.target.value })}
              placeholder={s.advertise_address_detected
                ? tx("settings.auto", {value1: s.advertise_address_detected})
                : tx("settings.autoDetectLanIp")}
            />
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-mute)' }}>{tx("settings.theInstallerCanPinTheSameValueWith")}<pre className="mono" style={{
                margin: '6px 0 0', padding: '8px 10px', borderRadius: 6,
                overflowX: 'auto', background: 'rgba(0,0,0,.12)', fontSize: 12,
                whiteSpace: 'pre-wrap',
              }}>{`sudo VOWIFI_ADVERTISE_ADDR=${s.advertise_address_detected || "192.168.x.x"} ./install.sh reload`}</pre>
            </div>
          </div>
        )}
        <div className="mono" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-mute)' }}>{s.advertise_address_detected ? tx('settings.effectiveDetected', {address:s.advertise_address_effective || '—', detected:s.advertise_address_detected}) : tx('settings.effectiveOnly', {address:s.advertise_address_effective || '—'})}</div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-mute)' }}>{tx("settings.afterSavingOrReloadingTheInstallerStopStartEach")}</div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.engineDebugDefaults")}</h3>
        <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!s.debug?.asterisk} onChange={(e) => updDebug({ asterisk: e.target.checked })} />{tx("settings.asteriskVerboseDebugLogging")}</label>
        <label style={{ marginTop: 8 }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!s.debug?.charon} onChange={(e) => updDebug({ charon: e.target.checked })} />{tx("settings.swuTunnelIkeHighLogging")}</label>
        <label style={{ marginTop: 8 }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!s.debug?.pcap} onChange={(e) => updDebug({ pcap: e.target.checked })} />{tx("settings.captureEspSipPcap")}</label>
        <div style={{ marginTop: 14 }}><label htmlFor={localizationId + '-6'}>{tx("settings.managerUrlForEngineEventCallbacksAutoIfBlank")}</label>
          <input id={localizationId + '-6'} className="mono" value={s.manager_url || ''} onChange={(e) => upd({ manager_url: e.target.value })} placeholder={tx("settings.autoEGHttpsGatewayHost8443")} /></div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.autoRetry")}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>{tx("settings.ifTheVowifiTunnelOrImsRegistrationDropsWhile")}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label htmlFor={localizationId + '-7'}>{tx("settings.maxRetries")}</label><input id={localizationId + '-7'} type="number" min="1" value={s.retry?.max ?? 3}
            onChange={(e) => upd({ retry: { ...(s.retry || {}), max: +e.target.value } })} /></div>
          <div><label htmlFor={localizationId + '-8'}>{tx("settings.secondsPerAttempt")}</label><input id={localizationId + '-8'} type="number" min="5" value={s.retry?.interval ?? 40}
            onChange={(e) => upd({ retry: { ...(s.retry || {}), interval: +e.target.value } })} /></div>
        </div>
        <label style={{ marginTop: 12, display: 'block' }}>
          <input type="checkbox" style={{ width: 'auto', marginRight: 8 }}
            checked={s.retry?.auto_recover !== false}
            onChange={(e) => upd({ retry: { ...(s.retry || {}), auto_recover: e.target.checked } })} />{tx("settings.autoReProvisionWhenNetworkRecovers")}</label>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.calls")}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>{tx("settings.howLongAnOutgoingCallRingsBeforeTheGateway")}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label htmlFor={localizationId + '-9'}>{tx("settings.ringTimeoutSeconds")}</label><input id={localizationId + '-9'} type="number" min="5" max="180" value={s.ring_timeout ?? 35}
            onChange={(e) => upd({ ring_timeout: +e.target.value })} /></div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>{tx("settings.tunnel")}</h3>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}><RichMessage id="settings.howOftenTheGatewayProactivelyRekeysTheIpsecEsp" components={[<b>0 disables</b>]} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label htmlFor={localizationId + '-10'}>{tx("settings.saRekeyIntervalMinutes0Off")}</label>
            <input id={localizationId + '-10'} type="number" min="0" max="1440" value={s.rekey?.minutes ?? 30}
              onChange={(e) => upd({ rekey: { ...(s.rekey || {}), minutes: +e.target.value } })} /></div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ marginTop: 0, marginBottom: 0 }}>{tx("settings.webhookPush")}</h3>
          <button className="btn btn-ghost" style={{ padding: '2px 9px', fontSize: 12, borderRadius: 20 }}
            title={tx("settings.payloadFormatNotes")} onClick={() => setInfo('webhook')}>{tx("settings.format")}</button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', margin: '8px 0 12px' }}><RichMessage id="settings.postAJsonBodyToYourUrlWhenAn" components={[<b>ⓘ Format</b>]} /></div>
        <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!wh.enabled}
          onChange={(e) => updWh({ enabled: e.target.checked })} />{tx("settings.enableWebhookPush")}</label>
        <div style={{ marginTop: 12, opacity: wh.enabled ? 1 : .5 }}>
          <label htmlFor={localizationId + '-11'}>{tx("settings.webhookUrl")}</label>
          <input id={localizationId + '-11'} className="mono" value={wh.url || ''} disabled={!wh.enabled}
            onChange={(e) => updWh({ url: e.target.value })} placeholder="https://example.com/hook" />
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-mute)' }}>{tx("settings.eventsToPush")}</div>
          <div style={{ display: 'flex', gap: 18, marginTop: 6 }}>
            <label><input type="checkbox" style={{ width: 'auto', marginRight: 7 }} disabled={!wh.enabled}
              checked={wh.events?.incoming_call !== false} onChange={(e) => updWhEv('incoming_call', e.target.checked)} />{tx("settings.incomingCall")}</label>
            <label><input type="checkbox" style={{ width: 'auto', marginRight: 7 }} disabled={!wh.enabled}
              checked={wh.events?.incoming_sms !== false} onChange={(e) => updWhEv('incoming_sms', e.target.checked)} />{tx("settings.incomingSms")}</label>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ marginTop: 0, marginBottom: 0 }}>{tx("settings.telegramPush")}</h3>
          <button className="btn btn-ghost" style={{ padding: '2px 9px', fontSize: 12, borderRadius: 20 }}
            title={tx("settings.messageFormatSetup")} onClick={() => setInfo('telegram')}>{tx("settings.format")}</button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', margin: '8px 0 12px' }}><RichMessage id="settings.sendIncomingSmsCallsToATelegramChatOr" components={[<b>ⓘ Format</b>]} /></div>
        <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={!!tg.enabled}
          onChange={(e) => updTg({ enabled: e.target.checked })} />{tx("settings.enableTelegramPush")}</label>
        <div style={{ marginTop: 12, opacity: tg.enabled ? 1 : .5 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div><label htmlFor={localizationId + '-12'}>{tx("settings.botToken")}</label>
              <input id={localizationId + '-12'} type="password" className="mono" value={tg.bot_token || ''} disabled={!tg.enabled}
                onChange={(e) => updTg({ bot_token: e.target.value })} placeholder={tx("settings.123456AbcDef")} /></div>
            <div><label htmlFor={localizationId + '-13'}>{tx("settings.chatChannelId")}</label>
              <input id={localizationId + '-13'} className="mono" value={tg.chat_id || ''} disabled={!tg.enabled}
                onChange={(e) => updTg({ chat_id: e.target.value })} placeholder={tx("settings.1001234567890Or12345678")} /></div>
          </div>
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-mute)' }}>{tx("settings.eventsToPush")}</div>
          <div style={{ display: 'flex', gap: 18, marginTop: 6 }}>
            <label><input type="checkbox" style={{ width: 'auto', marginRight: 7 }} disabled={!tg.enabled}
              checked={tg.events?.incoming_call !== false} onChange={(e) => updTgEv('incoming_call', e.target.checked)} />{tx("settings.incomingCall")}</label>
            <label><input type="checkbox" style={{ width: 'auto', marginRight: 7 }} disabled={!tg.enabled}
              checked={tg.events?.incoming_sms !== false} onChange={(e) => updTgEv('incoming_sms', e.target.checked)} />{tx("settings.incomingSms")}</label>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3>{tx("settings.ntfyNotifications")}</h3>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={!!nt.enabled} onChange={(e) => updNt({ enabled: e.target.checked })} />{tx("settings.enableNtfy")}</label>
        <label>{tx("settings.ntfyServerUrl")}<input value={nt.server} onChange={(e) => updNt({ server: e.target.value })} placeholder="https://ntfy.sh" /></label>
        <label>{tx("settings.topic")}<input value={nt.topic} onChange={(e) => updNt({ topic: e.target.value })} /></label>
        <label>{tx("settings.accessToken")}<input type="password" autoComplete="new-password" value={nt.token || ''} placeholder={nt.has_token ? tx("settings.tokenSavedLeaveBlankToKeep") : tx("settings.optionalBearerToken")} onChange={(e) => updNt({ token: e.target.value, clear_token: false })} /></label>
        {nt.has_token && <button className="btn btn-ghost" onClick={() => updNt({ token: '', clear_token: true, has_token: false })}>{tx("settings.removeSavedToken")}</button>}
        <label>{tx("settings.priority")}<select value={nt.priority} onChange={(e) => updNt({ priority: Number(e.target.value) })}>{[1,2,3,4,5].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
        {['incoming_call', 'incoming_sms'].map((event) => <label key={event}><input type="checkbox" style={{ width: 'auto' }} checked={nt.events?.[event] !== false} onChange={(e) => updNt({ events: { ...nt.events, [event]: e.target.checked } })} />{event === 'incoming_call' ? tx("settings.incomingCalls") : tx("settings.incomingSms")}</label>)}
        <label><input type="checkbox" style={{ width: 'auto' }} checked={!!nt.include_sms_body} onChange={(e) => updNt({ include_sms_body: e.target.checked })} />{tx("settings.includeSmsTextInNotifications")}</label>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={!!nt.cache} onChange={(e) => updNt({ cache: e.target.checked })} />{tx("settings.allowNtfyServerMessageCaching")}</label>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>{tx("settings.useAPrivateTopicWithAccessControlForSms")}</p>
        <button className="btn btn-ghost" disabled={!nt.enabled} onClick={async () => { try { const r = await api.testNtfy(); setMsg(r.ok ? notice("settings.ntfyTestDelivered") : r.error) } catch (e) { setMsg(errorNotice(e)) } }}>{tx("settings.sendNtfyTest")}</button>
      </div>
      <div className="card" style={{ padding: 20 }}>
        <h3>{tx("settings.administratorPassword")}</h3>
        <label>{tx("settings.currentPassword")}<input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
        <label>{tx("settings.newPasswordAtLeast12Characters")}<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label>
        <button className="btn btn-ghost" disabled={newPassword.length < 12 || !currentPassword} onClick={async () => {
          try { await api.auth('POST', '/password', { current_password: currentPassword, new_password: newPassword }); setCurrentPassword(''); setNewPassword(''); setMsg(notice("settings.passwordChangedOtherSessionsSignedOut")) } catch (e) { setMsg(errorNotice(e)) }
        }}>{tx("settings.changePassword")}</button>
      </div>
      <div>
        <button className="btn btn-primary" onClick={save}>{tx("settings.saveSettings")}</button>
        {msg && <span style={{ marginLeft: 12, color: '#22c55e', fontSize: 13 }}>{renderNotice(msg)}</span>}
      </div>
      {info && <PushInfoModal channel={info} onClose={() => setInfo('')} />}
    </div>
  )
}
