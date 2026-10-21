import { FieldHint, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import { billingBytes, billingDate, usageHints } from '@/lib/billingDisplay'
import type { BillingUsage as BillingUsageData } from '../../convex/lib/billingTypes'
import { projectName } from '../../convex/lib/recordNames'

/** The period line: a paid period's dates, a UTC calendar month, or the start
 * of an interval whose end is not known yet. */
function periodLabel(usage: BillingUsageData): string {
  if (usage.period_kind === 'month')
    return `${billingDate(usage.period_start, 'UTC')} – ${billingDate(usage.period_end, 'UTC')}`
  return usage.period_end
    ? `${billingDate(usage.period_start)} – ${billingDate(usage.period_end)}`
    : `From ${billingDate(usage.period_start)}`
}

/** Usage for the bucket API calls are recorded in now. `currency` is the
 * plan's; amounts are only shown for a charged period, which always has one. */
export function BillingUsage({
  usage,
  currency,
  measuredAt,
}: {
  usage: BillingUsageData
  currency: string | undefined
  measuredAt: number
}) {
  const month = usage.period_kind === 'month'
  const hints = usageHints(usage, currency)
  return (
    <SettingsSection
      title="Usage"
      description={`Measured ${new Date(measuredAt).toLocaleString()}.${
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
      <SettingsField label="Attachment storage" width={550}>
        <p className="text-base">
          {billingBytes(usage.storage_bytes)}
          {usage.included_storage_bytes === null
            ? ' stored'
            : ` of ${billingBytes(usage.included_storage_bytes)} included`}
        </p>
        <FieldHint>{hints.storage}</FieldHint>
      </SettingsField>
      <SettingsGroup
        legend="API calls by account"
        description="Each account’s total includes its keys."
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
                  <dd className="mt-1 text-sm text-text-2">
                    {account.calls.toLocaleString()} calls
                    {account.keys.length > 0 && (
                      <ul className="mt-1 space-y-1 pl-3">
                        {account.keys.map((key) => (
                          <li key={key.id} className="break-words">
                            {key.name}: {key.calls.toLocaleString()} calls
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              ))}
          </dl>
        )}
      </SettingsGroup>
      <SettingsGroup legend="Storage by project">
        {usage.projects.length === 0 ? (
          <p className="text-sm text-text-2">No stored attachments.</p>
        ) : (
          <dl className="space-y-2">
            {[...usage.projects]
              .sort((a, b) => b.storage_bytes - a.storage_bytes)
              .map((project) => (
                <div key={project.project_id} className="flex flex-wrap justify-between gap-2">
                  {/* attachments belong to tasks, which live in sub-projects */}
                  <dt className="min-w-0 break-words text-sm">
                    {projectName({ name: project.name, type: 'project' })}
                  </dt>
                  <dd className="text-sm text-text-2">{billingBytes(project.storage_bytes)}</dd>
                </div>
              ))}
          </dl>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}
