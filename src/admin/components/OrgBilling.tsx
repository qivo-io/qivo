import { useCallback, useEffect, useRef, useState } from 'react'
import { FieldHint, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { billingDate, billingError, billingMoney } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../../convex/_generated/api'
import type { BillingPlan, BillingSummary } from '../../../convex/lib/billingTypes'

export function OrgBilling({ orgId }: { orgId: string }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [plans, setPlans] = useState<BillingPlan[]>([])
  const [planId, setPlanId] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const activeWrite = useRef(false)
  useUpdateBlocker(busy || (!!summary && !!planId && planId !== summary.plan?.id))

  const reload = useCallback(async () => {
    const [billing, catalogue] = await Promise.all([
      convex.query(api.adminBilling.orgBilling, { org_id: orgId }),
      convex.query(api.adminBilling.listPlans, {}),
    ])
    setSummary(billing)
    setPlans(catalogue.plans)
    setPlanId(billing.plan?.id ?? '')
  }, [orgId])
  useEffect(() => {
    void reload().catch((cause: unknown) => setError(billingError(cause)))
  }, [reload])

  async function write(work: () => Promise<void>) {
    if (activeWrite.current) return
    activeWrite.current = true
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
      await reload()
    } catch (cause) {
      setError(billingError(cause))
    } finally {
      activeWrite.current = false
      setBusy(false)
      release()
    }
  }

  const canAssign = summary?.can_assign_plan
  const canGrant = summary?.can_grant_complimentary
  return (
    <SettingsSection title="Billing" className="mb-6" data-org-billing="">
      {error && (
        <div className="mb-3">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError('')
              void reload().catch((cause: unknown) => setError(billingError(cause)))
            }}
          >
            Refresh billing
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="mb-3 text-sm text-text-2">
          {message}
        </p>
      )}
      {!summary && !error && (
        <p role="status" className="text-sm text-text-2">
          Loading billing…
        </p>
      )}
      {summary && (
        <>
          <SettingsField label="Assigned plan" width={550}>
            <p className="text-base font-semibold">
              {summary.plan?.name ?? 'No plan assigned'}
              {summary.plan && !summary.plan_assigned ? ' (default; not assigned yet)' : ''}
            </p>
            {summary.plan && (
              <FieldHint>
                {billingMoney(summary.plan.seat_price_cents, summary.plan.currency)} per user per
                month, {summary.plan.minimum_seats}-user minimum.
              </FieldHint>
            )}
          </SettingsField>
          <SettingsField label="Subscription status" width={550}>
            <p className="text-base">
              {summary.status.replaceAll('_', ' ')}
              {!summary.enabled ? ' (billing disabled)' : ''}
            </p>
            <FieldHint>
              {summary.writable ? 'Organization can edit.' : 'Organization is read-only.'}
              {summary.cancel_at_period_end ? ' Cancels at period end.' : ''}
            </FieldHint>
          </SettingsField>
          <SettingsField label="Current count" width={550}>
            <p className="text-base">
              {summary.billable_users} billable users · {summary.next_seats} users on the next
              invoice
            </p>
            {summary.plan && (
              <FieldHint>
                Monthly user charge at this count:{' '}
                {billingMoney(summary.next_seat_amount_cents, summary.plan.currency)} before tax and
                extra usage.
              </FieldHint>
            )}
          </SettingsField>
          {summary.current_period_end && (
            <SettingsField label="Current period ends">
              <p className="text-base">{billingDate(summary.current_period_end)}</p>
            </SettingsField>
          )}
          {summary.complimentary_until && (
            <SettingsField label="Free access ends">
              <p className="text-base">{billingDate(summary.complimentary_until)}</p>
            </SettingsField>
          )}
          {summary.sync_pending && (
            <p className="mb-4 text-sm text-text-2">Seat quantity synchronization is pending.</p>
          )}
          {summary.sync_error && (
            <p role="alert" className="mb-4 text-sm text-danger">
              Latest payment synchronization error: {summary.sync_error}
            </p>
          )}
          <SettingsGroup
            legend="Plan assignment"
            description="Assign a plan before the organization starts checkout. Existing subscriptions keep their terms."
          >
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                aria-label="Organization billing plan"
                value={planId}
                disabled={busy || !canAssign}
                onChange={(event) => setPlanId(event.target.value)}
                className="min-w-0 max-w-full flex-1 bg-surface-1"
              >
                <option value="">Choose a plan</option>
                {plans
                  .filter((plan) => !plan.archived || plan.id === summary.plan?.id)
                  .map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
              </NativeSelect>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    disabled={
                      busy ||
                      !canAssign ||
                      !planId ||
                      (summary.plan_assigned && planId === summary.plan?.id)
                    }
                  >
                    Assign plan
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Assign this billing plan?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This sets the terms used when the organization subscribes. Existing
                      subscriptions keep their current terms.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        void write(async () => {
                          await convex.mutation(api.adminBilling.assignPlan, {
                            org_id: orgId,
                            plan_id: planId,
                          })
                          setMessage(
                            'Plan assigned. It will be preserved when this organization subscribes.',
                          )
                        })
                      }
                    >
                      Assign plan
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </SettingsGroup>
          <SettingsGroup
            legend="Complimentary access"
            description="Grant six calendar months without a card. User charges and extra usage are waived during the grant. Admins receive automatic reminders and can subscribe themselves."
          >
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" data-grant-complimentary disabled={busy || !canGrant}>
                  {busy ? 'Saving…' : 'Grant six months free'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Grant six months of complimentary access?</AlertDialogTitle>
                  <AlertDialogDescription>
                    User charges and extra usage are waived until the grant ends. The assigned plan
                    remains unchanged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      void write(async () => {
                        await convex.mutation(api.adminBilling.grantComplimentary, {
                          org_id: orgId,
                          months: 6,
                        })
                        setMessage(
                          'Six months of complimentary access granted. The assigned plan is unchanged.',
                        )
                      })
                    }
                  >
                    Grant access
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {!summary.plan && <FieldHint>Assign a plan before granting free access.</FieldHint>}
            {summary.portal_available && (
              <FieldHint>
                Complimentary grants are available before a subscription is created.
              </FieldHint>
            )}
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  )
}
