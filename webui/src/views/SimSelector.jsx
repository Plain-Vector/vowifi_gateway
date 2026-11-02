import { useTranslation } from 'react-i18next'
import { tx, statusLabel } from '../i18n/index.js'
import React, { useEffect, useId } from 'react'

// Per-page SIM/line picker for multi-SIM setups. Labels each line with the physical reader
// it currently occupies (from the detected-cards state) so it's clear which reader's engine
// (docker container) will handle calls/SMS/logs. Switches the global `selected` instance.
//
// Only lines whose physical reader is currently PRESENT are listed — a provisioned line
// whose reader/card is unplugged is dropped from the dropdown (its config stays under SIM
// Config and it reappears when the reader returns).
export default function SimSelector({ instances = [], cards = [], selected, setSelected, labelKey = 'lineSelector.active' }) {
  useTranslation()
  const selectId = useId()
  // A present card that maps to this line (by matched id or ICCID) means its reader is here.
  const readerFor = (i) => cards.find((c) => c.present &&
    (String(c.matched) === String(i.id) || (c.iccid && c.iccid === i.iccid)))
  const live = instances.filter((i) => readerFor(i))

  // If the currently-selected line's reader just went away, move selection to the first
  // still-present line (or clear it) so no view stays pinned to a vanished reader.
  const id = selected?.id != null ? String(selected.id) : ''
  useEffect(() => {
    if (id && !live.some((i) => String(i.id) === id)) {
      setSelected(live[0] ? String(live[0].id) : null)
    }
  }, [id, live.map((i) => i.id).join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!live.length) return null
  const label = tx(labelKey)
  const shortLabel = tx({ 'lineSelector.active': 'lineSelector.activeShort', 'lineSelector.logs': 'lineSelector.logsShort', 'lineSelector.config': 'lineSelector.configShort' }[labelKey] || 'lineSelector.activeShort')
  return (
    <div className="card sim-selector">
      <label htmlFor={selectId} className="sim-selector-label">
        <span className="sim-label-full">{label}</span>
        <span className="sim-label-short">{shortLabel}</span>
      </label>
      <select id={selectId} className="sim-selector-select" value={id || ''}
        onChange={(e) => setSelected(e.target.value)}>
        {!id && <option value="">{tx("lineSelector.select")}</option>}
        {live.map((i) => {
          const c = readerFor(i)
          const rd = c ? tx("lineSelector.reader", {value1: c.index}) : null
          const st = i.status?.label ? ` — ${statusLabel('lineStatus', i.status.state, i.status.label)}` : ''
          return <option key={String(i.id)} value={String(i.id)}>{rd ? `${rd} · ` : ''}{i.name || i.imsi}{st}</option>
        })}
      </select>
      {live.length === 1 && <span className="sim-selector-hint">{tx("lineSelector.onlyLine")}</span>}
    </div>
  )
}
