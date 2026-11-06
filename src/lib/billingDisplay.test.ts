import { describe, expect, it } from 'vitest'
import { billingDate, SAMPLE_AT_START_MS, storageSampleLine, usageHints } from './billingDisplay'

/* A paid period that started on 1 October 2026, and its sample's figures. */
const START = '2026-10-01T09:00:00.000Z'
const paid = (bytes: number | null, at: string | null = START) => ({
  period_kind: 'paid' as const,
  period_start: START,
  sampled_storage_bytes: bytes,
  sampled_storage_at: bytes === null ? null : at,
})
/* The time `ms` after the period's start. */
const startPlus = (ms: number) => new Date(Date.parse(START) + ms).toISOString()

describe('storageSampleLine', () => {
  it("names a paid period's sample without naming which files it counts, or says it is not measured yet", () => {
    const line = storageSampleLine(paid(1_200_000_000, startPlus(1000)), 'active')
    expect(line).toBe('1.20 GB measured at the start of this period.')
    // the case that must fail, since the sample counts files in Deleted
    // items now
    expect(line).not.toContain('Deleted items')
    expect(storageSampleLine(paid(0), 'past_due')).toBe('0 B measured at the start of this period.')
    expect(storageSampleLine(paid(null), 'active')).toBe('Not measured yet for this period.')
  })

  it("names the date of a sample taken a day or more after the period's start, which counts what was stored meanwhile", () => {
    const late = startPlus(SAMPLE_AT_START_MS)
    expect(storageSampleLine(paid(1_200_000_000, late), 'active')).toBe(
      `1.20 GB measured on ${billingDate(late)}.`,
    )
    // the case that must fail, since such a sample was not measured at the
    // start
    expect(storageSampleLine(paid(1_200_000_000, late), 'active')).not.toContain('start')
    expect(storageSampleLine(paid(5, startPlus(SAMPLE_AT_START_MS - 1)), 'active')).toBe(
      '5 B measured at the start of this period.',
    )
    // a sample without a time, which an earlier backend finished or an
    // older backend answers without the field, measured the start
    expect(storageSampleLine(paid(5, null), 'active')).toBe(
      '5 B measured at the start of this period.',
    )
    const { sampled_storage_at: _, ...older } = paid(5)
    expect(storageSampleLine(older as Parameters<typeof storageSampleLine>[0], 'active')).toBe(
      '5 B measured at the start of this period.',
    )
  })

  it('shows no line outside a paid period or for a trial, which never gets a sample', () => {
    for (const period_kind of ['month', 'pending'] as const)
      expect(storageSampleLine({ ...paid(5), period_kind }, 'active')).toBeNull()
    expect(storageSampleLine(paid(null), 'trialing')).toBeNull()
    // before the summary answers, a paid period still gets its line
    expect(storageSampleLine(paid(7), undefined)).toBe('7 B measured at the start of this period.')
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
    // the sample line says when the sample measured, which may be later
    expect(hints.storage).not.toContain('start')
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
