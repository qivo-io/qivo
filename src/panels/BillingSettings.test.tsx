// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingSummary, BillingUsage, StorageProjects } from '../../convex/lib/billingTypes'
import { BillingSettings } from './BillingSettings'

/* The Billing page's reads: the summary stays a live subscription, while
   the usage (billing.currentUsage) and Storage by project
   (billing.storageProjects) are read once on opening and again on each
   Refresh, never subscribed and never through an action. */

const network = vi.hoisted(() => ({ query: vi.fn(), onUpdate: vi.fn(), action: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../store/planner', () => ({
  P: { org: { id: 'org-1' }, cannotSaveText: () => null, homeActiveUsers: () => [] },
}))

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
  cancel_available: false,
  checkout_due_at: null,
  last_export_at: null,
  deletion: null,
  sync_pending: false,
  sync_error: null,
}

const USAGE: BillingUsage = {
  period_kind: 'month',
  period_key: 'month:2026-10',
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-10-31T00:00:00.000Z',
  calls: 3,
  included_calls: null,
  storage_bytes: 2_500_000,
  sampled_storage_bytes: null,
  included_storage_bytes: null,
  api_overage_cents: 0,
  storage_overage_cents: 0,
  waived: true,
  delivery_unconfirmed: false,
  users: [],
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

type Read = { name: string; args: Record<string, unknown> }
let reads: Read[]
/* What the next usage read does: answer the usage, or fail. */
let usageAnswer: () => Promise<BillingUsage>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reads = []
  usageAnswer = async () => USAGE
  for (const fn of Object.values(network)) fn.mockReset()
  network.onUpdate.mockImplementation(
    (ref: unknown, _args: unknown, onResult: (value: BillingSummary) => void) => {
      expect(getFunctionName(ref as never)).toBe('billing:summary')
      queueMicrotask(() => onResult(SUMMARY))
      return () => {}
    },
  )
  network.query.mockImplementation(async (ref: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(ref as never)
    reads.push({ name, args })
    if (name === 'billing:currentUsage') return await usageAnswer()
    if (name === 'billing:storageProjects') return LIST
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

describe('Billing reads its usage once', () => {
  it('reads the usage and Storage by project once on opening and again on each Refresh, never subscribed', async () => {
    await open()
    await settle()
    expect(named('billing:currentUsage')).toEqual([
      { name: 'billing:currentUsage', args: { org_id: 'org-1' } },
    ])
    expect(named('billing:storageProjects')).toEqual([
      { name: 'billing:storageProjects', args: { org_id: 'org-1' } },
    ])
    expect(container.querySelector('[data-billing-storage-bytes]')?.textContent).toBe(
      '2.5 MB stored',
    )
    expect(container.querySelector('[data-billing-storage-row="p1:3"]')).not.toBeNull()
    // the summary is the one subscription, and no action reads usage
    expect(network.onUpdate.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
      'billing:summary',
    ])
    expect(network.action).not.toHaveBeenCalled()

    await refresh()
    expect(named('billing:currentUsage')).toHaveLength(2)
    expect(named('billing:storageProjects')).toHaveLength(2)
    expect(network.action).not.toHaveBeenCalled()
    expect(
      network.onUpdate.mock.calls.every(([ref]) => getFunctionName(ref) === 'billing:summary'),
    ).toBe(true)
  })

  it('keeps the last figures when a Refresh fails, and Refresh starts Storage by project over with its search', async () => {
    await open()
    await settle()
    const box = container.querySelector<HTMLInputElement>('[data-billing-storage-search]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(box, 'firm')
      box?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(named('billing:storageProjects').at(-1)?.args).toEqual({
      org_id: 'org-1',
      search: 'firm',
    })

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
    expect(named('billing:storageProjects').at(-1)?.args).toEqual({
      org_id: 'org-1',
      search: 'firm',
    })
    expect(box?.value).toBe('firm')
  })
})
