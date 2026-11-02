import { useTranslation } from 'react-i18next'
import { tx, notice, renderNotice, errorNotice, formatNumber } from '../i18n/index.js'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

const DOWNLOAD_STEPS = [
  ['es10a_get_euicc_configured_addresses', 'esim.downloadSteps.readAddresses'],
  ['es10b_get_euicc_challenge_and_info', 'esim.downloadSteps.getChallenge'],
  ['es9p_initiate_authentication', 'esim.downloadSteps.initiateAuthentication'],
  ['es10b_authenticate_server', 'esim.downloadSteps.authenticateServer'],
  ['es9p_authenticate_client', 'esim.downloadSteps.authenticateClient'],
  ['es8p_metadata_parse', 'esim.downloadSteps.previewProfile'],
  ['es10b_prepare_download', 'esim.downloadSteps.prepareDownload'],
  ['es9p_get_bound_profile_package', 'esim.downloadSteps.fetchPackage'],
  ['es10b_load_bound_profile_package', 'esim.downloadSteps.installProfile'],
]

/** Map lpac progress/error names onto the pipeline. Ignore cancel_session etc. */
function resolveDownloadStep(step) {
  const s = String(step || '')
  if (!s || s === 'started' || s === 'completed' || s === 'cancelling') return null
  // lpac may emit "es10b_load_bound_profile_package:result"
  const base = s.split(':')[0]
  const idx = DOWNLOAD_STEPS.findIndex(([k]) => k === s || k === base)
  return idx >= 0 ? DOWNLOAD_STEPS[idx][0] : null
}

function isNonEuiccError(msg) {
  const s = String(msg || '')
  return /euicc_init|does not appear to be an eUICC|not an eUICC|ordinary USIM/i.test(s)
}

function copyText(text, showToast) {
  if (!text) return
  navigator.clipboard?.writeText(text).then(
    () => showToast?.(notice("esim.copied")),
    () => showToast?.(notice("esim.copyFailed")),
  )
}

function parseActivationCode(raw) {
  let s = (raw || '').trim()
  if (!s) return null
  if (/^LPA:/i.test(s)) s = s.slice(4)
  const parts = s.split('$')
  if (parts.length < 3 || parts[0] !== '1') return null
  return {
    smdp: parts[1] || '',
    matching_id: parts[2] || '',
    confirmation_required: parts[4] === '1',
  }
}

function StatePill({ state }) {
  useTranslation()
  const enabled = String(state || '').toLowerCase() === 'enabled'
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
      background: enabled ? '#dcfce7' : 'var(--hover)',
      color: enabled ? '#166534' : 'var(--text-dim)',
    }}>
      {enabled ? tx("esim.enabled") : tx("esim.disabled")}
    </span>
  )
}

/** Match sigmo: nickname takes priority, else profileName. */
function profileDisplayName(p) {
  const nick = (p.profileNickname || '').trim()
  if (nick) return nick
  return (p.profileName || p.serviceProviderName || 'Profile').trim() || 'Profile'
}

