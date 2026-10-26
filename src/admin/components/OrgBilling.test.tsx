// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingPlan, BillingSummary } from '../../../convex/lib/billingTypes'
import { endClosing, playClosingAnimations } from '../../lib/closingAnimation.setup'
import { OrgBilling } from './OrgBilling'

/* Admin › Organization › Billing's Assign plan and Grant six months free
   questions. Each closes as its write starts, and the write disables its
   button. The writes are answered by hand. */

const server = vi.hoisted(() => ({
  assigned: null as string | null,
  until: null as string | null,
  writes: [] as (() => void)[],
}))
const plan = (id: string, name: string): BillingPlan => ({
  id,
  name,
  currency: 'usd',
  seat_price_cents: 1000,
  minimum_seats: 5,
  storage_gb_per_seat: 1,
  minimum_storage_gb: 5,
  api_calls_per_seat: 25000,
  storage_block_price_cents: 100,
  api_block_price_cents: 100,
  api_block_size: 25000,
  created_at: '2026-01-01T00:00:00.000Z',
  archived: false,
})
const PLANS = [plan('team-2025', 'Team 2025'), plan('team-2026', 'Team 2026')]
/** The organization's billing as the server reads it now, on the default
    plan until one is assigned. */
const summary = (): BillingSummary => ({
  enabled: true,
  configured: true,
  plan: PLANS.find((p) => p.id === (server.assigned ?? 'team-2025')) ?? null,
  plan_assigned: !!server.assigned,
  can_assign_plan: true,
  can_grant_complimentary: true,
  status: server.until ? 'complimentary' : 'pending',
  writable: true,
  active_users: 7,
  inactive_users: 0,
  invited_users_with_own_billing: 0,
  billable_users: 7,
  billable_accounts: [],
  non_billable_accounts: [],
  billed_seats: 0,
  next_seats: 7,
  next_seat_amount_cents: 7000,
  current_period_start: null,
  current_period_end: null,
  complimentary_until: server.until,
  cancel_at_period_end: false,
  checkout_available: true,
  portal_available: false,
  cancel_available: false,
  checkout_due_at: null,
  last_export_at: null,
  deletion: null,
  sync_pending: false,
  sync_error: null,
})
vi.mock('@/lib/convex', () => ({
  convex: {
    query: async (ref: Parameters<typeof getFunctionName>[0]) =>
      getFunctionName(ref) === 'adminBilling:listPlans'
        ? { plans: PLANS, default_plan_id: 'team-2025' }
        : summary(),
  },
}))
vi.mock('../convex', () => ({
  sendMutation: (ref: Parameters<typeof getFunctionName>[0], args: { plan_id?: string }) =>
    new Promise((resolve) =>
      server.writes.push(() => {
        if (getFunctionName(ref) === 'adminBilling:assignPlan') {
          server.assigned = args.plan_id ?? null
        } else {
          // a grant enrolls the organization on the default plan
          server.assigned ??= 'team-2025'
          server.until = '2027-04-26T00:00:00.000Z'
        }
        resolve(null)
      }),
    ),
}))

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  playClosingAnimations()
  server.assigned = null
  server.until = null
  server.writes.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <OrgBilling orgId="org-1" />
      </TooltipProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function button(name: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}
const dialog = () => document.querySelector('[role="alertdialog"]')
const grant = () => document.querySelector<HTMLButtonElement>('[data-grant-complimentary]')
/** Opens the question from `trigger` with the keyboard, which gives it focus
    first, and answers it with `action`. */
async function confirm(trigger: HTMLButtonElement, action: string) {
  trigger.focus()
  await act(async () => trigger.click())
  const question = dialog()
  if (!question) throw new Error('missing question')
  await act(async () => button(action, question).click())
  expect(dialog()?.getAttribute('data-state')).toBe('closed')
}
/** Lands the oldest write, which the summary's reload then shows. */
const land = () => act(async () => server.writes.shift()?.())

describe('the billing questions', () => {
  it('gives focus to the assigned plan line once the assignment keeps Assign plan disabled', async () => {
    const assign = button('Assign plan')
    await confirm(assign, 'Assign plan')
    await land()
    expect(assign.disabled).toBe(true)
    await endClosing()
    const line = document.activeElement
    expect(line?.textContent).toBe('Team 2025')
    expect(line?.getAttribute('tabindex')).toBe('-1')
  })

  it('gives focus back to Grant six months free once the grant that disabled it as the question closed has landed', async () => {
    await confirm(button('Grant six months free'), 'Grant access')
    await endClosing()
    expect(grant()?.disabled).toBe(true)
    await land()
    expect(grant()?.disabled).toBe(false)
    expect(document.activeElement).toBe(grant())
  })

  it('gives focus back to Assign plan when its question is cancelled', async () => {
    const assign = button('Assign plan')
    await confirm(assign, 'Cancel')
    await endClosing()
    expect(server.writes).toHaveLength(0)
    expect(document.activeElement).toBe(assign)
  })
})
