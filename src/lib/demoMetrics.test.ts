import { describe, expect, it } from 'vitest'
import type { DemoMetricsReport } from '../../convex/lib/demoMetricsReport'
import {
  countDemoPeriod,
  DEFAULT_DEMO_COST_SETTINGS,
  demoCreationSeries,
  demoMonthlyStorage,
  demoStorageSeries,
  demoSummary,
  estimateDemoMonthlyCost,
  fmtDemoBytes,
  parseDemoPrice,
  readDemoCostSettings,
} from './demoMetrics'

const time = (date: string) => Date.parse(date)
const GB = 1024 ** 3
function report(changes: Partial<DemoMetricsReport> = {}): DemoMetricsReport {
  const audience = { browsers: [], operatingSystems: [], countries: [] }
  return {
    version: 1,
    generatedAt: time('2026-09-15T12:00:00Z'),
    trackingStartedAt: time('2024-01-01T00:00:00Z'),
    historyCompleteSince: time('2024-01-01T00:00:00Z'),
    totalCreated: 99,
    active: 2,
    deleting: 1,
    counts: [],
    storage: null,
    storageDaily: [],
    audience: { last7Days: audience, last30Days: audience, last12Months: audience },
    ...changes,
  }
}

describe('demo creation periods', () => {
  it('includes exactly seven UTC calendar dates, across a year boundary', () => {
    const data = report({
      generatedAt: time('2026-01-03T00:30:00Z'),
      counts: [
        { date: '2025-12-20', created: 200 },
        { date: '2025-12-21', created: 7 },
        { date: '2025-12-27', created: 100 },
        { date: '2025-12-28', created: 2 },
        { date: '2026-01-03', created: 3 },
        { date: '2026-01-04', created: 100 },
      ],
    })
    expect(demoSummary(data).last7Days).toEqual({
      start: '2025-12-28',
      end: '2026-01-03',
      value: 5,
      complete: true,
    })
    const points = demoCreationSeries(data, '7d')
    expect(points).toHaveLength(7)
    expect(points[0].current.value).toBe(2)
    expect(points[1].current.value).toBe(0)
    expect(points[6].current.value).toBe(3)
    expect(points[0].previous).toMatchObject({ start: '2025-12-21', value: 7 })
    expect(points[6].previous).toMatchObject({ end: '2025-12-27', value: 100 })
    expect(points.map((point) => point.previous.value)).toEqual([7, 0, 0, 0, 0, 0, 100])
  })

  it('compares consecutive non-overlapping 30-day periods across leap day', () => {
    const data = report({
      generatedAt: time('2024-03-03T10:00:00Z'),
      counts: [
        { date: '2024-01-03', created: 100 },
        { date: '2024-01-04', created: 2 },
        { date: '2024-02-02', created: 3 },
        { date: '2024-02-03', created: 4 },
        { date: '2024-02-29', created: 5 },
        { date: '2024-03-03', created: 6 },
      ],
    })
    const points = demoCreationSeries(data, '30d')
    expect(points).toHaveLength(30)
    expect(points[0].current.start).toBe('2024-02-03')
    expect(points.at(-1).current.end).toBe('2024-03-03')
    expect(points[0].previous.start).toBe('2024-01-04')
    expect(points.at(-1).previous.end).toBe('2024-02-02')
    expect(points.reduce((sum, point) => sum + point.current.value, 0)).toBe(15)
    expect(points.reduce((sum, point) => sum + point.previous.value, 0)).toBe(5)
  })

  it('keeps unknown pretracking days unavailable and labels a partially tracked first day', () => {
    const data = report({
      trackingStartedAt: time('2026-09-14T14:00:00Z'),
      historyCompleteSince: time('2026-09-14T14:00:00Z'),
      counts: [{ date: '2026-09-14', created: 4 }],
    })
    const points = demoCreationSeries(data, '7d')
    expect(points[0].current).toMatchObject({ value: null, complete: false })
    expect(points[5].current).toMatchObject({ value: 4, complete: false })
    expect(points[6].current).toMatchObject({ value: 0, complete: true })
    const summary = demoSummary(data)
    expect(summary.last7Days).toMatchObject({ value: 4, complete: false })
    expect(summary.lastYear).toMatchObject({ value: null, complete: false })
    expect(points.every((point) => point.previous.value === null)).toBe(true)
  })

  it('preserves partial previous-period counts instead of hiding them or claiming complete coverage', () => {
    const data = report({
      trackingStartedAt: time('2026-09-05T14:00:00Z'),
      historyCompleteSince: time('2026-09-05T14:00:00Z'),
      counts: [{ date: '2026-09-05', created: 4 }],
    })
    const points = demoCreationSeries(data, '7d')
    expect(points[0].previous).toMatchObject({ value: null, complete: false })
    expect(points[3].previous).toMatchObject({ start: '2026-09-05', value: 4, complete: false })
    expect(points[4].previous).toMatchObject({ value: 0, complete: true })
  })

  it('includes recovered records without claiming the earlier history is complete', () => {
    const data = report({
      trackingStartedAt: time('2026-09-15T10:00:00Z'),
      historyCompleteSince: time('2026-09-15T10:00:00Z'),
      counts: [{ date: '2026-09-14', created: 5 }],
    })
    expect(countDemoPeriod(data, '2026-09-14', '2026-09-14')).toMatchObject({
      value: 5,
      complete: false,
    })
    expect(
      countDemoPeriod(
        report({ trackingStartedAt: null, historyCompleteSince: null }),
        '2026-09-14',
        '2026-09-15',
      ),
    ).toMatchObject({ value: null, complete: false })
  })

  it('compares the preceding full calendar months and labels the current partial month by its dates', () => {
    const data = report({
      counts: [
        { date: '2024-09-30', created: 500 },
        { date: '2024-10-01', created: 5 },
        { date: '2025-09-15', created: 5 },
        { date: '2025-09-16', created: 100 },
        { date: '2026-01-01', created: 15 },
      ],
    })
    const points = demoCreationSeries(data, '12m')
    expect(points[0].previous).toMatchObject({ start: '2024-10-01', end: '2024-10-31', value: 5 })
    expect(points.at(-1).current).toMatchObject({ start: '2026-09-01', end: '2026-09-15' })
    expect(points.at(-1).previous).toMatchObject({
      start: '2025-09-01',
      end: '2025-09-30',
      value: 105,
    })
    expect(points.reduce((sum, point) => sum + point.current.value, 0)).toBe(15)
    expect(points.reduce((sum, point) => sum + point.previous.value, 0)).toBe(110)
    expect(demoSummary(data).lastYear.value).toBe(105)
  })

  it('retains full comparison months through leap-year February', () => {
    const leap = report({
      generatedAt: time('2024-02-29T12:00:00Z'),
      trackingStartedAt: time('2022-01-01T00:00:00Z'),
      historyCompleteSince: time('2022-01-01T00:00:00Z'),
    })
    expect(demoCreationSeries(leap, '12m').at(-1).previous.end).toBe('2023-02-28')
    const followingYear = report({
      generatedAt: time('2025-03-12T12:00:00Z'),
      counts: [{ date: '2024-02-29', created: 7 }],
    })
    const months = demoCreationSeries(followingYear, '12m')
    const february = months.find((row) => row.current.start === '2025-02-01')
    expect(february.previous).toMatchObject({
      start: '2024-02-01',
      end: '2024-02-29',
      value: 7,
      complete: true,
    })
    expect(months.at(-1).previous.end).toBe('2024-03-31')
  })

  it('uses twelve calendar months through today and refuses complete coverage beyond retention', () => {
    const data = report()
    expect(demoSummary(data).last12Months).toMatchObject({ start: '2025-10-01', end: '2026-09-15' })
    const months = demoCreationSeries(data, '12m')
    expect(months).toHaveLength(12)
    expect(months[0].current.start).toBe('2025-10-01')
    expect(months.at(-1).current.end).toBe('2026-09-15')
    expect(countDemoPeriod(data, '2024-01-01', '2024-02-01')).toMatchObject({
      value: null,
      complete: false,
    })
  })
})