function RenameModal({ profile, busy, onClose, onSave }) {
  useTranslation()
  const [nick, setNick] = useState(() => profileDisplayName(profile))
  useEffect(() => {
    setNick(profileDisplayName(profile))
  }, [profile])
  if (!profile) return null
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0008', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}>
      <div className="card" style={{ width: 360, maxWidth: '92vw', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{tx("esim.rename")}</div>
        <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 14, wordBreak: 'break-all' }}>
          {profile.iccid}
        </div>
        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>{tx("esim.nickname")}</div>
          <input
            autoFocus
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder={tx("esim.nickname")}
            style={{ width: '100%' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(nick.trim())
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>{tx("esim.cancel")}</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => onSave(nick.trim())}>
            {busy ? tx("esim.saving") : tx("esim.update")}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProgressBar({ step, done, error }) {
  useTranslation()
  const resolved = resolveDownloadStep(step)
  const idx = resolved ? DOWNLOAD_STEPS.findIndex(([k]) => k === resolved) : -1
  // Unknown steps (cancel_session, started) must NOT fall back to index 0 — that looked like a jump to step 1.
  const cur = done ? DOWNLOAD_STEPS.length : (idx >= 0 ? idx : (step === 'started' ? 0 : -1))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {DOWNLOAD_STEPS.map(([k, label], i) => {
        const finished = done || (cur >= 0 && i < cur)
        const active = !done && !error && cur >= 0 && i === cur
        const failed = !!error && cur >= 0 && i === cur
        const color = failed ? '#ef4444' : finished ? '#22c55e' : active ? '#eab308' : "var(--border-strong)"
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{
              width: 18, height: 18, borderRadius: 999, background: color,
              color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, flexShrink: 0,
            }}>
              {finished ? '✓' : failed ? '!' : active ? '…' : i + 1}
            </span>
            <span style={{ color: finished || active || failed ? 'var(--text)' : 'var(--text-mute)', fontWeight: active || failed ? 700 : 500 }}>
              {tx(label)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—'
  const n = Number(bytes)
  if (n === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KiB', 'MiB', 'GiB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)))
  return `${formatNumber(n / k ** i, {maximumFractionDigits: 2})} ${sizes[i]}`
}

function seTarget(reader, se) {
  return {
    reader,
    se_id: se?.id || se?.seId,
    aid: se?.aid || undefined,
  }
}

function DownloadModal({ reader, ses, imeiDefault, onClose, onStarted, showToast }) {
  useTranslation()
  const dual = (ses || []).length > 1
  const [mode, setMode] = useState('code') // code | manual
  const [activation, setActivation] = useState('')
  const [smdp, setSmdp] = useState('')
  const [matchingId, setMatchingId] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [imei, setImei] = useState(imeiDefault || '')
  const [seId, setSeId] = useState(dual ? '' : (ses?.[0]?.id || 'default'))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const parsed = parseActivationCode(activation)
    if (parsed) {
      setSmdp(parsed.smdp)
      setMatchingId(parsed.matching_id)
    }
  }, [activation])

  const submit = async () => {
    setErr('')
    if (dual && !seId) return setErr(notice("esim.selectWhichEuiccSeToInstallOnto"))
    const body = {
      reader,
      se_id: seId || ses?.[0]?.id || 'default',
      imei: imei.trim() || undefined,
      confirmation_code: confirmation.trim() || undefined,
    }
    if (mode === 'code') {
      if (!activation.trim()) return setErr(notice("esim.pasteAnActivationCodeLpa1"))
      body.activation_code = activation.trim()
    } else {
      if (!smdp.trim()) return setErr(notice("esim.smDpAddressIsRequired"))
      body.smdp = smdp.trim()
      body.matching_id = matchingId.trim() || undefined
    }
    setBusy(true)
    try {
      await api.esimDownload(body)
      onStarted?.()
      onClose()
    } catch (e) {
      setErr(errorNotice(e))
    }
    setBusy(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0008', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={onClose}>
      <div className="card" style={{ width: 480, maxWidth: '92vw', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{tx("esim.downloadEsimProfile")}</h2>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        {dual && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 6 }}>{tx("esim.euicc")}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(ses || []).map((se, i) => {
                const selected = seId === se.id
                return (
                  <button
                    key={se.id}
                    type="button"
                    onClick={() => setSeId(se.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                      border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: 10, padding: '8px 10px',
                      background: selected ? 'color-mix(in srgb, var(--primary) 8%, var(--panel))' : 'transparent',
                      color: 'inherit', font: 'inherit',
                    }}
                  >
                    <span style={{ display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>
                      {se.eid || tx("esim.seNoEid", {value1: i + 1})}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text-mute)', marginTop: 2 }}>{tx("esim.storageRemaining", {value1: se.label || `SE${i + 1}`, value2: formatBytes(se.freeSpace)})}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {[['code', tx("esim.activationCode")], ['manual', tx("esim.manual")]].map(([k, label]) => (
            <button key={k} className="btn" onClick={() => setMode(k)}
              style={{ background: mode === k ? 'var(--primary)' : 'var(--hover)', color: mode === k ? '#fff' : 'var(--text-soft)' }}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'code' ? (
          <label style={{ display: 'block', marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>{tx("esim.lpaActivationCode")}</div>
            <textarea value={activation} onChange={(e) => setActivation(e.target.value)} rows={3}
              placeholder={tx("esim.lpa1SmdpExampleComMatchingId")}
              style={{ width: '100%', resize: 'vertical' }} />
          </label>
        ) : (
          <>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>SM-DP+</div>
              <input value={smdp} onChange={(e) => setSmdp(e.target.value)} placeholder={"smdp.example.com"} style={{ width: '100%' }} />
            </label>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>{tx("esim.matchingId")}</div>
              <input value={matchingId} onChange={(e) => setMatchingId(e.target.value)} style={{ width: '100%' }} />
            </label>
          </>
        )}
        <label style={{ display: 'block', marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>{tx("esim.confirmationCodeOptional")}</div>
          <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>
            IMEI {imeiDefault ? tx("esim.fromMatchedLineEditable") : tx("esim.optional")}
          </div>
          <input value={imei} onChange={(e) => setImei(e.target.value)} placeholder={tx("esim.15DigitImei")} style={{ width: '100%' }} />
        </label>
        {err && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 10 }}>{renderNotice(err)}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>{tx("esim.cancel")}</button>
          <button className="btn btn-primary" disabled={busy || (dual && !seId)} onClick={submit}>
            {busy ? tx("esim.starting") : tx("esim.download")}
          </button>
        </div>
      </div>
    </div>
  )
}

function instanceForCard(card, instances) {
  if (!card) return null
  if (card.matched != null) {
    const byId = instances.find((i) => String(i.id) === String(card.matched))
    if (byId) return byId
  }
  if (card.iccid) {
    return instances.find((i) => i.iccid && i.iccid === card.iccid) || null
  }
  return null
}

function isLineRunning(inst) {
  const st = inst?.status?.state
  return !!(st && st !== 'STOPPED')
}

export default function Esim({ cards, instances, refresh, subscribe, showToast }) {
  useTranslation()
  const present = useMemo(
    () => [...cards].filter((c) => c.present).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    [cards],
  )
  const [reader, setReader] = useState('')
  const [status, setStatus] = useState(null)
  const [ses, setSes] = useState([])
  const [meta, setMeta] = useState({ imei: '' })
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [showDl, setShowDl] = useState(false)
  const [dl, setDl] = useState(null) // {step, event, metadata, error, done}
  const [renameTarget, setRenameTarget] = useState(null) // { se, profile }
  const [busyOp, setBusyOp] = useState('')

  useEffect(() => {
    if (!reader && present[0]) setReader(present[0].name)
    if (reader && !present.find((c) => c.name === reader) && present[0]) setReader(present[0].name)
  }, [present, reader])

  const selectedCard = present.find((c) => c.name === reader)
  const matchedInst = useMemo(
    () => instanceForCard(selectedCard, instances),
    [selectedCard, instances],
  )
  const lineRunning = isLineRunning(matchedInst)
  const imeiDefault = meta.imei || matchedInst?.imei || ''
  const dual = ses.length > 1
  const profiles = useMemo(
    () => ses.flatMap((se) => se.profiles || []),
    [ses],
  )
  const notifications = useMemo(
    () => ses.flatMap((se) => se.notifications || []),
    [ses],
  )
  const hasEuicc = ses.some((se) => se.eid || se.chip || (se.profiles || []).length)

  // Lightweight: lpac presence only — never touch the card on page enter / reader switch.
  useEffect(() => {
    let cancelled = false
    api.esimStatus().then((st) => {
      if (!cancelled) setStatus(st)
    }).catch(() => {
      if (!cancelled) setStatus({ available: false })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setSes([])
    setMeta({ imei: '' })
    setLoaded(false)
    setErr('')
    setDl(null)
    setRenameTarget(null)
  }, [reader])

  const loadAll = useCallback(async () => {
    if (!reader) return
    setLoading(true)
    setErr('')
    setSes([])
    setMeta({ imei: '' })
    try {
      const st = await api.esimStatus()
      setStatus(st)
      if (!st.available) {
        setErr(notice("esim.lpacIsNotInstalledRunSudoInstallShBuild"))
        setLoaded(false)
        return
      }
      // One call loads every SE (chip + profiles + notifications).
      const c = await api.esimChip(reader)
      const list = c.ses || []
      setSes(list)
      setMeta({ imei: c.imei || '' })
      const seErr = list.map((s) => s.error).filter(Boolean)
      if (!list.length) {
        setErr('')
      } else if (list.every((s) => s.error) && seErr.every((m) => isNonEuiccError(m))) {
        setErr('')
      } else if (list.every((s) => s.error)) {
        setErr(seErr[0] || notice("esim.euiccLoadFailed"))
      } else {
        setErr('')
      }
      setLoaded(true)
    } catch (e) {
      // Non-eUICC cards surface as a calm empty state, not a red error banner.
      setErr(isNonEuiccError(e.message) ? '' : e.message)
      setSes([])
      setMeta({ imei: '' })
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }, [reader])

  const requestLoad = useCallback(async () => {
    if (!reader || loading || busyOp) return
    if (lineRunning && matchedInst) {
      const label = matchedInst.name
        ? tx("esim.line", {value1: matchedInst.id, value2: matchedInst.name})
        : tx("esim.line2", {value1: matchedInst.id})
      const ok = confirm(
        tx('esim.confirmStopForLoad', {line: label}),
      )
      if (!ok) return
      setBusyOp('stop')
      try {
        await api.stop(matchedInst.id)
        showToast?.(notice("esim.lineStopped", {value1: matchedInst.id}))
        await refresh?.()
      } catch (e) {
        showToast?.(e.message)
        setBusyOp('')
        return
      }
      setBusyOp('')
    }
    await loadAll()
  }, [reader, loading, busyOp, lineRunning, matchedInst, loadAll, refresh, showToast])

  useEffect(() => {
    if (!subscribe) return undefined
    return subscribe((msg) => {
      if (msg.type !== 'esim_download') return
      if (reader && msg.reader && msg.reader !== reader) return
      if (msg.event === 'started') {
        setDl({ step: 'started', event: 'started', done: false })
      } else if (msg.event === 'progress' || msg.event === 'preview') {
        // lpac emits cancel_session progress on failure — ignore non-pipeline steps so the bar
        // does not jump back to step 1 before the error event arrives.
        const known = resolveDownloadStep(msg.step)
        setDl((d) => ({
          ...(d || {}),
          step: known || d?.step || 'started',
          event: msg.event,
          metadata: msg.metadata || msg.data || d?.metadata,
          done: false,
        }))
      } else if (msg.event === 'completed') {
        setDl((d) => ({ ...(d || {}), step: 'completed', event: 'completed', done: true, result: msg.result }))
        showToast?.(notice("esim.profileDownloaded"))
        loadAll()
        refresh?.()
      } else if (msg.event === 'error') {
        // Prefer lpac failing function name when it maps to a pipeline step; else keep last progress.
        const known = resolveDownloadStep(msg.step)
        setDl((d) => ({
          ...(d || {}),
          step: known || resolveDownloadStep(d?.step) || d?.step || 'started',
          event: 'error',
          error: msg.error,
          done: false,
        }))
        showToast?.(msg.error || tx("esim.downloadFailed"))
      } else if (msg.event === 'cancelling') {
        setDl((d) => ({ ...(d || {}), event: 'cancelling' }))
      }
    })
  }, [subscribe, reader, loadAll, refresh, showToast])

  const stopLine = async () => {
    if (!matchedInst) return
    setBusyOp('stop')
    try {
      await api.stop(matchedInst.id)
      showToast?.(notice("esim.lineStopped", {value1: matchedInst.id}))
      await refresh?.()
    } catch (e) {
      showToast?.(e.message)
    }
    setBusyOp('')
  }

  const runProfileOp = async (label, fn) => {
    setBusyOp(label)
    try {
      await fn()
      showToast?.(notice('common.operationSucceeded', {operation: notice('operation.' + label.replaceAll(' ', '_'))}))
      await loadAll()
      await refresh?.()
    } catch (e) {
      showToast?.(e.message)
      setErr(errorNotice(e))
    }
    setBusyOp('')
  }

  if (!present.length) {
    return (
      <div className="card" style={{ padding: 24, color: 'var(--text-dim)' }}>{tx("esim.noSimPresentInsertAnEuiccIntoAPc")}</div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>{tx("esim.reader")}<select value={reader} onChange={(e) => setReader(e.target.value)} style={{ minWidth: 220 }}>
            {present.map((c) => (
              <option key={c.name} value={c.name}>
                #{c.index} · {c.name}{c.iccid ? ` · ${c.iccid}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-ghost" onClick={requestLoad} disabled={loading || !!busyOp}>
          {loading ? tx("esim.loading") : tx("esim.load")}
        </button>
        <button className="btn btn-primary" onClick={() => setShowDl(true)}
          disabled={!status?.available || !loaded || lineRunning || !!busyOp || !!dl && !dl.done && !dl.error}>{tx("esim.downloadProfile")}</button>
      </div>

      {lineRunning && (
        <div className="card" style={{ padding: 14, borderColor: '#f59e0b', background: 'color-mix(in srgb, #f59e0b 12%, var(--panel))' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{tx("esim.vowifiRunningOnThisReader")}</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{tx("esim.clickLoadToStopTheLineAndReadEsim", {value1: matchedInst ? tx('esim.lineDetails', {id: matchedInst.id, name: matchedInst.name ? ` · ${matchedInst.name}` : ''}) : ''})}</div>
            </div>
            <button className="btn btn-primary" onClick={stopLine} disabled={busyOp === 'stop' || !matchedInst}>
              {busyOp === 'stop' ? tx("esim.stopping") : tx("esim.stopLine")}
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="card" style={{ padding: 14, color: '#b91c1c', borderColor: '#fecaca' }}>
          {renderNotice(err)}
        </div>
      )}

      {dl && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 700 }}>
              {dl.done ? tx("esim.downloadComplete") : dl.error ? tx("esim.downloadFailed") : dl.event === 'cancelling' ? tx("esim.cancelling") : tx("esim.downloading")}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!dl.done && !dl.error && (
                <button className="btn btn-ghost" onClick={() => api.esimDownloadCancel({ reader }).catch((e) => showToast?.(e.message))}>{tx("esim.cancel")}</button>
              )}
              {(dl.done || dl.error) && (
                <button className="btn btn-ghost" onClick={() => setDl(null)}>{tx("esim.dismiss")}</button>
              )}
            </div>
          </div>
          <ProgressBar step={dl.step} done={dl.done} error={dl.error} />
          {dl.metadata && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-soft)' }}>{tx("esim.preview", {value1: dl.metadata.profileName || dl.metadata.serviceProviderName || tx("esim.profile"), value2: dl.metadata.iccid ? ` · ${dl.metadata.iccid}` : ''})}</div>
          )}
          {dl.error && <div style={{ marginTop: 10, color: '#ef4444', fontSize: 13 }}>{renderNotice(dl.error)}</div>}
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>{tx("esim.chip")}</div>
        {!hasEuicc ? (
          <div style={{ color: 'var(--text-mute)', fontSize: 13, lineHeight: 1.5 }}>
            {status && !status.available
              ? tx("esim.lpacIsNotInstalledRunSudoInstallShBuild")
              : loading
                ? tx("esim.reading")
                : !loaded
                  ? tx("esim.clickLoadToReadChipInfoFromThisCard")
                  : tx("esim.thisCardIsNotAnEuiccEsimOrdinaryUsim")}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            {dual ? (
              <>
                {ses.map((se, i) => (
                  <div key={se.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--text-mute)', fontSize: 11, flexShrink: 0, paddingTop: 2 }}>EID{i + 1}</div>
                    <div style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', textAlign: 'right' }}>
                      {se.eid || '—'}
                      {se.eid && (
                        <button className="btn btn-ghost" style={{ marginLeft: 6, padding: '2px 8px', fontSize: 11 }}
                          onClick={() => copyText(se.eid, showToast)}>{tx("esim.copy")}</button>
                      )}
                    </div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>{tx("esim.storageRemaining3")}</div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontWeight: 600 }}>
                    {ses.map((se, i) => (
                      <span key={se.id}>{tx("esim.se2", {value1: i + 1, value2: formatBytes(se.freeSpace)})}</span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div>
                  <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>EID</div>
                  <div style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {ses[0]?.eid || '—'}
                    {ses[0]?.eid && (
                      <button className="btn btn-ghost" style={{ marginLeft: 6, padding: '2px 8px', fontSize: 11 }}
                        onClick={() => copyText(ses[0].eid, showToast)}>{tx("esim.copy")}</button>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>{tx("esim.defaultSmDp")}</div>
                  <div>{ses[0]?.defaultDpAddress || ses[0]?.chip?.defaultDpAddress || '—'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>{tx("esim.freeNvm")}</div>
                  <div>{formatBytes(ses[0]?.freeSpace ?? ses[0]?.chip?.freeNonVolatileMemory)}</div>
                </div>
              </div>
            )}
            <div>
              <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>{tx("esim.imeiForDownload")}</div>
              <div>{imeiDefault || tx("esim.lpacDefaultTac")}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>{tx("esim.profiles")}</div>
          <div style={{ fontSize: 12, color: 'var(--text-mute)' }}>{tx('esim.profileCount', {count: profiles.length})}</div>
        </div>
        {!profiles.length ? (
          <div style={{ color: 'var(--text-mute)', fontSize: 13 }}>
            {loading
              ? tx("esim.reading")
              : !loaded
                ? tx("esim.clickLoadToListProfiles")
                : hasEuicc
                  ? tx("esim.noProfilesOnThisEuicc")
                  : tx("esim.noProfilesToShow")}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(dual ? ses : [{ ...ses[0], profiles }]).map((se) => {
              const seProfiles = se.profiles || []
              if (dual && !seProfiles.length && !se.eid) return null
              return (
                <div key={se.id || 'default'}>
                  {dual && (
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      marginBottom: 10, fontSize: 13, fontWeight: 700,
                    }}>
                      <span>{se.label || se.id}: <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 500, fontSize: 12 }}>{se.eid || '—'}</span></span>
                      <span style={{ fontSize: 12, color: 'var(--text-mute)', fontWeight: 500 }}>{seProfiles.length}</span>
                    </div>
                  )}
                  {!seProfiles.length ? (
                    <div style={{ color: 'var(--text-mute)', fontSize: 13, marginBottom: dual ? 8 : 0 }}>{tx("esim.noProfilesOnThisSe")}</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {seProfiles.map((p) => {
                        const enabled = String(p.profileState || '').toLowerCase() === 'enabled'
                        const target = seTarget(reader, se)
                        const title = profileDisplayName(p)
                        return (
                          <div key={`${se.id}:${p.iccid}`} style={{
                            border: `1px solid ${enabled ? 'color-mix(in srgb, var(--primary) 35%, var(--border))' : 'var(--border)'}`,
                            borderRadius: 12, padding: '12px 14px',
                            background: enabled ? 'color-mix(in srgb, var(--primary) 6%, var(--panel))' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                          }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                <span style={{
                                  fontWeight: 700, fontSize: 14, overflow: 'hidden',
                                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {title}
                                </span>
                                <StatePill state={p.profileState} />
                              </div>
                              <div style={{
                                marginTop: 4, fontSize: 12, color: 'var(--text-mute)',
                                fontFamily: 'ui-monospace, monospace', overflow: 'hidden',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {p.iccid}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              {!enabled && (
                                <button className="btn btn-primary" disabled={!!busyOp || lineRunning}
                                  onClick={() => runProfileOp('Enable', () => api.esimEnable(p.iccid, target))}>{tx("esim.enable")}</button>
                              )}
                              {enabled && (
                                <button className="btn btn-ghost" disabled={!!busyOp || lineRunning}
                                  onClick={() => runProfileOp('Disable', () => api.esimDisable(p.iccid, target))}>{tx("esim.disable")}</button>
                              )}
                              <button className="btn btn-ghost" disabled={!!busyOp || lineRunning}
                                onClick={() => setRenameTarget({ se, profile: p })}>{tx("esim.rename")}</button>
                              <button className="btn btn-ghost" disabled={!!busyOp || lineRunning}
                                onClick={() => {
                                  if (!confirm(tx("esim.deleteProfileValue0", {
  value0: p.iccid
}))) return
                                  runProfileOp('Delete', () => api.esimDelete(p.iccid, target))
                                }}>{tx("esim.delete")}</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>{tx("esim.notifications")}</div>
          <button className="btn btn-ghost" disabled={!!busyOp || lineRunning || !notifications.length}
            onClick={() => runProfileOp('Process notifications', async () => {
              for (const se of ses) {
                if (!(se.notifications || []).length) continue
                await api.esimNotificationsProcess(seTarget(reader, se))
              }
            })}>{tx("esim.processAll")}</button>
        </div>
        {!notifications.length ? (
          <div style={{ color: 'var(--text-mute)', fontSize: 13 }}>
            {loading
              ? tx("esim.reading")
              : !loaded
                ? tx("esim.clickLoadToListNotifications")
                : hasEuicc
                  ? tx("esim.noPendingNotifications")
                  : tx("esim.noNotificationsToShow")}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(dual ? ses : [{ ...ses[0], notifications }]).map((se) => {
              const notes = se.notifications || []
              if (dual && !notes.length) return null
              return (
                <div key={`n-${se.id || 'default'}`}>
                  {dual && (
                    <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}>
                      {se.label || se.id}: <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 500, fontSize: 12 }}>{se.eid || '—'}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {notes.map((n) => {
                      const target = { ...seTarget(reader, se), seq: n.seqNumber ?? n.seq }
                      return (
                        <div key={`${se.id}:${n.seqNumber ?? n.seq}`} style={{
                          display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center',
                          border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', fontSize: 13,
                        }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>#{n.seqNumber ?? n.seq} · {n.profileManagementOperation || n.operation || tx("esim.notify")}</div>
                            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                              {n.iccid || '—'} · {n.notificationAddress || n.address || ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-ghost" disabled={!!busyOp || lineRunning}
                              onClick={() => runProfileOp('Process', () => api.esimNotificationsProcess(target))}>{tx("esim.send")}</button>
                            <button className="btn btn-ghost" disabled={!!busyOp || lineRunning}
                              onClick={() => runProfileOp('Remove', () => api.esimNotificationRemove(n.seqNumber ?? n.seq, seTarget(reader, se)))}>{tx("esim.remove")}</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showDl && (
        <DownloadModal
          reader={reader}
          ses={ses}
          imeiDefault={imeiDefault}
          showToast={showToast}
          onClose={() => setShowDl(false)}
          onStarted={() => setDl({ step: 'started', event: 'started', done: false })}
        />
      )}

      {renameTarget && (
        <RenameModal
          profile={renameTarget.profile}
          busy={busyOp === 'Nickname'}
          onClose={() => setRenameTarget(null)}
          onSave={(nick) => {
            const { se, profile } = renameTarget
            const target = seTarget(reader, se)
            runProfileOp('Nickname', () => api.esimNickname(profile.iccid, nick, target)
              .then(() => setRenameTarget(null)))
          }}
        />
      )}
    </div>
  )
}
