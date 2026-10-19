import { describe, expect, it } from 'vitest'
import { usageHints } from './billingDisplay'

const usage = { api_overage_cents: 200, storage_overage_cents: 0, waived: false }

describe('usageHints', () => {
  it('reports the charges a paid period recorded', () => {
    const hints = usageHints({ ...usage, period_kind: 'paid' }, 'usd')
    expect(hints.api).toBe(
      'Extra API charges recorded this period: $2.00. Added to the invoice at the end of this period.',
    )
    expect(hints.storage).toContain('Extra storage charge recorded this period: $0.00')
  })

  it('says why a calendar month, an unconfirmed renewal and free access are not charged', () => {
    expect(usageHints({ ...usage, period_kind: 'month', waived: true }, 'usd').api).toBe(
      'API calls are not charged without a paid period.',
    )
    const pending = usageHints({ ...usage, period_kind: 'pending', waived: true }, 'usd')
    expect(pending.api).toBe('API calls are not charged while the renewal awaits confirmation.')
    expect(pending.storage).toBe(
      'Storage for the new period is measured once the renewal is confirmed.',
    )
    expect(usageHints({ ...usage, period_kind: 'paid', waived: true }, 'usd').api).toBe(
      'API usage is covered by free access. It will not be charged later.',
    )
    // a paid period without a plan currency shows no amounts
    expect(usageHints({ ...usage, period_kind: 'paid' }, undefined).api).toContain('free access')
  })
})
