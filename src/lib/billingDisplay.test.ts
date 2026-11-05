import { describe, expect, it } from 'vitest'
import { storageSampleLine, usageHints } from './billingDisplay'

describe('storageSampleLine', () => {
  it("names a paid period's sample without files in Deleted items, or says it is not measured yet", () => {
    expect(
      storageSampleLine({ period_kind: 'paid', sampled_storage_bytes: 1_200_000_000 }, 'active'),
    ).toBe('1.20 GB measured at the start of this period, without files in Deleted items.')
    expect(storageSampleLine({ period_kind: 'paid', sampled_storage_bytes: 0 }, 'past_due')).toBe(
      '0 B measured at the start of this period, without files in Deleted items.',
    )
    expect(storageSampleLine({ period_kind: 'paid', sampled_storage_bytes: null }, 'active')).toBe(
      'Not measured yet for this period.',
    )
  })

  it('shows no line outside a paid period or for a trial, which never gets a sample', () => {
    for (const period_kind of ['month', 'pending'] as const)
      expect(storageSampleLine({ period_kind, sampled_storage_bytes: 5 }, 'active')).toBeNull()
    expect(
      storageSampleLine({ period_kind: 'paid', sampled_storage_bytes: null }, 'trialing'),
    ).toBeNull()
    // the summary has not answered yet: a paid period still gets its line
    expect(storageSampleLine({ period_kind: 'paid', sampled_storage_bytes: 7 }, undefined)).toBe(
      '7 B measured at the start of this period, without files in Deleted items.',
    )
  })
})

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
