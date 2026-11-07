import { ConvexError } from 'convex/values'
import type {
  BillingDetails,
  BillingPeriodHead,
  BillingUsageFigures,
  StorageProjectRow,
} from '../../convex/lib/billingTypes'

export function billingError(cause: unknown): string {
  if (cause instanceof ConvexError) {
    const data = cause.data
    if (typeof data === 'string') return data
    if (data && typeof data === 'object' && typeof data.message === 'string') return data.message
  }
  return cause instanceof Error
    ? cause.message
    : 'Could not complete the billing request. Try again.'
}

export function billingMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
}

/** A short local date such as "1 Oct 2026". Pass `'UTC'` for dates that name
 * a UTC day, such as the bounds of a calendar-month usage period. */
export function billingDate(value: string | number | null | undefined, timeZone?: string): string {
  return value == null
    ? '—'
    : new Date(value).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone,
      })
}

export function billingBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

/** What the storage lines read of Billing's usage figures about the paid
 * period's storage basis. Both fields are absent from a backend before
 * them, which reads as a period sampled at its start. */
type StorageBasis = Partial<Pick<BillingUsageFigures, 'storage_basis' | 'storage_average'>>

/** The hints under the Billing page's API calls and storage figures: why
 * the current bucket is not charged, or what it has recorded so far. A
 * period charged on its daily average (`storage_basis` 'daily') says so
 * while it is open, and once it is recorded names its charge, or none when
 * no measurement was available. `currency` is the plan's; a charged period
 * always has one. */
export function usageHints(
  usage: Pick<
    BillingPeriodHead,
    'period_kind' | 'waived' | 'api_overage_cents' | 'storage_overage_cents'
  > &
    StorageBasis,
  currency: string | undefined,
): { api: string; storage: string } {
  if (usage.period_kind === 'month')
    return {
      api: 'API calls are not charged without a paid period.',
      storage: 'Storage is not charged without a paid period.',
    }
  // recordApiCall never charges an interval whose renewal is unconfirmed,
  // and the new period's storage is measured once the renewal is confirmed.
  if (usage.period_kind === 'pending')
    return {
      api: 'API calls are not charged while the renewal awaits confirmation.',
      storage: 'Storage for the new period is measured once the renewal is confirmed.',
    }
  if (usage.waived || currency === undefined)
    return {
      api: 'API usage is covered by free access. It will not be charged later.',
      storage: 'Storage is covered by free access. It will not be charged later.',
    }
  const api = `Extra API charges recorded this period: ${billingMoney(usage.api_overage_cents, currency)}. Added to the invoice at the end of this period.`
  const charge = billingMoney(usage.storage_overage_cents, currency)
  if (usage.storage_basis !== 'daily')
    return {
      api,
      storage: `Extra storage charge recorded this period: ${charge}, based on the storage measured for this period. Added to the invoice at the end of this period.`,
    }
  const average = usage.storage_average
  if (!average?.final)
    return {
      api,
      storage:
        'Storage is charged on the average of this period’s daily measurements, which is recorded shortly before the period ends. Added to the invoice at the end of this period.',
    }
  if (average.bytes === null)
    return {
      api,
      storage: 'No storage charge for this period, since no storage measurement was available.',
    }
  return {
    api,
    storage: `Extra storage charge recorded this period: ${charge}, based on this period’s average storage. Added to the invoice at the end of this period.`,
  }
}

/** The most rows Billing's Storage by project gathers with Load more, 80
    batches; past it, a search narrows the list. It is above the 1,500
    projects with files the design size allows (500 live and 1,000 archived
    sub-projects), so every project inside it is reachable without
    searching. Tests lower it. */
export const STORAGE_LIST = { most: 2000 }

/** The most rows Billing's API calls by account gathers with Load more, 80
    batches; past it, a search narrows the list. A bucket's accounts are at
    most the 1,000 people and agents the design size allows, with the
    removed accounts whose calls still count, so every account inside it is
    reachable without searching. The limits plan bounds Billing's lists
    together: with Storage by project and the two name lists the page holds
    at most 8,000 rows, about 1 MB, and drops them when Billing is left.
    Tests lower it. */
export const ACCOUNT_LIST = { most: 2000 }

/** The most names each of Billing's Who counts toward your bill and Who
    does not count toward your bill gathers with Load more; past it, a
    search narrows the list. The two lists together name the
    organization's people and agents, at most 1,000 at the design size, so
    every name is reachable without searching, and a closed list holds
    none. Tests lower it. */
export const NAME_LIST = { most: 2000 }

/** A Storage by project row's id: its project id and number, which name
    one totals row, since a project id can come back under another number. */
