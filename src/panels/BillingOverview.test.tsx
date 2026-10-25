// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingSummary } from '../../convex/lib/billingTypes'
import { endClosing, playClosingAnimations } from '../lib/closingAnimation.setup'
import { BillingOverview } from './BillingOverview'

/* Billing's Cancel subscription question as it closes. Keep subscription
   clears a refusal and a finished cancellation clears the page's busy, so
   the closing dialog keeps what it showed open. A summary refresh can take
   the question's button away. Each cancellation is answered by hand. */

const SUMMARY: BillingSummary = {
  enabled: true,
  configured: true,
  plan: null,
  plan_assigned: false,
  can_assign_plan: false,
  can_grant_complimentary: false,
  status: 'active',
  writable: true,
  active_users: 7,
  inactive_users: 0,
  invited_users_with_own_billing: 0,
  billable_users: 7,
  billable_accounts: [],
  non_billable_accounts: [],
  billed_seats: 7,
  next_seats: 7,
  next_seat_amount_cents: 7000,
  current_period_start: '2026-10-01T00:00:00.000Z',
  current_period_end: '2099-11-01T00:00:00.000Z',
  complimentary_until: null,
  cancel_at_period_end: false,
  checkout_available: false,
  portal_available: false,
  cancel_available: true,
  checkout_due_at: null,
  last_export_at: null,
  deletion: null,
  sync_pending: false,
  sync_error: null,
}

let container: HTMLDivElement
let root: Root
let answers: ((refusal: string | null) => void)[]
// a summary refresh, as the page's subscription delivers one
let refresh: (next: BillingSummary) => void
// whether the page's busy=false renders on its own, before the dialog hears
// the answer
let splitRender = false

/** The page around the overview, busy while a cancellation runs, as
    BillingSettings is. */
function Billing() {
  const [busy, setBusy] = useState(false)
  const [billing, setBilling] = useState(SUMMARY)
  useLayoutEffect(() => {
    refresh = setBilling
  }, [])
  return (
    <BillingOverview
      billing={billing}
      busy={busy}
      onCheckout={vi.fn()}
      onManage={vi.fn()}
      onExport={vi.fn()}
      onCancel={async () => {
        setBusy(true)
        try {
          return await new Promise<string | null>((resolve) => answers.push(resolve))
        } finally {
          if (splitRender) flushSync(() => setBusy(false))
          else setBusy(false)
        }
      }}
    />
  )
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  answers = []
  splitRender = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Billing />
      </TooltipProvider>,
    ),
  )
  await act(async () => document.querySelector<HTMLElement>('[data-billing-cancel]')?.click())
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dialog = () => document.querySelector('[role="alertdialog"]')
const confirm = () => document.querySelector<HTMLButtonElement>('[data-billing-cancel-confirm]')
const refusal = () => dialog()?.querySelector('[role="alert"]')?.textContent ?? null

describe('the Cancel subscription question', () => {
  it('keeps its busy button while it closes after the cancellation', async () => {
    await act(async () => confirm()?.click())
    expect(confirm()?.textContent).toBe('Cancelling…')
    await act(async () => answers[0](null))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Cancelling…')
    expect(confirm()?.disabled).toBe(true)
    await endClosing()
    expect(dialog()).toBeNull()
  })

  it("keeps its busy button while it closes when the page's busy clears in a render of its own", async () => {
    splitRender = true
    await act(async () => confirm()?.click())
    await act(async () => answers[0](null))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Cancelling…')
    expect(confirm()?.disabled).toBe(true)
  })

  it('stays while it cancels when a refresh takes its button away, then fades and gives focus to Manage billing', async () => {
    await act(async () => confirm()?.click())
    const cancelled = {
      ...SUMMARY,
      cancel_at_period_end: true,
      cancel_available: false,
      portal_available: true,
    }
    await act(async () => refresh(cancelled))
    expect(document.querySelector('[data-billing-cancel]')).toBeNull()
    expect(dialog()?.getAttribute('data-state')).toBe('open')
    expect(confirm()?.textContent).toBe('Cancelling…')
    await act(async () => answers[0](null))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Cancelling…')
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-billing-portal]'))
  })

  it('closes a question that waits for nothing when a refresh takes its button away', async () => {
    await act(async () => refresh({ ...SUMMARY, cancel_available: false }))
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(confirm()?.textContent).toBe('Cancel subscription')
    await endClosing()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-billing-status]'))
  })

  it('keeps a refusal while it closes, and a press then cancels nothing', async () => {
    await act(async () => confirm()?.click())
    await act(async () => answers[0]('Polar could not stop the renewal. Try again.'))
    expect(refusal()).toBe('Polar could not stop the renewal. Try again.')
    const keep = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Keep subscription',
    )
    await act(async () => keep?.click())
    expect(dialog()?.getAttribute('data-state')).toBe('closed')
    expect(refusal()).toBe('Polar could not stop the renewal. Try again.')
    await act(async () => confirm()?.click())
    expect(answers).toHaveLength(1)
    await endClosing()
    expect(document.activeElement).toBe(document.querySelector('[data-billing-cancel]'))
    // the next question starts without it
    await act(async () => document.querySelector<HTMLElement>('[data-billing-cancel]')?.click())
    expect(refusal()).toBeNull()
  })
})
