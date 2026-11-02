import { useTranslation } from 'react-i18next'
import { tx, RichMessage } from '../i18n/index.js'
import React from 'react'

// Explains the outbound push payloads (webhook JSON + Telegram message) so a user can wire
// up a receiver without reading the source. Opened from the info button next to each channel.
const payloadJson = `{
  "event": "incoming_sms",        // or "incoming_call"
  "instance": "1",                // gateway line id
  "sim_name": "TELUS (Canada)",   // line name (may be empty)
  "iccid": "8900000000000000000", // SIM ICCID
  "msisdn": "+15875551234",       // this line's own number (may be "")
  "from": "+14155550001",         // the event's source number
  "text": "Hello there"           // SMS body; null for calls
}`

export default function PushInfoModal({ channel, onClose }) {
  useTranslation()
  const isTg = channel === 'telegram'
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}>
      <div className="card" style={{ padding: 24, width: 620, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{tx("pushInfo.formatNotes", {value1: isTg ? tx("pushInfo.telegramPush") : tx("pushInfo.webhookPush")})}</h2>

        {!isTg ? (
          <>
            <p style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.6 }}><RichMessage id="pushInfo.whenEnabledTheGatewaySendsAnHttpPostTo" components={[<b>POST</b>, <code>application/json</code>]} /></p>
            <pre style={{ background: 'var(--sidebar)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 14px', fontSize: 12.5, overflowX: 'auto', lineHeight: 1.5 }}>{payloadJson}</pre>
            <ul style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7, paddingLeft: 20 }}>
              <li><RichMessage id="pushInfo.eventIncomingSmsOrIncomingCall" components={[<code>event</code>, <code>incoming_sms</code>, <code>incoming_call</code>]} /></li>
              <li><RichMessage id="pushInfo.textTheSmsBodyForIncomingSmsNullFor" components={[<code>text</code>, <code>incoming_sms</code>, <code>null</code>]} /></li>
              <li><RichMessage id="pushInfo.msisdnThisLineSOwnNumberMayBeEmpty" components={[<code>msisdn</code>]} /></li>
              <li><RichMessage id="pushInfo.fromTheCallerSenderNumberEmptyIfTheCaller" components={[<code>from</code>]} /></li>
              <li>{tx("pushInfo.deliveryIsBestEffortWithAn8sTimeoutA")}</li>
              <li>{tx("pushInfo.selfSignedTlsOnTheTargetIsAcceptedCertificate")}</li>
            </ul>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.6 }}><RichMessage id="pushInfo.whenEnabledTheGatewaySendsAFormattedMessageTo" components={[<code>sendMessage</code>]} /></p>
            <pre style={{ background: 'var(--sidebar)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 14px', fontSize: 12.5, overflowX: 'auto', lineHeight: 1.5 }}>{`📩 Incoming SMS
SIM: TELUS (Canada) (+15875551234)
From: +14155550001

Hello there`}</pre>
            <p style={{ fontSize: 13, color: 'var(--text-soft)', fontWeight: 600, marginBottom: 4 }}>{tx("pushInfo.setup")}</p>
            <ul style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7, paddingLeft: 20 }}>
              <li><RichMessage id="pushInfo.createABotWithBotfatherAndCopyTheBot" components={[<a href="https://t.me/BotFather" target="_blank" rel="noreferrer" style={{
  textDecoration: 'underline'
}}>@BotFather</a>, <b>bot token</b>]} /></li>
              <li><RichMessage id="pushInfo.chatIdYourOwnNumericIdFromUserinfobotOr" components={[<b>Chat ID</b>, <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" style={{
  textDecoration: 'underline'
}}>@userinfobot</a>, <code>-1001234567890</code>]} /></li>
              <li>{tx("pushInfo.addTheBotToTheChannelGroupAsA")}</li>
              <li>{tx("pushInfo.sendTheBotAMessageFirstIfPushingTo")}</li>
            </ul>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-primary" onClick={onClose}>{tx("pushInfo.close")}</button>
        </div>
      </div>
    </div>
  )
}
