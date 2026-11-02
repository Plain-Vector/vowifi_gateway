export const modes = { disabled: 'Disabled', monitor: 'Monitor', enforce: 'Enforce' }
export const sources = { none: 'No matching rule', whitelist: 'Personal whitelist', blacklist: 'Personal blacklist', saracroche: 'Saracroche', arcep: 'ARCEP', withheld: 'Hidden caller ID', unavailable: 'Unavailable caller ID', error: 'Evaluation error' }
export function verdict(decision) {
  if (decision.action === 'reject') return { key: 'rejected', label: 'Blocked by current settings' }
  if (decision.would_block) return { key: 'monitor', label: 'Would be blocked in Enforce' }
  return { key: 'allowed', label: 'Allowed' }
}
