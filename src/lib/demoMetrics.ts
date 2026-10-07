import type { DemoMetricsReport } from '../../convex/lib/demoMetricsReport'

const DAY = 86_400_000
// Match the storage units displayed by Convex's dashboard for this approximation.
const KB = 1024
const MB = KB ** 2
const GB = KB ** 3
export const DEMO_STORAGE_STALE_MS = 2 * 60 * 60 * 1000

export const utcDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10)
const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`)
export const addDays = (date: string, days: number) => utcDate(dayTime(date) + days * DAY)
const monthStart = (date: string, offset = 0) => {
  const day = new Date(dayTime(date))
  return utcDate(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + offset, 1))
}

export type DemoCountPeriod = {
  start: string
  end: string
  value: number | null
  complete: boolean
}

/** Sparse days mean zero only inside the period of complete retained history. */
export function countDemoPeriod(
  report: DemoMetricsReport,
  start: string,
  end: string,
): DemoCountPeriod {
  const today = utcDate(report.generatedAt)
  const retentionStart = addDays(today, -799)
  const complete =
    report.historyCompleteSince !== null &&
    report.historyCompleteSince <= dayTime(start) &&
    start >= retentionStart &&
    end <= today
  const rows = report.counts.filter((row) => row.date >= start && row.date <= end)
  const hasTrackedDays =
    report.trackingStartedAt !== null &&
    utcDate(report.trackingStartedAt) <= end &&
    start <= today &&
    end >= retentionStart
  return {
    start,
    end,
    value:
      complete || rows.length || hasTrackedDays
        ? rows.reduce((sum, row) => sum + row.created, 0)
        : null,
    complete,
  }
}

export function demoSummary(report: DemoMetricsReport) {
  const today = utcDate(report.generatedAt)
  const year = Number(today.slice(0, 4))
  return {
    last7Days: countDemoPeriod(report, addDays(today, -6), today),
    last12Months: countDemoPeriod(report, monthStart(today, -11), today),
    lastYear: countDemoPeriod(report, `${year - 1}-01-01`, `${year - 1}-12-31`),
  }
}

export type DemoChartPeriod = '7d' | '30d' | '12m'
export function demoCreationSeries(report: DemoMetricsReport, period: DemoChartPeriod) {
  const today = utcDate(report.generatedAt)
  if (period === '12m') {
    return Array.from({ length: 12 }, (_, index) => {
      const start = monthStart(today, index - 11)
      const end = index === 11 ? today : addDays(monthStart(start, 1), -1)
      const previousStart = monthStart(start, -12)
      const previousEnd = addDays(monthStart(previousStart, 1), -1)
      return {
        current: countDemoPeriod(report, start, end),
        previous: countDemoPeriod(report, previousStart, previousEnd),
      }
    })
  }
  const length = period === '7d' ? 7 : 30
  return Array.from({ length }, (_, index) => {
    const date = addDays(today, index - length + 1)
    const previousDate = addDays(date, -length)
    return {
      current: countDemoPeriod(report, date, date),
      previous: countDemoPeriod(report, previousDate, previousDate),
    }
  })
}

export function demoStorageSeries(report: DemoMetricsReport, days = 30) {
  const today = utcDate(report.generatedAt)
  const rows = new Map(report.storageDaily.map((row) => [row.date, row]))
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(today, index - days + 1)
    const row = rows.get(date)
    return {
      date,
      samples: row?.samples ?? 0,
      databaseBytes: row ? row.databaseBytesSum / row.samples : null,
      fileBytes: row ? row.fileBytesSum / row.samples : null,
    }
  })
}

export function demoMonthlyStorage(report: DemoMetricsReport) {
  const today = utcDate(report.generatedAt)
  const start = monthStart(today)
  const rows = report.storageDaily.filter((row) => row.date >= start && row.date <= today)
  const samples = rows.reduce((sum, row) => sum + row.samples, 0)
  return {
    start,
    end: today,
    samples,
    sampledDays: rows.length,
    elapsedDays: Number(today.slice(8)),
    databaseBytes: samples
      ? rows.reduce((sum, row) => sum + row.databaseBytesSum, 0) / samples
      : null,
    fileBytes: samples ? rows.reduce((sum, row) => sum + row.fileBytesSum, 0) / samples : null,
  }
}

export type DemoCostSettings = {
  currency: string
  databasePrice: string
  filePrice: string
  otherMonthly: string
}
// Convex's US Professional rates ($0.20 database, $0.03 files) × EU region factor 1.3.
export const DEMO_CONVEX_PRICING_SOURCE = 'https://docs.convex.dev/production/state/limits'
export const DEMO_CONVEX_PRICING_CHECKED_AT = '2026-09-15'
export const DEFAULT_DEMO_COST_SETTINGS: DemoCostSettings = {
  currency: 'USD',
  databasePrice: '0.26',
  filePrice: '0.039',
  otherMonthly: '',
}

export function parseDemoPrice(value: string): number | null {
  const text = value.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Local browser preferences are untrusted and must never become NaN costs. */
export function readDemoCostSettings(value: string | null): DemoCostSettings {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null')
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_DEMO_COST_SETTINGS }
    const row = parsed as Record<string, unknown>
    const currency =
      typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : 'USD'
    // Published prices are USD. Missing custom-currency rates must not acquire
    // USD numeric defaults under another currency label.
    const settings: DemoCostSettings =
      currency === 'USD'
        ? { ...DEFAULT_DEMO_COST_SETTINGS }
        : { currency, databasePrice: '', filePrice: '', otherMonthly: '' }
    for (const field of ['databasePrice', 'filePrice', 'otherMonthly'] as const) {
      if (typeof row[field] === 'string' && parseDemoPrice(row[field]) !== null)
        settings[field] = row[field]
    }
    return settings
  } catch {
    return { ...DEFAULT_DEMO_COST_SETTINGS }
  }
}

export function estimateDemoMonthlyCost(report: DemoMetricsReport, settings: DemoCostSettings) {
  const basis = demoMonthlyStorage(report)
  const databasePrice = parseDemoPrice(settings.databasePrice)
  const filePrice = parseDemoPrice(settings.filePrice)
  const other = settings.otherMonthly.trim() ? parseDemoPrice(settings.otherMonthly) : 0
  if (
    !basis.samples ||
    databasePrice === null ||
    filePrice === null ||
    other === null ||
    !/^[A-Z]{3}$/.test(settings.currency)
  )
    return { basis, cost: null }
  const database = (basis.databaseBytes / GB) * databasePrice
  const files = (basis.fileBytes / GB) * filePrice
  const total = database + files + other
  if (!Number.isFinite(total)) return { basis, cost: null }
  return { basis, cost: { database, files, other, total } }
}

export function fmtDemoBytes(bytes: number): string {
  if (bytes < KB) return `${Math.round(bytes)} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}
