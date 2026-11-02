import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../api.js'
afterEach(() => vi.unstubAllGlobals())
it('displays field-specific FastAPI validation errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, statusText: 'Unprocessable Entity', text: async () => JSON.stringify({ detail: [{ loc: ['body', 'interval_hours'], msg: 'Input should be greater than or equal to 1' }] }) }))
  await expect(api.blocking('PUT', '/providers/saracroche', { interval_hours: 0 })).rejects.toThrow('interval_hours: Input should be greater than or equal to 1')
})
it('notifies the application about expired administrator sessions', async () => {
  const listener = vi.fn(); window.addEventListener('vowifi-unauthorized', listener)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ detail: 'Administrator login required' }) }))
  await expect(api.blocking('GET', '/settings')).rejects.toThrow('Administrator login required')
  expect(listener).toHaveBeenCalledOnce(); window.removeEventListener('vowifi-unauthorized', listener)
})