export const storageRowId = (row: StorageProjectRow) => `${row.project_id}:${row.num ?? ''}`

/** What Billing's current storage counts, under its figure. */
export const STORAGE_COUNTS =
  'Task attachments and description images, files in Deleted items included until they are deleted for good. Profile pictures and backgrounds are part of the base price.'

/** What Billing shows while the organization's stored-byte totals are
    being counted, in place of a figure, never 0. */
export const STORAGE_COUNTING = 'Being counted. Check again later.'

/** What Billing shows while the bucket's API calls are being counted
    (billing.usageFigures answers null), in place of a figure, never 0. */
export const CALLS_COUNTING = 'Being counted. Check again later.'

/** How long after its period's start a sample still reads as measured at
    the start. A sample normally finishes within a second of the renewal. */
export const SAMPLE_AT_START_MS = 24 * 60 * 60_000

/** The line under current storage that names the storage the paid
    period's sample measured, which the period's storage charge uses. The
    sample reads the same stored-byte totals as current storage, files in
    Deleted items included (convex/billingSync.ts storageStep), so the two
    differ only by what changed since it was taken, normally at the start
    of the period. A sample that waited, as while the totals were counted
    again, or that was started again later measures storage when it runs,
    so when that was SAMPLE_AT_START_MS or more after the start the line
    names its date. A sample without a time, which an earlier backend
    finished or an older backend answers without one, measured the start.
    The words name no files, so they stay true of a sample an earlier
    backend took from the attachment rows of live tasks. Null outside a
    paid period, for a trial, which never gets a sample
    (convex/billingSync.ts apply records a period only for an active or
    past-due subscription), and for a period charged on its daily average,
    which storageAverageLine describes instead. An answer without
    `storage_basis`, from an older backend, reads as a sample. `status` is
    the details'. */
export function storageSampleLine(
  usage: Pick<
    BillingUsageFigures,
    'period_kind' | 'period_start' | 'sampled_storage_bytes' | 'sampled_storage_at'
  > &
    StorageBasis,
  status: BillingDetails['status'] | undefined,
): string | null {
  if (usage.period_kind !== 'paid' || status === 'trialing' || usage.storage_basis === 'daily')
    return null
  const bytes = usage.sampled_storage_bytes
  if (bytes === null) return 'Not measured yet for this period.'
  const at = usage.sampled_storage_at
  return at == null || Date.parse(at) - Date.parse(usage.period_start) < SAMPLE_AT_START_MS
    ? `${billingBytes(bytes)} measured at the start of this period.`
    : `${billingBytes(bytes)} measured on ${billingDate(at)}.`
}

/* `n` days, in words. */
const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/* The sentence on a daily average's estimated days, or nothing without
   any: those that copied the next measured day's reading, and at the
   cutoff those that copied the most recent one before them. */
function estimatedDays(average: NonNullable<BillingUsageFigures['storage_average']>): string {
  const { estimated, estimated_earlier: earlier } = average
  const next = estimated - earlier
  if (estimated === 0) return ''
  if (earlier === 0) return ` ${estimated} of them estimated from the next measured day.`
  if (next === 0) return ` ${estimated} of them estimated from the most recent measured day.`
  return ` ${estimated} of them estimated, ${next} from the next measured day and ${earlier} from the most recent one.`
}

/** The line under current storage for a paid period charged on the
    average of its daily storage measurements (`storage_basis` 'daily',
    convex/billingSync.ts finalizeStorage), in place of the sample line.
    Once the period is recorded it names the average its storage charge
    uses over the period's days, how many days were estimated and from
    which measured day, or that no measurement was available, so it has no
    storage charge. While it is open it names the average so far and how
    many of the period's days it covers, of them how many were estimated,
    since a day without a later measurement yet is left out, never 0. Null
    for every other period and bucket, for a trial, and for an answer
    without `storage_basis` from an older backend. `status` is the
    details'. */
export function storageAverageLine(
  usage: Pick<BillingUsageFigures, 'period_kind'> & StorageBasis,
  status: BillingDetails['status'] | undefined,
): string | null {
  if (usage.period_kind !== 'paid' || status === 'trialing' || usage.storage_basis !== 'daily')
    return null
  const average = usage.storage_average
  if (!average) return 'Not measured yet for this period.'
  if (average.final)
    return average.bytes === null
      ? 'No storage measurement was available for this period.'
      : `${billingBytes(average.bytes)} average over this period’s ${dayCount(average.days)}.${estimatedDays(average)}`
  if (average.bytes === null) return 'Not measured yet for this period.'
  const covered = average.measured + average.estimated
  return `${billingBytes(average.bytes)} average so far, from ${covered} of this period’s ${dayCount(average.days)}.${estimatedDays(average)}`
}
