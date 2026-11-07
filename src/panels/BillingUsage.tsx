import { FieldHint, SettingsField, SettingsSection } from '@/components/settingsPage'
import type { ApiAccessEntry } from '@/lib/apiAccess'
import {
  billingBytes,
  billingDate,
  CALLS_COUNTING,
  STORAGE_COUNTING,
  STORAGE_COUNTS,
  storageAverageLine,
  storageSampleLine,
  usageHints,
} from '@/lib/billingDisplay'
import type { BillingDetails, BillingUsageFigures } from '../../convex/lib/billingTypes'
import { BillingApiAccounts } from './BillingApiAccounts'
import { BillingStorage } from './BillingStorage'

/** The period line: a paid period's dates, a UTC calendar month, or the start
 * of an interval whose end is not known yet. */
function periodLabel(usage: BillingUsageFigures): string {
  if (usage.period_kind === 'month')
    return `${billingDate(usage.period_start, 'UTC')} – ${billingDate(usage.period_end, 'UTC')}`
  return usage.period_end
    ? `${billingDate(usage.period_start)} – ${billingDate(usage.period_end)}`
    : `From ${billingDate(usage.period_start)}`
}

/* The section's line under its title: when the figures were measured, once
   they answered, that usage can change while browsing, and that allowances
   are shared once a plan sets them. */
function sectionLine(usage: BillingUsageFigures | null, measuredAt: number): string {
  const browse = 'Usage can change while you browse. Refresh shows the current figures and lists.'
  if (usage === null) return browse
  const shared =
    usage.included_calls === null ? '' : ' Allowances are shared across your organization.'
  return `Measured ${new Date(measuredAt).toLocaleString()}. ${browse}${shared}`
}

/** Billing's Usage section, rendered once the details answered. Its figures
 * are the bucket API calls are recorded in now (billing.usageFigures),
 * `usage`, null until the first read answers, with "Loading usage…" in
 * their place, or `error`, the last read's failure, which shows above the
 * last figures, or in their place before any answered. `currency` is the
 * plan's; amounts are only shown for a charged period, which always has
 * one, and `status` is the details', which says whether a paid period gets
 * a storage sample or a daily average. API calls are the bucket's
 * aggregates, shown as being counted while they are not complete, never
 * as 0, and so is current storage, the server's stored-byte totals, files
 * in Deleted items included, with the paid period's sample of the same
 * totals on a line of its own, or for a period charged on the average of
 * its daily measurements that average with its estimated days
 * (storageAverageLine). API calls by account (BillingApiAccounts) mounts
 * once the figures answered and reads the bucket they name; View
 * credentials hands `onViewCredentials` the organization `orgId`, the
 * account and that bucket. Storage by project reads its own batches
 * (BillingStorage) at once. Both lists start over when `refresh`, the
 * page's Refresh count, changes. */
export function BillingUsage({
  usage,
  error,
  currency,
  status,
  measuredAt,
  orgId,
  refresh,
  onViewCredentials,
}: {
  usage: BillingUsageFigures | null
  error: string
  currency: string | undefined
  status: BillingDetails['status'] | undefined
  measuredAt: number
  orgId: string
  refresh: number
  onViewCredentials: (entry: ApiAccessEntry) => void
}) {
  return (
    <SettingsSection
      title="Usage"
      description={sectionLine(usage, measuredAt)}
      data-billing-usage=""
    >
      {error && (
        <p role="alert" data-billing-usage-error="" className="mb-4 text-sm text-danger">
          Usage could not be refreshed: {error}
        </p>
      )}
      {usage === null && !error && (
        <p role="status" data-billing-usage-loading="" className="mb-6 text-sm text-text-2">
          Loading usage…
        </p>
      )}
      {usage !== null && <Figures usage={usage} currency={currency} status={status} />}
      {usage !== null && (
        <BillingApiAccounts
          orgId={orgId}
          period={usage.period_key}
          refresh={refresh}
          onViewCredentials={onViewCredentials}
        />
      )}
      <BillingStorage orgId={orgId} refresh={refresh} />
    </SettingsSection>
  )
}

/* The figures of one answer: the reconciliation notice, the period, API
   calls and current storage. */
function Figures({
  usage,
  currency,
  status,
}: {
  usage: BillingUsageFigures
  currency: string | undefined
  status: BillingDetails['status'] | undefined
}) {
  const month = usage.period_kind === 'month'
  const hints = usageHints(usage, currency)
  const sample = storageSampleLine(usage, status)
  const average = storageAverageLine(usage, status)
  return (
    <>
      {usage.delivery_unconfirmed && (
        <SettingsField label="Usage reconciliation" width={550}>
          <FieldHint>
            Some usage delivery is unconfirmed. Recorded charges are estimates; check your invoice
            for the final amount.
          </FieldHint>
        </SettingsField>
      )}
      <SettingsField label="Current period" width={550}>
        <p className="text-base" data-billing-period={usage.period_key}>
          {periodLabel(usage)}
        </p>
        {month && <FieldHint>Calendar month in UTC, used while there is no paid period.</FieldHint>}
        {usage.period_kind === 'pending' && (
          <FieldHint>Waiting for the renewal to be confirmed.</FieldHint>
        )}
      </SettingsField>
      <SettingsField label="API calls" width={550}>
        <p className="text-base" data-billing-calls="">
          {usage.calls === null
            ? CALLS_COUNTING
            : `${usage.calls.toLocaleString()}${
                usage.included_calls === null
                  ? ' calls'
                  : ` of ${usage.included_calls.toLocaleString()} included calls`
              }`}
        </p>
        <FieldHint>{hints.api}</FieldHint>
      </SettingsField>
      <SettingsField label="Current storage" width={550}>
        <p className="text-base" data-billing-storage-bytes="">
          {usage.storage_bytes === null
            ? STORAGE_COUNTING
            : `${billingBytes(usage.storage_bytes)}${
                usage.included_storage_bytes === null
                  ? ' stored'
                  : ` of ${billingBytes(usage.included_storage_bytes)} included`
              }`}
        </p>
        <FieldHint>{STORAGE_COUNTS}</FieldHint>
        {sample !== null && (
          <p className="mt-2 text-sm text-text-1" data-billing-storage-sample="">
            {sample}
          </p>
        )}
        {average !== null && (
          <p className="mt-2 text-sm text-text-1" data-billing-storage-average="">
            {average}
          </p>
        )}
        <FieldHint>{hints.storage}</FieldHint>
      </SettingsField>
    </>
  )
}
