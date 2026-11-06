import { FieldHint, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import type { ApiAccessEntry } from '@/lib/apiAccess'
import {
  billingBytes,
  billingDate,
  STORAGE_COUNTING,
  STORAGE_COUNTS,
  storageSampleLine,
  usageHints,
} from '@/lib/billingDisplay'
import type {
  BillingSummary,
  BillingUsage as BillingUsageData,
} from '../../convex/lib/billingTypes'
import { BillingStorage } from './BillingStorage'

/** The period line: a paid period's dates, a UTC calendar month, or the start
 * of an interval whose end is not known yet. */
function periodLabel(usage: BillingUsageData): string {
  if (usage.period_kind === 'month')
    return `${billingDate(usage.period_start, 'UTC')} – ${billingDate(usage.period_end, 'UTC')}`
  return usage.period_end
    ? `${billingDate(usage.period_start)} – ${billingDate(usage.period_end)}`
    : `From ${billingDate(usage.period_start)}`
}

/** Usage for the bucket API calls are recorded in now (billing.currentUsage).
 * `currency` is the plan's; amounts are only shown for a charged period,
 * which always has one, and `status` is the summary's, which says whether a
 * paid period gets a storage sample. Current storage is the server's
 * stored-byte totals, files in Deleted items included, shown as being
 * counted while they are not complete, never as 0, with the paid period's
 * sample on a line of its own. Each account shows its total, and View
 * credentials hands `onViewCredentials` the organization `orgId` the usage
 * was read for, the account and the period, for API access to open on.
 * Storage by project reads its own batches (BillingStorage) and starts
 * over when `refresh`, the page's Refresh count, changes. */
export function BillingUsage({
  usage,
  currency,
  status,
  measuredAt,
  orgId,
  refresh,
  onViewCredentials,
}: {
  usage: BillingUsageData
  currency: string | undefined
  status: BillingSummary['status'] | undefined
  measuredAt: number
  orgId: string
  refresh: number
  onViewCredentials: (entry: ApiAccessEntry) => void
}) {
  const month = usage.period_kind === 'month'
  const hints = usageHints(usage, currency)
  const sample = storageSampleLine(usage, status)
  return (
    <SettingsSection
      title="Usage"
      description={`Measured ${new Date(measuredAt).toLocaleString()}. Usage can change while you browse. Refresh shows the current figures and lists.${
        usage.included_calls === null ? '' : ' Allowances are shared across your organization.'
      }`}
      data-billing-usage=""
    >
      {usage.delivery_unconfirmed && (
        <SettingsField label="Usage reconciliation" width={550}>
          <FieldHint>
            Some usage delivery is unconfirmed. Recorded charges are estimates; check your invoice
            for the final amount.
          </FieldHint>
        </SettingsField>
      )}
      <SettingsField label="Current period" width={550}>
        <p className="text-base">{periodLabel(usage)}</p>
        {month && <FieldHint>Calendar month in UTC, used while there is no paid period.</FieldHint>}
        {usage.period_kind === 'pending' && (
          <FieldHint>Waiting for the renewal to be confirmed.</FieldHint>
        )}
      </SettingsField>
      <SettingsField label="API calls" width={550}>
        <p className="text-base">
          {usage.calls.toLocaleString()}
          {usage.included_calls === null
            ? ' calls'
            : ` of ${usage.included_calls.toLocaleString()} included calls`}
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
        <FieldHint>{hints.storage}</FieldHint>
      </SettingsField>
      <SettingsGroup
        legend="API calls by account"
        description="Each account’s total covers all of its credentials."
      >
        {usage.users.length === 0 ? (
          <p className="text-sm text-text-2">No recorded API calls this period.</p>
        ) : (
          <dl className="space-y-4">
            {[...usage.users]
              .sort((a, b) => b.calls - a.calls)
              .map((account) => (
                <div key={account.profile_id} data-billing-account={account.profile_id}>
                  <dt className="break-words text-sm font-semibold">{account.name}</dt>
                  <dd className="mt-1 flex flex-wrap items-baseline gap-x-3 text-sm text-text-2">
                    {account.calls.toLocaleString()} calls
                    <Button
                      type="button"
                      variant="unstyled"
                      data-billing-view-credentials={account.profile_id}
                      aria-label={`View credentials of ${account.name}`}
                      onClick={() =>
                        onViewCredentials({
                          org_id: orgId,
                          profile_id: account.profile_id,
                          period_key: usage.period_key,
                        })
                      }
                      className="align-baseline font-normal text-text-1 underline underline-offset-4"
                    >
                      View credentials
                    </Button>
                  </dd>
                </div>
              ))}
          </dl>
        )}
      </SettingsGroup>
      <BillingStorage orgId={orgId} refresh={refresh} />
    </SettingsSection>
  )
}