describe('demo storage and monthly estimate', () => {
  const sampled = () =>
    report({
      storageDaily: [
        { date: '2026-08-31', samples: 20, databaseBytesSum: 900e9, fileBytesSum: 900e9 },
        { date: '2026-09-01', samples: 1, databaseBytesSum: GB, fileBytesSum: 2 * GB },
        { date: '2026-09-02', samples: 3, databaseBytesSum: 9 * GB, fileBytesSum: 6 * GB },
        { date: '2026-09-16', samples: 20, databaseBytesSum: 900e9, fileBytesSum: 900e9 },
      ],
    })

  it('weights by samples rather than daily means, omits other months and states measured coverage', () => {
    expect(demoMonthlyStorage(sampled())).toEqual({
      start: '2026-09-01',
      end: '2026-09-15',
      samples: 4,
      sampledDays: 2,
      elapsedDays: 15,
      databaseBytes: 2.5 * GB,
      fileBytes: 2 * GB,
    })
  })

  it('preserves gaps separately from a measured zero storage day', () => {
    const data = report({
      storageDaily: [
        { date: '2026-09-13', samples: 2, databaseBytesSum: 0, fileBytesSum: 0 },
        { date: '2026-09-15', samples: 3, databaseBytesSum: 900, fileBytesSum: 1200 },
      ],
    })
    expect(demoStorageSeries(data, 3)).toEqual([
      { date: '2026-09-13', samples: 2, databaseBytes: 0, fileBytes: 0 },
      { date: '2026-09-14', samples: 0, databaseBytes: null, fileBytes: null },
      { date: '2026-09-15', samples: 3, databaseBytes: 300, fileBytes: 400 },
    ])
  })

  it('uses Convex dashboard storage units and projects a full month without multiplying by sample count', () => {
    const settings = { currency: 'NOK', databasePrice: '0.5', filePrice: '0.1', otherMonthly: '12' }
    expect(estimateDemoMonthlyCost(sampled(), settings).cost).toEqual({
      database: 1.25,
      files: 0.2,
      other: 12,
      total: 13.45,
    })
    expect(estimateDemoMonthlyCost(sampled(), { ...settings, otherMonthly: '' }).cost.total).toBe(
      1.45,
    )
    expect(fmtDemoBytes(GB)).toBe('1.00 GB')
    expect(fmtDemoBytes(1024 ** 2)).toBe('1.0 MB')
    expect(fmtDemoBytes(1024)).toBe('1.0 KB')
  })

  it('estimates at the published Professional EU defaults and respects explicit free rates', () => {
    expect(estimateDemoMonthlyCost(sampled(), DEFAULT_DEMO_COST_SETTINGS).cost).toEqual({
      database: 0.65,
      files: 0.078,
      other: 0,
      total: 0.728,
    })
    expect(
      estimateDemoMonthlyCost(sampled(), { ...DEFAULT_DEMO_COST_SETTINGS, filePrice: '' }).cost,
    ).toBeNull()
    const free = { currency: 'USD', databasePrice: '0', filePrice: '0', otherMonthly: '' }
    expect(estimateDemoMonthlyCost(sampled(), free).cost.total).toBe(0)
    expect(estimateDemoMonthlyCost(report(), free).cost).toBeNull()
    expect(estimateDemoMonthlyCost(sampled(), { ...free, otherMonthly: '-2' }).cost).toBeNull()
    expect(estimateDemoMonthlyCost(sampled(), { ...free, currency: 'invalid' }).cost).toBeNull()
    expect(
      estimateDemoMonthlyCost(sampled(), { ...free, databasePrice: '9'.repeat(308) }).cost,
    ).toBeNull()
  })

  it('rejects malformed, negative and nonfinite saved prices while preserving explicit zero', () => {
    for (const value of ['', ' ', '-1', 'Infinity', 'NaN', '0x10', '1e4', '2,4'])
      expect(parseDemoPrice(value)).toBeNull()
    expect(parseDemoPrice(' 0.25 ')).toBe(0.25)
    expect(readDemoCostSettings('not JSON')).toEqual(DEFAULT_DEMO_COST_SETTINGS)
    expect(
      readDemoCostSettings(
        JSON.stringify({
          currency: '<script>',
          databasePrice: -1,
          filePrice: 'Infinity',
          otherMonthly: '0',
        }),
      ),
    ).toEqual({ ...DEFAULT_DEMO_COST_SETTINGS, otherMonthly: '0' })
    expect(
      readDemoCostSettings(
        JSON.stringify({ currency: 'NOK', databasePrice: '0', filePrice: '.5', otherMonthly: '8' }),
      ),
    ).toEqual({ currency: 'NOK', databasePrice: '0', filePrice: '.5', otherMonthly: '8' })
  })

  it('prefills new and previously blank USD preferences while preserving custom prices and zero', () => {
    expect(readDemoCostSettings(null)).toEqual(DEFAULT_DEMO_COST_SETTINGS)
    expect(
      readDemoCostSettings(JSON.stringify({ currency: 'USD', databasePrice: '', filePrice: '' })),
    ).toEqual(DEFAULT_DEMO_COST_SETTINGS)
    expect(
      readDemoCostSettings(
        JSON.stringify({
          currency: 'USD',
          databasePrice: '0',
          filePrice: '.8',
          otherMonthly: '14',
        }),
      ),
    ).toEqual({ currency: 'USD', databasePrice: '0', filePrice: '.8', otherMonthly: '14' })
  })

  it('never fills missing custom-currency prices with unconverted USD rates', () => {
    expect(
      readDemoCostSettings(
        JSON.stringify({ currency: 'NOK', databasePrice: '', filePrice: '', otherMonthly: '50' }),
      ),
    ).toEqual({ currency: 'NOK', databasePrice: '', filePrice: '', otherMonthly: '50' })
    expect(
      readDemoCostSettings(
        JSON.stringify({ currency: 'EUR', databasePrice: '0', filePrice: 'invalid' }),
      ),
    ).toEqual({ currency: 'EUR', databasePrice: '0', filePrice: '', otherMonthly: '' })
  })
})
