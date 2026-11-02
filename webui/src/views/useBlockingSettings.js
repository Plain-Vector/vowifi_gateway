import { useEffect, useRef, useState } from 'react'

export const providerValues = (p) => ({ auto_update: !!p.auto_update, interval_hours: p.interval_hours,
  source: p.connection.source, country_codes: p.connection.country_codes,
  selected_list_ids: p.connection.selected_list_ids ?? null })
const canonical = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

// Settings reads are separate from operational polling. Every read/write belongs to one
// generation; late responses after a scope change or unmount are ignored.
export function useBlockingSettings(request, scope) {
  const epoch = useRef(0)
  const [state, setState] = useState({ draft: null, saved: null, server: null, status: 'Loading', error: '' })
  async function load() {
    const id = ++epoch.current
    setState(s => ({ ...s, status: 'Loading', error: '' }))
    try {
      const server = await request('GET', '/settings?' + new URLSearchParams({ scope }))
      if (id !== epoch.current) return
      const saved = scope === '*' ? server.global : server.override
      setState({ draft: { ...saved }, saved, server, status: 'Saved', error: '' })
    } catch (e) { if (id === epoch.current) setState(s => ({ ...s, status: 'Error', error: e.message })) }
  }
  useEffect(() => { setState({ draft: null, saved: null, server: null, status: 'Loading', error: '' }); load(); return () => { ++epoch.current } }, [scope])
  const dirty = state.draft !== null && !same(state.draft, state.saved)
  function edit(key, value) {
    setState(s => {
      const draft = { ...s.draft }
      if (value === undefined) delete draft[key]; else draft[key] = value
      return { ...s, draft, status: 'Unsaved changes', error: '' }
    })
  }
  async function save() {
    const id = ++epoch.current
    const payload = { ...state.draft }
    setState(s => ({ ...s, status: 'Saving', error: '' }))
    try {
      await request('PUT', '/settings?' + new URLSearchParams({ scope }), payload)
      const server = await request('GET', '/settings?' + new URLSearchParams({ scope }))
      if (id !== epoch.current) return
      const saved = scope === '*' ? server.global : server.override
      if (!same(saved, payload)) throw new Error('Server values differ from the submitted settings. Reload and review before saving again.')
      setState({ draft: { ...saved }, saved, server, status: 'Saved', error: '' })
    } catch (e) { if (id === epoch.current) setState(s => ({ ...s, status: 'Error', error: e.message })) }
  }
  return { ...state, dirty, edit, save, discard: load }
}
