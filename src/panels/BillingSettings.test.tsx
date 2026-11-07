// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  ApiAccounts,
  BillingDetails,
  BillingUsageFigures,
  StorageProjects,
} from '../../convex/lib/billingTypes'
import { BillingSettings } from './BillingSettings'

/* The Billing page's reads. The details stay the one live subscription,
   while the usage figures (billing.usageFigures), API calls by account
   (billing.apiAccounts) and Storage by project (billing.storageProjects)
   are read once on opening and again on each Refresh, never subscribed
   and never through an action. Neither billing.summary nor
   billing.currentUsage, which the release after v0.1.150 removed, is
   read. The demo's static page reads nothing. */

const network = vi.hoisted(() => ({ query: vi.fn(), onUpdate: vi.fn(), action: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
const demo = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/demoMode', () => ({
  get DEMO_MODE() {
    return demo.on
  },
  WORKSPACE_SIGNUP_URL: 'https://qivo.io/signup',
}))
// the planner holds no roster here: the page must not need one
vi.mock('../store/planner', () => ({
  P: { org: { id: 'org-1' }, cannotSaveText: () => null },
}))

const DETAILS: BillingDetails = {
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
  billed_seats: 7,
  next_seats: 7,
  next_seat_amount_cents: 7000,
  current_period_start: '2026-10-01T00:00:00.000Z',
  current_period_end: '2099-11-01T00:00:00.000Z',
  complimentary_until: null,
  cancel_at_period_end: false,
  checkout_available: false,
  portal_available: false,
  cancel_available: false,
  checkout_due_at: null,
  last_export_at: null,
  deletion: null,
  sync_pending: false,
  sync_error: null,
}

const USAGE: BillingUsageFigures = {
  period_kind: 'month',
  period_key: 'month:2026-10',
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-10-31T00:00:00.000Z',
  calls: 3,
  included_calls: null,
  storage_bytes: 2_500_000,
  storage_basis: null,
  sampled_storage_bytes: null,
  sampled_storage_at: null,
  storage_average: null,
  included_storage_bytes: null,
  api_overage_cents: 0,
  storage_overage_cents: 0,
  waived: true,
  delivery_unconfirmed: false,
}

const LIST: StorageProjects = {
  state: 'ready',
  rows: [
    {
      project_id: 'p1',
      num: 3,
      key: 'FW',
      name: 'Firmware',
      status: 'active',
      bytes: 2_500_000,
      files: 4,
    },
  ],
  next: null,
  stopped: false,
}

const ACCOUNTS: ApiAccounts = {
  state: 'ready',
  rows: [{ profile_id: 'nora', name: 'Nora Lind', removed: false, calls: 3 }],
  next: null,
  stopped: false,
}

type Read = { name: string; args: Record<string, unknown> }
let reads: Read[]
/* What the next usage read does: answer the figures, or fail. */
let usageAnswer: () => Promise<BillingUsageFigures>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  demo.on = false
  reads = []
  usageAnswer = async () => USAGE
  for (const fn of Object.values(network)) fn.mockReset()
  network.onUpdate.mockImplementation(
    (ref: unknown, _args: unknown, onResult: (value: BillingDetails) => void) => {
      expect(getFunctionName(ref as never)).toBe('billing:details')
      queueMicrotask(() => onResult(DETAILS))
      return () => {}
    },
  )
  network.query.mockImplementation(async (ref: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(ref as never)
    reads.push({ name, args })
    if (name === 'billing:usageFigures') return await usageAnswer()
    if (name === 'billing:storageProjects') return LIST
    if (name === 'billing:apiAccounts') return ACCOUNTS
    throw new Error(`unexpected read ${name}`)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const open = () =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <BillingSettings setPage={vi.fn()} onViewCredentials={vi.fn()} />
      </TooltipProvider>,
    ),
  )
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))
const refresh = async () => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')
  await act(async () => button?.click())
  await settle()
}
const named = (name: string) => reads.filter((r) => r.name === name)
const type = async (css: string, value: string) => {
  const box = container.querySelector<HTMLInputElement>(css)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(box, value)
    box?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
}

