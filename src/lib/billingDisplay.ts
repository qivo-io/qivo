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

/** The hints under the Billing page's API calls and storage figures: why
 * the current bucket is not charged, or what it has recorded so far.
 * `currency` is the plan's; a charged period always has one. */
export function usageHints(
  usage: Pick<
    BillingPeriodHead,
    'period_kind' | 'waived' | 'api_overage_cents' | 'storage_overage_cents'
  >,
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
  return {
    api: `Extra API charges recorded this period: ${billingMoney(usage.api_overage_cents, currency)}. Added to the invoice at the end of this period.`,
    storage: `Extra storage charge recorded this period: ${billingMoney(usage.storage_overage_cents, currency)}, based on storage measured at the start of the period. Added to the invoice at the end of this period.`,
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

/** The line under current storage that names the storage the paid
    period's sample measured at its start, which the period's storage
    charge uses and which leaves files in Deleted items out, so the page
    never implies the charge counts them. Null outside a paid period, and
    for a trial, which never gets a sample (convex/billingSync.ts apply
    records a period only for an active or past-due subscription).
    `status` is the details'. */
export function storageSampleLine(
  usage: Pick<BillingUsageFigures, 'period_kind' | 'sampled_storage_bytes'>,
  status: BillingDetails['status'] | undefined,
): string | null {
  if (usage.period_kind !== 'paid' || status === 'trialing') return null
  return usage.sampled_storage_bytes === null
    ? 'Not measured yet for this period.'
    : `${billingBytes(usage.sampled_storage_bytes)} measured at the start of this period, without files in Deleted items.`
}
