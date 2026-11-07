import { describe, expect, it } from 'vitest'
import type { BillingUsageFigures } from '../../convex/lib/billingTypes'
import {
  billingDate,
  SAMPLE_AT_START_MS,
  storageAverageLine,
  storageSampleLine,
  usageHints,
} from './billingDisplay'

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

/* A paid period charged on its daily average, with `average`'s figures. */
const daily = (average: Partial<NonNullable<BillingUsageFigures['storage_average']>> = {}) => ({
  ...paid(null),
  storage_basis: 'daily' as const,
  storage_average: {
    bytes: 6_400_000_000,
    days: 30,
    measured: 30,
    estimated: 0,
    estimated_earlier: 0,
    final: true,
    ...average,
  },
})

describe('storageAverageLine', () => {
  it("names a recorded period's average over its days, with its estimated days and the day each copied", () => {
    expect(storageAverageLine(daily(), 'active')).toBe(
      '6.40 GB average over this period’s 30 days.',
    )
    expect(storageAverageLine(daily({ measured: 27, estimated: 3 }), 'active')).toBe(
      '6.40 GB average over this period’s 30 days. 3 of them estimated from the next measured day.',
    )
    expect(
      storageAverageLine(daily({ measured: 28, estimated: 2, estimated_earlier: 2 }), 'active'),
    ).toBe(
      '6.40 GB average over this period’s 30 days. 2 of them estimated from the most recent measured day.',
    )
    expect(
      storageAverageLine(daily({ measured: 25, estimated: 5, estimated_earlier: 2 }), 'past_due'),
    ).toBe(
      '6.40 GB average over this period’s 30 days. 5 of them estimated, 3 from the next measured day and 2 from the most recent one.',
    )
    // a reading of 0 bytes is an average like any other
    expect(storageAverageLine(daily({ bytes: 0 }), 'active')).toBe(
      '0 B average over this period’s 30 days.',
    )
  })

  it('says a period recorded without any measurement has none, and never names 0 bytes for it', () => {
    const line = storageAverageLine(daily({ bytes: null, measured: 0 }), 'active')
    expect(line).toBe('No storage measurement was available for this period.')
    expect(line).not.toContain('0 B')
  })

  it("names an open period's average so far with the days it covers and their estimates, or says it is not measured yet", () => {
    expect(
      storageAverageLine(daily({ final: false, measured: 17, estimated: 2, days: 31 }), 'active'),
    ).toBe(
      '6.40 GB average so far, from 19 of this period’s 31 days. 2 of them estimated from the next measured day.',
    )
    expect(storageAverageLine(daily({ final: false, measured: 1, days: 31 }), 'active')).toBe(
      '6.40 GB average so far, from 1 of this period’s 31 days.',
    )
    expect(storageAverageLine(daily({ final: false, bytes: null, measured: 0 }), 'active')).toBe(
      'Not measured yet for this period.',
    )
  })

  it('shows no average for a period sampled at its start, an older backend, a month, a pending interval or a trial', () => {
    // the case that fails if the daily text shows for a start-basis period
    expect(storageAverageLine({ ...daily(), storage_basis: 'start' }, 'active')).toBeNull()
    expect(storageAverageLine(paid(5), 'active')).toBeNull()
    for (const period_kind of ['month', 'pending'] as const)
      expect(storageAverageLine({ ...daily(), period_kind }, 'active')).toBeNull()
    expect(storageAverageLine(daily(), 'trialing')).toBeNull()
  })

  it('leaves the sample line to periods sampled at their start, an answer without a basis included', () => {
    expect(storageSampleLine(daily(), 'active')).toBeNull()
    expect(storageSampleLine({ ...paid(5), storage_basis: 'start' }, 'active')).toBe(
      '5 B measured at the start of this period.',
    )
    expect(storageSampleLine(paid(5), 'active')).toBe('5 B measured at the start of this period.')
  })
})

describe('usageHints for a period charged on its daily average', () => {
  const charged = { ...usage, period_kind: 'paid' as const, storage_overage_cents: 300 }

  it('says how an open period is charged, and names the charge once it is recorded', () => {
    const open = usageHints({ ...charged, ...daily({ final: false }) }, 'usd')
    expect(open.storage).toBe(
      'Storage is charged on the average of this period’s daily measurements, which is recorded shortly before the period ends. Added to the invoice at the end of this period.',
    )
    expect(open.api).toBe(usageHints(charged, 'usd').api)
    expect(usageHints({ ...charged, ...daily() }, 'usd').storage).toBe(
      'Extra storage charge recorded this period: $3.00, based on this period’s average storage. Added to the invoice at the end of this period.',
    )
    expect(usageHints({ ...charged, ...daily({ bytes: null }) }, 'usd').storage).toBe(
      'No storage charge for this period, since no storage measurement was available.',
    )
  })

  it('keeps every other hint as it was', () => {
    // a period sampled at its start, and an answer without a basis
    for (const basis of [{ storage_basis: 'start' as const }, {}])
      expect(usageHints({ ...charged, ...basis }, 'usd').storage).toBe(
        'Extra storage charge recorded this period: $3.00, based on the storage measured for this period. Added to the invoice at the end of this period.',
      )
    expect(usageHints({ ...charged, ...daily(), waived: true }, 'usd').storage).toBe(
      'Storage is covered by free access. It will not be charged later.',
    )
    expect(usageHints({ ...charged, ...daily(), period_kind: 'pending' }, 'usd').storage).toBe(
      'Storage for the new period is measured once the renewal is confirmed.',
    )
  })
})
