// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AccountNameRow, AccountNames, BillingDetails } from '../../convex/lib/billingTypes'
import { NAME_LIST } from '../lib/billingDisplay'
import { BillingOverview } from './BillingOverview'

/* Billing's names-only lists, Who counts toward your bill and Who does not
   count toward your bill, as the Users section mounts them: a closed list
   reads nothing, opening one reads its kind 25 at a time
   (billing.accountList), closing it drops its rows, and Load more, the
   search, the not-ready and end lines and Refresh while open. Each read is
   answered by hand. */

const network = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))

const DETAILS: BillingDetails = {
  enabled: true,
  configured: true,
  plan: null,
  plan_assigned: false,
  can_assign_plan: false,
  can_grant_complimentary: false,
  status: 'active',
  writable: true,
  active_users: 40,
  inactive_users: 3,
  invited_users_with_own_billing: 0,
  billable_users: 37,
  billed_seats: 37,
  next_seats: 37,
  next_seat_amount_cents: 3700,
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

type Pending = {
  args: Record<string, unknown>
  resolve: (value: AccountNames) => void
  reject: (e: unknown) => void
}

let reads: Pending[]
let container: HTMLDivElement
let root: Root
const DEFAULT_MOST = NAME_LIST.most

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reads = []
  network.query.mockReset()
  network.query.mockImplementation((ref: unknown, args: Record<string, unknown>) => {
    expect(getFunctionName(ref as never)).toBe('billing:accountList')
    return new Promise<AccountNames>((resolve, reject) => reads.push({ args, resolve, reject }))
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  NAME_LIST.most = DEFAULT_MOST
  vi.unstubAllGlobals()
})

const render = (refresh = 0) =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <BillingOverview
          billing={DETAILS}
          orgId="org-1"
          refresh={refresh}
          busy={false}
          onCheckout={vi.fn()}
          onManage={vi.fn()}
          onCancel={async () => null}
          onExport={vi.fn()}
        />
      </TooltipProvider>,
    ),
  )
const name = (n: number): AccountNameRow => ({
  profile_id: `p${n}`,
  name: `Person ${String(n).padStart(2, '0')}`,
})
const names = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => name(from + i))
const ready = (list: AccountNameRow[], next: string | null = null, stopped = false) =>
  ({ state: 'ready', rows: list, next, stopped }) as const
const answer = (value: AccountNames, i = reads.length - 1) =>
  act(async () => reads[i].resolve(value))
const fail = (i = reads.length - 1) => act(async () => reads[i].reject(new Error('offline')))
const toggle = (kind: 'billable' | 'non_billable', open: boolean) =>
  act(async () => {
    const details = container.querySelector<HTMLDetailsElement>(
      `[data-billing-names-toggle="${kind}"]`,
    )
    if (details === null) throw new Error(`no ${kind} list`)
    details.open = open
    details.dispatchEvent(new Event('toggle'))
  })
const billable = () =>
  [...container.querySelectorAll<HTMLElement>('[data-billable-account]')].map(
    (li) => li.dataset.billableAccount,
  )
const nonBillable = () =>
  [...container.querySelectorAll<HTMLElement>('[data-non-billable-account]')].map(
    (li) => li.dataset.nonBillableAccount,
  )
const note = (kind: 'billable' | 'non_billable') =>
  container
    .querySelector(`[data-billing-names-list="${kind}"] [data-billing-names-note]`)
    ?.textContent?.replace('Retry', '')
    .trim()
const more = () => container.querySelector<HTMLButtonElement>('[data-billing-names-more]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-billing-names-retry]')
const searchBox = (kind: 'billable' | 'non_billable') =>
  container.querySelector<HTMLInputElement>(
    `[data-billing-names-search="${kind}"]`,
  ) as HTMLInputElement
async function type(kind: 'billable' | 'non_billable', value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(searchBox(kind), value)
    searchBox(kind).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)))
