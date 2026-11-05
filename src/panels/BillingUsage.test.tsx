// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  BillingSummary,
  BillingUsage as BillingUsageData,
} from '../../convex/lib/billingTypes'
import type { ApiAccessEntry } from '../lib/apiAccess'
import { BillingUsage } from './BillingUsage'

/* Billing's usage: current storage from the totals, the paid period's
   sample beside it, and API calls by account, each account's total with a
   View credentials link and no nested credential rows. Storage by project
   reads its own batches, which answer an empty list here. */

const network = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))

const USAGE: BillingUsageData = {
  period_kind: 'month',
  period_key: 'month:2026-10',
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-10-31T00:00:00.000Z',
  calls: 42,
  included_calls: null,
  storage_bytes: 0,
  sampled_storage_bytes: null,
  included_storage_bytes: null,
  api_overage_cents: 0,
  storage_overage_cents: 0,
  waived: true,
  delivery_unconfirmed: false,
  users: [
    { profile_id: 'nora', name: 'Nora Lind', calls: 30 },
    { profile_id: 'gone', name: 'Removed user', calls: 12 },
  ],
}

/* A paid period of a plan, with its allowance. */
const PAID: BillingUsageData = {
  ...USAGE,
  period_kind: 'paid',
  period_key: '2026-10-01T00:00:00.000Z',
  period_end: '2026-11-01T00:00:00.000Z',
  included_calls: 1000,
  included_storage_bytes: 5_000_000_000,
  waived: false,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  network.query.mockReset()
  network.query.mockResolvedValue({ state: 'ready', rows: [], next: null, stopped: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (
  usage: BillingUsageData,
  o: {
    status?: BillingSummary['status']
    currency?: string
    view?: (entry: ApiAccessEntry) => void
  } = {},
) =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <BillingUsage
          usage={usage}
          currency={o.currency}
          status={o.status ?? 'active'}
          measuredAt={0}
          orgId="org-1"
          refresh={0}
          onViewCredentials={o.view ?? vi.fn()}
        />
      </TooltipProvider>,
    ),
  )
const text = (css: string) => container.querySelector(css)?.textContent ?? null

describe('current storage', () => {
  it('shows the totals with what they count, or says they are being counted, never 0', async () => {
    await render({ ...PAID, storage_bytes: 1_250_000_000 }, { currency: 'usd' })
    expect(text('[data-billing-storage-bytes]')).toBe('1.25 GB of 5.00 GB included')
    expect(container.textContent).toContain(
      'Task attachments and description images, files in Deleted items included until they are deleted for good. Profile pictures and backgrounds are part of the base price.',
    )
    await render({ ...USAGE, storage_bytes: 0 })
    expect(text('[data-billing-storage-bytes]')).toBe('0 B stored')

    await render({ ...USAGE, storage_bytes: null })
    expect(text('[data-billing-storage-bytes]')).toBe('Being counted. Check again later.')
    // the case that must fail: null never reads as an empty organization
    expect(text('[data-billing-storage-bytes]')).not.toContain('0 B')
  })

  it("shows a paid period's sample on its own line, and none for a month, an unconfirmed renewal or a trial", async () => {
    await render({ ...PAID, storage_bytes: 9_000_000, sampled_storage_bytes: 1_200_000_000 })
    expect(text('[data-billing-storage-sample]')).toBe(
      '1.20 GB measured at the start of this period, without files in Deleted items.',
    )
    await render({ ...PAID, sampled_storage_bytes: null })
    expect(text('[data-billing-storage-sample]')).toBe('Not measured yet for this period.')
    await render({ ...PAID, sampled_storage_bytes: null }, { status: 'trialing' })
    expect(text('[data-billing-storage-sample]')).toBeNull()
    for (const period_kind of ['month', 'pending'] as const) {
      await render({ ...USAGE, period_kind, sampled_storage_bytes: 5 })
      expect(text('[data-billing-storage-sample]')).toBeNull()
    }
  })

  it('says usage can change while browsing and that Refresh shows the current lists, and reads Storage by project', async () => {
    await render(USAGE)
    expect(container.querySelector('[data-billing-usage] p')?.textContent).toContain(
      'Usage can change while you browse. Refresh shows the current figures and lists.',
    )
    expect(network.query).toHaveBeenCalledTimes(1)
    expect(network.query.mock.calls[0][1]).toEqual({ org_id: 'org-1' })
    expect(text('[data-billing-storage-note]')).toBe('No stored files.')
  })
})

describe('API calls by account', () => {
  it('shows each account’s total with View credentials and no nested credential rows', async () => {
    const view = vi.fn<(entry: ApiAccessEntry) => void>()
    await render(USAGE, { view })
    const accounts = [...container.querySelectorAll('[data-billing-account]')]
    expect(accounts.map((account) => account.textContent)).toEqual([
      'Nora Lind30 callsView credentials',
      'Removed user12 callsView credentials',
    ])
    expect(container.textContent).toContain('Each account’s total covers all of its credentials.')
    // the credentials are API access's to show, a page at a time
    expect(container.querySelector('[data-billing-account] li')).toBeNull()

    const link = container.querySelector<HTMLButtonElement>(
      '[data-billing-view-credentials="gone"]',
    )
    expect(link?.getAttribute('aria-label')).toBe('View credentials of Removed user')
    await act(async () => link?.click())
    // the organization, account and period of the usage on screen
    expect(view).toHaveBeenCalledWith({
      org_id: 'org-1',
      profile_id: 'gone',
      period_key: 'month:2026-10',
    })
  })
})
