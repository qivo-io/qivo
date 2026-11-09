import { useEffect, useRef, useState } from 'react'
import { PageTitle, SettingsField, SettingsSection } from '@/components/settingsPage'
import { Button } from '@/components/ui/button'
import type { ApiAccessEntry } from '@/lib/apiAccess'
import { billingDate, billingError } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { DEMO_MODE, WORKSPACE_SIGNUP_URL } from '@/lib/demoMode'
import { holdUnsaved } from '@/lib/leaveGuard'
import { useKeptLiveView } from '@/lib/liveView'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../convex/_generated/api'
import type { BillingDetails, BillingUsageFigures } from '../../convex/lib/billingTypes'
import { P } from '../store/planner'
import { BillingOverview } from './BillingOverview'
import { BillingUsage } from './BillingUsage'

/** The organization's Billing page. `setPage` opens another settings page,
 * such as the export before cancelling, and `onViewCredentials` opens API
 * access on one account and period of the usage. In the demo, which bills
 * nothing, it shows a static page that reads nothing. */
export function BillingSettings({
  setPage,
  onViewCredentials,
}: {
  setPage: (page: string) => void
  onViewCredentials: (entry: ApiAccessEntry) => void
}) {
  if (DEMO_MODE) {
    return (
      <>
        <PageTitle>Billing</PageTitle>
        <SettingsSection title="Demo workspace">
          <SettingsField label="Users">
            <p className="text-sm text-text-2">
              Admins can add users as needed. Monthly subscriptions bill the current active user
              count at renewal.
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
  return (
    <LiveBillingSettings
      key={P.org.id}
      orgId={P.org.id}
      setPage={setPage}
      onViewCredentials={onViewCredentials}
    />
  )
}

/** Billing for one organization outside the demo. */
function LiveBillingSettings({
  orgId,
  setPage,
  onViewCredentials,
}: {
  orgId: string
  setPage: (page: string) => void
  onViewCredentials: (entry: ApiAccessEntry) => void
}) {
  const [usage, setUsage] = useState<BillingUsageFigures | null>(null)
  const [usageError, setUsageError] = useState('')
  const [actionError, setActionError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [measuredAt, setMeasuredAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const actionInFlight = useRef(false)
  useUpdateBlocker(busy)

  // The details stay live while the page shows, so a payment or a renewal
  // shows without a Refresh. They pause while the tab or window is hidden
  // (lib/viewVisibility.ts) and read again on return, showing the details
  // held from before, marked busy, until the new answer arrives, with the
  // actions enabled, since the server and Polar decide them. A return never
  // reads the usage figures, which keep their once-and-on-Refresh rule.
  // They name nobody; the name lists read their own batches only while
  // open (BillingAccountNames).
  const details = useKeptLiveView<BillingDetails>(
    api.billing.details,
    JSON.stringify({ org_id: orgId }),
  )
  const summary = details.value
  const summaryError = details.state === 'failed' ? billingError(details.error) : ''

  // API usage changes with every machine call. Read the figures once on
  // opening and on each Refresh (billing.usageFigures), rather than keeping
  // an expensive reactive subscription to the hot counter table. API calls
  // by account and Storage by project read their own batches the same way
  // (BillingApiAccounts, BillingStorage). A failed read keeps the last
  // figures under its error line.
  useEffect(() => {
    let active = true
    setRefreshing(true)
    setUsageError('')
    convex
      .query(api.billing.usageFigures, { org_id: orgId })
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
    // offline the request would wait without a word
    const paused = P.cannotSaveText()
    if (paused) {
      setActionError(paused)
      return
    }
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

  /** Cancelling stops renewal, and the summary then shows when the
   * subscription ends. Answers the refusal for the dialog to show, or null
   * once Polar accepted the cancellation. */
  async function cancelSubscription(): Promise<string | null> {
    if (actionInFlight.current) return 'Another billing action is still running.'
    const paused = P.cannotSaveText()
    if (paused) return paused
    actionInFlight.current = true
    const release = beginUpdateBlock()
    // closing the page before the answer would leave the cancellation unknown
    const releaseUnsaved = holdUnsaved()
    setBusy(true)
    setActionError('')
    try {
      const { ends_at } = await convex.action(api.billingActions.cancelSubscription, {
        org_id: orgId,
      })
      window.showToast?.(`Subscription cancelled. It ends on ${billingDate(ends_at)}.`)
      return null
    } catch (cause) {
      return billingError(cause)
    } finally {
      actionInFlight.current = false
      setBusy(false)
      releaseUnsaved()
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
            onClick={() => {
              details.retry()
              setRefresh((value) => value + 1)
            }}
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
          orgId={orgId}
          refresh={refresh}
          busy={busy}
          onCheckout={() => void openPayment('checkout')}
          onManage={() => void openPayment('portal')}
          onCancel={cancelSubscription}
          onExport={() => setPage('org-general')}
          refreshing={details.state === 'refreshing'}
        />
      )}
      {summary && (
        <BillingUsage
          usage={usage}
          error={usageError}
          currency={summary.plan?.currency}
          status={summary.status}
          measuredAt={measuredAt}
          orgId={orgId}
          refresh={refresh}
          onViewCredentials={onViewCredentials}
        />
      )}
    </>
  )
}