const click = (el: HTMLElement | null) => act(async () => el?.click())

describe("Billing's name lists", () => {
  it('read nothing while closed, read their kind when opened, and drop their rows when closed', async () => {
    await render()
    // the counters show from the details, and no list is read
    expect(container.querySelector('[data-seat-count]')?.textContent).toBe('37 active users')
    expect(reads).toEqual([])
    expect(container.querySelector('[data-billing-names-search]')).toBeNull()

    await toggle('billable', true)
    expect(reads.map((r) => r.args)).toEqual([{ org_id: 'org-1', kind: 'billable' }])
    expect(note('billable')).toBe('Loading…')
    await answer(ready(names(0, 25), 'c1'))
    expect(billable()).toEqual(names(0, 25).map((n) => n.profile_id))
    expect(nonBillable()).toEqual([])
    // names only
    expect(container.querySelector('[data-billable-account="p0"]')?.textContent).toBe('Person 00')

    await click(more())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', kind: 'billable', cursor: 'c1' })
    await answer(ready([name(24), ...names(25, 5)]))
    expect(billable()).toHaveLength(30)
    expect(note('billable')).toBeUndefined()

    // closing drops the rows, and reopening reads the first batch again
    await toggle('billable', false)
    expect(billable()).toEqual([])
    const before = reads.length
    await toggle('billable', true)
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', kind: 'billable' })

    // the other list reads its own kind
    await toggle('non_billable', true)
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', kind: 'non_billable' })
    await answer(ready([name(90)]))
    expect(nonBillable()).toEqual(['p90'])
  })

  it('searches its own list, keeps the search on Refresh while open, and says no accounts match only at the real end', async () => {
    await render()
    await toggle('non_billable', true)
    await answer(ready(names(0, 3)))
    await type('non_billable', 'person 02')
    await rest()
    expect(reads.at(-1)?.args).toEqual({
      org_id: 'org-1',
      kind: 'non_billable',
      search: 'person 02',
    })
    await answer(ready([], 'c2', true))
    expect(note('non_billable')).toBe(
      'Qivo checked part of the list and found no matches there. Load more continues.Load more',
    )
    await click(more())
    await answer(ready([]))
    expect(note('non_billable')).toBe('No accounts match.')

    // Refresh while open reads the first batch again with the search kept
    const before = reads.length
    await render(1)
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.args).toEqual({
      org_id: 'org-1',
      kind: 'non_billable',
      search: 'person 02',
    })
    expect(searchBox('non_billable').value).toBe('person 02')
  })

  it('says an empty list has nobody, a list not ready is being prepared, and a failure offers Retry', async () => {
    await render()
    await toggle('billable', true)
    await answer(ready([]))
    expect(note('billable')).toBe('No billable users.')
    await toggle('non_billable', true)
    await answer(ready([]))
    expect(note('non_billable')).toBe('No non-billable users.')

    await toggle('billable', false)
    await toggle('billable', true)
    await answer({ state: 'not_ready' })
    expect(note('billable')).toBe('This list is being prepared. Check again later.')
    // the case that must fail: not ready is never an empty list
    expect(container.textContent).not.toContain('No billable users.')

    await toggle('billable', false)
    await toggle('billable', true)
    await fail()
    expect(note('billable')).toBe("Couldn't load this list.")
    await click(retry())
    await answer(ready(names(0, 25), 'c1'))
    await click(more())
    await fail()
    expect(billable()).toHaveLength(25)
    expect(note('billable')).toBe("Couldn't load more names.")
  })

  it('asks for a search once it holds `most` names', async () => {
    NAME_LIST.most = 30
    await render()
    await toggle('billable', true)
    await answer(ready(names(0, 25), 'c1'))
    await click(more())
    await answer(ready(names(25, 25), 'c2'))
    expect(billable()).toHaveLength(50)
    expect(more()).toBeNull()
    expect(note('billable')).toBe('Search to find more accounts.')
  })
})
