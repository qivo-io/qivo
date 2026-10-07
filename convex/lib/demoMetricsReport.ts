/** Aggregate-only wire contract between the isolated demo and operator console. */
export type DemoAudience = {
  browsers: { name: string; count: number }[]
  operatingSystems: { name: string; count: number }[]
  countries: { name: string; count: number }[]
}

export type DemoMetricsReport = {
  version: 1
  generatedAt: number
  trackingStartedAt: number | null
  historyCompleteSince: number | null
  totalCreated: number
  active: number
  deleting: number
  counts: { date: string; created: number }[]
  storage: { sampledAt: number; databaseBytes: number; fileBytes: number } | null
  storageDaily: {
    date: string
    samples: number
    databaseBytesSum: number
    fileBytesSum: number
  }[]
  audience: { last7Days: DemoAudience; last30Days: DemoAudience; last12Months: DemoAudience }
}

export type DemoMetricsResult =
  | { status: 'ready'; report: DemoMetricsReport }
  | { status: 'not_configured'; message: string }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown): value is number => number(value) && Number.isSafeInteger(value)
// All wire dates use four-digit UTC years, including generatedAt's day.
const instant = (value: unknown): value is number => count(value) && value < 253_402_300_800_000
const timestamp = (value: unknown): value is number | null => value === null || instant(value)
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function parseAudience(value: unknown): DemoAudience {
  if (!object(value)) throw new Error('The demo service returned invalid visitor statistics.')
  const dimension = (rows: unknown, country = false) => {
    const seen = new Set<string>()
    if (!Array.isArray(rows) || rows.length > (country ? 300 : 32))
      throw new Error('The demo service returned invalid visitor statistics.')
    return rows.map((row) => {
      if (
        !object(row) ||
        typeof row.name !== 'string' ||
        !row.name ||
        row.name.length > 64 ||
        (country && !/^[A-Z]{2}$/.test(row.name)) ||
        !count(row.count) ||
        seen.has(row.name)
      )
        throw new Error('The demo service returned invalid visitor statistics.')
      seen.add(row.name)
      return { name: row.name, count: row.count }
    })
  }
  return {
    browsers: dimension(value.browsers),
    operatingSystems: dimension(value.operatingSystems),
    countries: dimension(value.countries, true),
  }
}

/** Project known aggregate fields only; remote records never reach the browser. */
export function parseDemoMetricsReport(value: unknown): DemoMetricsReport {
  const invalid = () => new Error('The demo service returned an invalid usage report.')
  if (
    !object(value) ||
    value.version !== 1 ||
    !instant(value.generatedAt) ||
    !timestamp(value.trackingStartedAt) ||
    !timestamp(value.historyCompleteSince) ||
    !count(value.totalCreated) ||
    !count(value.active) ||
    !count(value.deleting) ||
    !Array.isArray(value.counts) ||
    value.counts.length > 800 ||
    !Array.isArray(value.storageDaily) ||
    value.storageDaily.length > 800 ||
    !object(value.audience)
  )
    throw invalid()
  if (
    (value.trackingStartedAt === null) !== (value.historyCompleteSince === null) ||
    (value.trackingStartedAt !== null &&
      (value.historyCompleteSince === null ||
        value.historyCompleteSince < value.trackingStartedAt ||
        value.historyCompleteSince > value.generatedAt))
  )
    throw invalid()
  const today = new Date(value.generatedAt).toISOString().slice(0, 10)
  const seenCounts = new Set<string>()
  const counts = value.counts.map((row) => {
    if (
      !object(row) ||
      !date(row.date) ||
      row.date > today ||
      !count(row.created) ||
      seenCounts.has(row.date)
    )
      throw invalid()
    seenCounts.add(row.date)
    return { date: row.date, created: row.created }
  })
  const seenStorage = new Set<string>()
  const storageDaily = value.storageDaily.map((row) => {
    if (
      !object(row) ||
      !date(row.date) ||
      row.date > today ||
      !count(row.samples) ||
      row.samples === 0 ||
      !number(row.databaseBytesSum) ||
      !number(row.fileBytesSum) ||
      seenStorage.has(row.date)
    )
      throw invalid()
    seenStorage.add(row.date)
    return {
      date: row.date,
      samples: row.samples,
      databaseBytesSum: row.databaseBytesSum,
      fileBytesSum: row.fileBytesSum,
    }
  })
  let storage: DemoMetricsReport['storage'] = null
  if (value.storage !== null) {
    const row = value.storage
    if (
      !object(row) ||
      !instant(row.sampledAt) ||
      row.sampledAt > value.generatedAt ||
      value.trackingStartedAt === null ||
      row.sampledAt < value.trackingStartedAt ||
      !number(row.databaseBytes) ||
      !number(row.fileBytes)
    )
      throw invalid()
    storage = {
      sampledAt: row.sampledAt,
      databaseBytes: row.databaseBytes,
      fileBytes: row.fileBytes,
    }
  }
  return {
    version: 1,
    generatedAt: value.generatedAt,
    trackingStartedAt: value.trackingStartedAt,
    historyCompleteSince: value.historyCompleteSince,
    totalCreated: value.totalCreated,
    active: value.active,
    deleting: value.deleting,
    counts,
    storage,
    storageDaily,
    audience: {
      last7Days: parseAudience(value.audience.last7Days),
      last30Days: parseAudience(value.audience.last30Days),
      last12Months: parseAudience(value.audience.last12Months),
    },
  }
}
