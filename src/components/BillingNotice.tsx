import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { billingDate } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { DEMO_MODE } from '@/lib/demoMode'
import { api } from '../../convex/_generated/api'

type BillingStatus = {
  enabled: boolean
  writable: boolean
  status: string
  complimentary_until: string | null
  current_period_end: string | null
}

export function BillingNotice({
  orgId,
  orgName,
  admin,
  onBilling,
}: {
  orgId: string
  orgName: string
  admin: boolean
  onBilling: () => void
}) {
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (DEMO_MODE || !orgId) return
    return convex.onUpdate(api.billing.status, { org_id: orgId }, setStatus, () => setStatus(null))
  }, [orgId, refresh])

  // Entitlement expiry is a date, so it need not produce a changed database
  // row. Refresh at that date even if this browser has been left open.
  useEffect(() => {
    if (!status?.complimentary_until || !status.writable) return
    const remaining = new Date(status.complimentary_until).getTime() - Date.now()
    if (remaining <= 0) return
    const nextChange = remaining > 14 * 86_400_000 ? remaining - 14 * 86_400_000 : remaining
    const timer = window.setTimeout(
      () => setRefresh((value) => value + 1),
      Math.min(nextChange + 1000, 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [status?.complimentary_until, status?.writable, refresh])

  if (!status?.enabled) return null
  const daysLeft = status.complimentary_until
    ? (new Date(status.complimentary_until).getTime() - Date.now()) / 86_400_000
    : null
  const freeEnding = daysLeft !== null && daysLeft > 0 && daysLeft <= 14
  const freeExpired = daysLeft !== null && daysLeft <= 0 && status.status === 'pending'
  if (status.writable && !freeExpired && status.status !== 'past_due' && !freeEnding) return null
  return (
    <div
      role="status"
      data-billing-notice
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-4 py-3"
    >
      <p className="min-w-0 text-sm text-text-1">
        {freeEnding
          ? `Free access for ${orgName} ends ${billingDate(status.complimentary_until)}. Subscribe when it ends to continue editing.`
          : status.status === 'past_due'
            ? `Payment for ${orgName} needs attention. Update the payment method in Billing.`
            : `Editing in ${orgName} is paused until a subscription is active. Existing work remains available.`}
        {!admin && ' Contact an organization admin.'}
      </p>
      {admin && (
        <Button type="button" size="sm" onClick={onBilling}>
          Open billing
        </Button>
      )}
    </div>
  )
}