describe('Billing reads its usage once', () => {
  it('reads the figures and both usage lists once on opening and again on each Refresh, never subscribed', async () => {
    await open()
    await settle()
    expect(named('billing:usageFigures')).toEqual([
      { name: 'billing:usageFigures', args: { org_id: 'org-1' } },
    ])
    // API calls by account asks for the bucket the figures answered
    expect(named('billing:apiAccounts')).toEqual([
      { name: 'billing:apiAccounts', args: { org_id: 'org-1', period: 'month:2026-10' } },
    ])
    expect(named('billing:storageProjects')).toEqual([
      { name: 'billing:storageProjects', args: { org_id: 'org-1' } },
    ])
    expect(container.querySelector('[data-billing-storage-bytes]')?.textContent).toBe(
      '2.5 MB stored',
    )
    expect(container.querySelector('[data-billing-account="nora"]')).not.toBeNull()
    expect(container.querySelector('[data-billing-storage-row="p1:3"]')).not.toBeNull()
    // the details are the one subscription, and no action reads usage
    expect(network.onUpdate.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
      'billing:details',
    ])
    expect(network.action).not.toHaveBeenCalled()
    // the closed name lists read nothing
    expect(named('billing:accountList')).toEqual([])

    await refresh()
    expect(named('billing:usageFigures')).toHaveLength(2)
    expect(named('billing:apiAccounts')).toHaveLength(2)
    expect(named('billing:storageProjects')).toHaveLength(2)
    expect(network.action).not.toHaveBeenCalled()
    expect(
      network.onUpdate.mock.calls.every(([ref]) => getFunctionName(ref) === 'billing:details'),
    ).toBe(true)
    // nor the reads the release after v0.1.150 removed
    expect(reads.map((r) => r.name)).not.toContain('billing:summary')
    expect(reads.map((r) => r.name)).not.toContain('billing:currentUsage')
  })

  it('keeps the last figures when a Refresh fails, and each search reads only its own list', async () => {
    await open()
    await settle()
    await type('[data-billing-storage-search]', 'firm')
    expect(named('billing:storageProjects').at(-1)?.args).toEqual({
      org_id: 'org-1',
      search: 'firm',
    })
    await type('[data-billing-accounts-search]', 'nora')
    expect(named('billing:apiAccounts').at(-1)?.args).toEqual({
      org_id: 'org-1',
      period: 'month:2026-10',
      search: 'nora',
    })
    // each search started only its own list over, never the figures
    expect(named('billing:usageFigures')).toHaveLength(1)
    expect(named('billing:storageProjects')).toHaveLength(2)
    expect(named('billing:apiAccounts')).toHaveLength(2)

    usageAnswer = async () => {
      throw new Error('Network down')
    }
    await refresh()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Usage could not be refreshed: Network down',
    )
    expect(container.querySelector('[data-billing-storage-bytes]')?.textContent).toBe(
      '2.5 MB stored',
    )
    // Refresh read both lists once more, each with its search kept
    expect(named('billing:storageProjects').at(-1)?.args).toEqual({
      org_id: 'org-1',
      search: 'firm',
    })
    expect(named('billing:apiAccounts').at(-1)?.args).toEqual({
      org_id: 'org-1',
      period: 'month:2026-10',
      search: 'nora',
    })
  })

  it('lists Storage by project while the first usage read fails, without a figure', async () => {
    usageAnswer = async () => {
      throw new Error('Network down')
    }
    await open()
    await settle()
    expect(container.querySelector('[data-billing-usage-error]')?.textContent).toBe(
      'Usage could not be refreshed: Network down',
    )
    expect(container.querySelector('[data-billing-storage-bytes]')).toBeNull()
    expect(named('billing:storageProjects')).toHaveLength(1)
    expect(container.querySelector('[data-billing-storage-row="p1:3"]')).not.toBeNull()
    // API calls by account waits for the bucket the figures name
    expect(named('billing:apiAccounts')).toEqual([])
  })
})

describe("the demo's Billing page", () => {
  it('shows its sentences without a count and reads nothing', async () => {
    demo.on = true
    await open()
    await settle()
    expect(container.textContent).toContain(
      'Admins can add users as needed. Monthly subscriptions bill the current active user count at renewal.',
    )
    expect(container.textContent).toContain('Billing is not enabled in this demo.')
    // the case that must fail: no count from the roster, which the store
    // mock does not hold
    expect(container.querySelector('[data-seat-count]')).toBeNull()
    expect(container.textContent).not.toMatch(/\d+ active users?/)
    expect(network.query).not.toHaveBeenCalled()
    expect(network.onUpdate).not.toHaveBeenCalled()
  })
})
