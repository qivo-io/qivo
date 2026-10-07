import { FieldHint, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { billingDate, billingMoney } from '@/lib/billingDisplay'
import type { BillingSummary } from '../../convex/lib/billingTypes'

const statusLabels: Record<BillingSummary['status'], string> = {
  unconfigured: 'Not configured',
  pending: 'Subscription required',
  complimentary: 'Complimentary access',
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment overdue',
  canceled: 'Canceled',
  unpaid: 'Payment required',
  paused: 'Paused',
}

function statusExplanation(billing: BillingSummary): string {
  if (!billing.enabled)
    return 'Billing is not enabled. You can continue using your organization and adding users.'
  if (billing.status === 'complimentary')
    return 'Your organization has free access without a payment card.'
  if (billing.cancel_at_period_end && billing.writable)
    return 'Your subscription ends at the end of the current paid period.'
  if (billing.status === 'past_due')
    return 'Update your payment method in the customer portal. Polar retries failed payments automatically.'
  if (!billing.writable)
    return 'Your organization is read-only until you subscribe or restore payment. Your existing work remains available.'
  return 'Your subscription renews automatically with your current number of billable users.'
}

export function BillingOverview({
  billing,
  busy,
  onCheckout,
  onManage,
}: {
  billing: BillingSummary
  busy: boolean
  onCheckout: () => void
  onManage: () => void
}) {
  const plan = billing.plan
  return (
    <>
      <SettingsSection title="Subscription" data-billing-subscription="">
        <SettingsField label="Plan" width={550}>
          <p data-billing-plan className="text-base font-semibold">
            {plan?.name ?? 'No plan assigned'}
          </p>
          {plan && (
            <FieldHint>
              {billingMoney(plan.seat_price_cents, plan.currency)} per active user per month, with a{' '}
              {plan.minimum_seats}-user minimum.{' '}
              {billing.plan_assigned
                ? 'Your organization keeps these plan terms when new customer pricing changes.'
                : 'The available plan will be assigned when your subscription is set up.'}
            </FieldHint>
          )}
        </SettingsField>
        <SettingsField label="Status" width={550} hint={statusExplanation(billing)}>
          <p data-billing-status className="text-base">
            {billing.enabled ? statusLabels[billing.status] : 'Billing not enabled'}
          </p>
        </SettingsField>
        {billing.complimentary_until && billing.status === 'complimentary' && (
          <SettingsField label="Free access ends" width={550}>
            <p className="text-base">{billingDate(billing.complimentary_until)}</p>
            <FieldHint>
              No card is required during free access. Subscribe when it ends to continue editing.
              Free-period usage will not be charged later.
            </FieldHint>
          </SettingsField>
        )}
        {billing.current_period_end && (
          <SettingsField
            label={billing.cancel_at_period_end ? 'Subscription ends' : 'Next renewal'}
            width={550}
          >
            <p className="text-base">{billingDate(billing.current_period_end)}</p>
          </SettingsField>
        )}
        {plan && (
          <SettingsGroup legend="Shared usage allowances">
            <p className="text-sm text-text-2">
              {plan.storage_gb_per_seat} GB of storage and{' '}
              {plan.api_calls_per_seat.toLocaleString()} API calls per billed user, pooled across
              your organization, with at least {plan.minimum_storage_gb} GB of storage.
            </p>
            <FieldHint>
              Extra storage costs {billingMoney(plan.storage_block_price_cents, plan.currency)} per
              started GB. Extra API calls cost{' '}
              {billingMoney(plan.api_block_price_cents, plan.currency)} per started{' '}
              {plan.api_block_size.toLocaleString()} calls.
            </FieldHint>
          </SettingsGroup>
        )}
        <SettingsGroup legend="Payment and invoices">
          <div className="flex flex-wrap items-center gap-2">
            {billing.checkout_available && (
              <Button type="button" data-billing-checkout disabled={busy} onClick={onCheckout}>
                {busy ? 'Opening…' : 'Subscribe'}
              </Button>
            )}
            {billing.portal_available && (
              <Button type="button" data-billing-portal disabled={busy} onClick={onManage}>
                {busy ? 'Opening…' : 'Manage billing'}
              </Button>
            )}
          </div>
          <FieldHint>
            {billing.status === 'complimentary'
              ? `Subscribe from ${billingDate(billing.complimentary_until)}. Your organization admins will receive reminders before free access ends.`
              : !billing.configured
                ? 'Payment setup is not available yet.'
                : 'Pay by card through Polar. Manage payment details, invoices and cancellation in the customer portal. Applicable taxes are shown at checkout.'}
          </FieldHint>
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title="Users"
        description="People, viewers and agents count, unless they are inactive."
        data-billing-users=""
      >
        <SettingsField label="Current billable users" width={550}>
          <p data-seat-count className="text-base font-semibold">
            {billing.billable_users} active user{billing.billable_users === 1 ? '' : 's'}
          </p>
        </SettingsField>
        <SettingsField label="Inactive users" width={550}>
          <p data-billing-inactive-count className="text-base font-semibold">
            {billing.inactive_users} inactive user{billing.inactive_users === 1 ? '' : 's'}
          </p>
        </SettingsField>
        {billing.invited_users_with_own_billing > 0 && (
          <SettingsField label="Invited users with their own billing" width={550}>
            <p data-billing-own-count className="text-base">
              {billing.invited_users_with_own_billing}
            </p>
          </SettingsField>
        )}
        {plan && (
          <SettingsField
            label="Monthly user charge at this count"
            width={550}
            hint="The current active count at renewal sets the next month’s charge. Adding or deactivating users during the month does not create prorated charges or credits. Taxes and extra usage are separate."
          >
            <p data-billing-estimate className="text-base">
              {billingMoney(billing.next_seat_amount_cents, plan.currency)} for {billing.next_seats}{' '}
              users
              {billing.next_seats > billing.billable_users ? ' (plan minimum)' : ''}
            </p>
          </SettingsField>
        )}
        {billing.sync_pending && (
          <FieldHint>Your next renewal quantity is being updated.</FieldHint>
        )}
        {billing.sync_error && (
          <p role="status" className="mt-2 text-sm text-text-2">
            Your next renewal quantity has not been confirmed yet. The update will be retried
            automatically.
          </p>
        )}
        <SettingsGroup legend="Billable accounts">
          <details>
            <summary className="cursor-pointer text-sm text-text-1">
              Who counts toward your bill
            </summary>
            <ul className="mt-3 space-y-2">
              {billing.billable_accounts.map((account) => (
                <li
                  key={account.profile_id}
                  data-billable-account={account.profile_id}
                  className="break-words text-sm"
                >
                  {account.name}
                </li>
              ))}
            </ul>
            {billing.billable_accounts.length === 0 && (
              <p className="mt-3 text-sm text-text-2">No billable users.</p>
            )}
          </details>
        </SettingsGroup>
        <SettingsGroup legend="Non-billable accounts">
          <details>
            <summary className="cursor-pointer text-sm text-text-1">
              Who does not count toward your bill
            </summary>
            <ul className="mt-3 space-y-2">
              {billing.non_billable_accounts.map((account) => (
                <li
                  key={account.profile_id}
                  data-non-billable-account={account.profile_id}
                  className="break-words text-sm"
                >
                  {account.name}
                </li>
              ))}
            </ul>
            {billing.non_billable_accounts.length === 0 && (
              <p className="mt-3 text-sm text-text-2">No non-billable users.</p>
            )}
          </details>
        </SettingsGroup>
      </SettingsSection>
    </>
  )
}
