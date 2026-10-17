import { ConvexError } from 'convex/values'
import type { BillingUsage } from '../../convex/lib/billingTypes'

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
    BillingUsage,
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
    api: `Extra API charges recorded this period: ${billingMoney(usage.api_overage_cents, currency)}. Added to your next renewal invoice.`,
    storage: `Extra storage charge recorded this period: ${billingMoney(usage.storage_overage_cents, currency)}, based on storage measured at the start of the period. Added to your next renewal invoice.`,
  }
}
