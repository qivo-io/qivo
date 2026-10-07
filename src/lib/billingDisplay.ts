import { ConvexError } from 'convex/values'

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

export function billingDate(value: string | number | null | undefined): string {
  return value == null
    ? '—'
    : new Date(value).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
}

export function billingBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}
