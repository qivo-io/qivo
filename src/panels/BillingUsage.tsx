import { FieldHint, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import { billingBytes, billingDate, billingMoney } from '@/lib/billingDisplay'
import type { BillingUsage as BillingUsageData } from '../../convex/lib/billingTypes'

export function BillingUsage({
  usage,
  currency,
  measuredAt,
}: {
  usage: BillingUsageData
  currency: string
  measuredAt: number
}) {
  return (
    <SettingsSection
      title="Usage"
      description={`Measured ${new Date(measuredAt).toLocaleString()}. Allowances are shared across your organization.`}
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
        <p className="text-base">
          {usage.period_start && usage.period_end
            ? `${billingDate(usage.period_start)} – ${billingDate(usage.period_end)}`
            : 'No paid billing period yet'}
        </p>
      </SettingsField>
      <SettingsField label="API calls" width={550}>
        <p className="text-base">
          {usage.calls.toLocaleString()} of {usage.included_calls.toLocaleString()} included calls
        </p>
        <FieldHint>
          {usage.waived
            ? 'API usage is covered by free access. It will not be charged later.'
            : `Extra API charges recorded this period: ${billingMoney(usage.api_overage_cents, currency)}. Added to your next renewal invoice.`}
        </FieldHint>
      </SettingsField>
      <SettingsField label="Attachment storage" width={550}>
        <p className="text-base">
          {billingBytes(usage.storage_bytes)} of {billingBytes(usage.included_storage_bytes)}{' '}
          included
        </p>
        <FieldHint>
          {usage.waived
            ? 'Storage is covered by free access. It will not be charged later.'
            : `Extra storage charge recorded this period: ${billingMoney(usage.storage_overage_cents, currency)}, based on storage measured at the start of the period. Added to your next renewal invoice.`}
        </FieldHint>
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
                  <dt className="min-w-0 break-words text-sm">{project.name}</dt>
                  <dd className="text-sm text-text-2">{billingBytes(project.storage_bytes)}</dd>
                </div>
              ))}
          </dl>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}
