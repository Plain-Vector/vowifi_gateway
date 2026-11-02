import { tx } from '../i18n/index.js'
export const modes = { disabled: 'blocking.disabled', monitor: 'blocking.monitor', enforce: 'blocking.enforce' }
export const sources = { none: 'blocking.noMatch', whitelist: 'blocking.whitelistSource', blacklist: 'blocking.blacklistSource', saracroche: 'common.saracroche', arcep: 'common.arcep', withheld: 'blocking.hiddenSource', unavailable: 'blocking.unavailableSource', error: 'blocking.evaluationError' }
export function verdict(decision) {
  if (decision.action === 'reject') return { key: 'rejected', label: tx('blocking.blockedVerdict') }
  if (decision.would_block) return { key: 'monitor', label: tx('blocking.monitorVerdict') }
  return { key: 'allowed', label: tx('blocking.allowed') }
}
