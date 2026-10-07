import { useEffect, useRef, useState } from 'react'
import { PageTitle, SettingsField, SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import { billingError } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { DEMO_MODE, WORKSPACE_SIGNUP_URL } from '@/lib/demoMode'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../convex/_generated/api'
import type {
  BillingSummary,
  BillingUsage as BillingUsageData,
} from '../../convex/lib/billingTypes'
import { P } from '../store/planner'
import { BillingOverview } from './BillingOverview'
import { BillingUsage } from './BillingUsage'

export function BillingSettings() {
  if (DEMO_MODE) {
    return (
      <>
        <PageTitle>Billing</PageTitle>
        <SettingsSection title="Demo workspace">
          <SettingsField
            label="Users"
            hint="Admins can add users as needed. Monthly subscriptions bill the current active user count at renewal."
          >
            <p data-seat-count className="text-base">
              {P.homeActiveUsers().length} active users
            </p>
          </SettingsField>
          <SettingsField label="Subscription">
            <p className="text-sm text-text-2">
              Billing is not enabled in this demo.{' '}
              <a href={WORKSPACE_SIGNUP_URL} className="underline underline-offset-4">
                Create a workspace
              </a>{' '}
              to start your own organization.
            </p>
          </SettingsField>
        </SettingsSection>
      </>
    )
  }
  return <LiveBillingSettings key={P.org.id} orgId={P.org.id} />
}

function LiveBillingSettings({ orgId }: { orgId: string }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  const [usage, setUsage] = useState<BillingUsageData | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [usageError, setUsageError] = useState('')
  const [actionError, setActionError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [measuredAt, setMeasuredAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const actionInFlight = useRef(false)
  useUpdateBlocker(busy)

  useEffect(() => {
    let active = true
    setSummaryError('')
    const unsubscribe = convex.onUpdate(
      api.billing.summary,
      { org_id: orgId },
      (result) => {
        if (active) {
          setSummary(result)
          setSummaryError('')
        }
      },
      (cause) => {
        if (active) setSummaryError(billingError(cause))
      },
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [orgId, refresh])

  // API usage changes with every machine call. Read it on demand, rather than
  // keeping an expensive reactive subscription to the hot counter table.
  useEffect(() => {
    let active = true
    setRefreshing(true)
    setUsageError('')
    convex
      .query(api.billing.usage, { org_id: orgId })
      .then((result) => {
        if (active) {
          setUsage(result)
          setMeasuredAt(Date.now())
        }
      })
      .catch((cause: unknown) => {
        if (active) setUsageError(billingError(cause))
      })
      .finally(() => {
        if (active) setRefreshing(false)
      })
    return () => {
      active = false
    }
  }, [orgId, refresh])

  async function openPayment(kind: 'checkout' | 'portal') {
    if (actionInFlight.current) return
    actionInFlight.current = true
    const release = beginUpdateBlock()
    setBusy(true)
    setActionError('')
    try {
      const result =
        kind === 'checkout'
          ? await convex.action(api.billingActions.checkout, { org_id: orgId })
          : await convex.action(api.billingActions.portal, { org_id: orgId })
      window.location.assign(result.url)
    } catch (cause) {
      setActionError(billingError(cause))
    } finally {
      actionInFlight.current = false
      setBusy(false)
      release()
    }
  }

  return (
    <>
      <PageTitle
        sub="Your organization’s subscription and shared usage."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={refreshing || busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        Billing
      </PageTitle>
      {(summaryError || actionError) && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {summaryError || actionError}
        </p>
      )}
      {new URLSearchParams(window.location.search).get('checkout') === 'complete' &&
        summary?.status === 'pending' && (
          <p role="status" className="mb-4 text-sm text-text-2">
            Waiting for payment confirmation. Your subscription will activate automatically.
          </p>
        )}
      {!summary && !summaryError && (
        <p role="status" className="text-sm text-text-2">
          Loading billing…
        </p>
      )}
      {summary && (
        <BillingOverview
          billing={summary}
          busy={busy}
          onCheckout={() => void openPayment('checkout')}
          onManage={() => void openPayment('portal')}
        />
      )}
      {usageError && (
        <p role="alert" className="mb-4 text-sm text-danger">
          Usage could not be refreshed: {usageError}
        </p>
      )}
      {usage && summary?.plan && (
        <BillingUsage usage={usage} currency={summary.plan.currency} measuredAt={measuredAt} />
      )}
    </>
  )
}
