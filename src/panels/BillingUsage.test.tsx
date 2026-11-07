// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BillingDetails, BillingUsageFigures } from '../../convex/lib/billingTypes'
import type { ApiAccessEntry } from '../lib/apiAccess'
import { billingDate } from '../lib/billingDisplay'
import { BillingUsage } from './BillingUsage'

/* Billing's usage figures: API calls from the bucket's aggregates, or being
   counted, current storage from the totals, the paid period's sample
   beside it, the section before its figures answered and after a failed
   read, and the two lists, API calls by account for the figures' bucket
   and Storage by project, which read their own batches and answer empty
   lists here. */

const network = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))

const USAGE: BillingUsageFigures = {
  period_kind: 'month',
  period_key: 'month:2026-10',
  period_start: '2026-10-01T00:00:00.000Z',
  period_end: '2026-10-31T00:00:00.000Z',
  calls: 42,
  included_calls: null,
  storage_bytes: 0,
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

/* A paid period of a plan, with its allowance, sampled at its start. */
const PAID: BillingUsageFigures = {
  ...USAGE,
  period_kind: 'paid',
  period_key: '2026-10-01T00:00:00.000Z',
  period_end: '2026-11-01T00:00:00.000Z',
  included_calls: 1000,
  included_storage_bytes: 5_000_000_000,
  waived: false,
  storage_basis: 'start',
}

/* PAID charged on its daily average instead, open with 19 of its 31 days
   averaged so far, 2 of them estimated. */
const DAILY: BillingUsageFigures = {
  ...PAID,
  storage_basis: 'daily',
  storage_average: {
    bytes: 6_400_000_000,
    days: 31,
    measured: 17,
    estimated: 2,
    estimated_earlier: 0,
    final: false,
  },
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
  usage: BillingUsageFigures | null,
  o: {
    status?: BillingDetails['status']
    currency?: string
    error?: string
    view?: (entry: ApiAccessEntry) => void
  } = {},
) =>
  act(async () =>
    root.render(
      <TooltipProvider>
        <BillingUsage
          usage={usage}
          error={o.error ?? ''}
          currency={o.currency}
          status={o.status ?? 'active'}
          measuredAt={Date.parse('2026-10-20T08:00:00.000Z')}
          orgId="org-1"
          refresh={0}
          onViewCredentials={o.view ?? vi.fn()}
        />
      </TooltipProvider>,
    ),
  )
const text = (css: string) => container.querySelector(css)?.textContent ?? null
const named = (name: string) =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === name).map(([, a]) => a)

describe('API calls', () => {
  it('shows the calls with the included calls, or says they are being counted, never 0', async () => {
    await render(PAID, { currency: 'usd' })
    expect(text('[data-billing-calls]')).toBe('42 of 1,000 included calls')
    await render(USAGE)
    expect(text('[data-billing-calls]')).toBe('42 calls')
    await render({ ...PAID, calls: null }, { currency: 'usd' })
    expect(text('[data-billing-calls]')).toBe('Being counted. Check again later.')
    // the case that must fail: null never reads as no calls, and names no
    // allowance it cannot compare
    expect(text('[data-billing-calls]')).not.toMatch(/^0|included/)
  })
})

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
    await render({
      ...PAID,
      storage_bytes: 9_000_000,
      sampled_storage_bytes: 1_200_000_000,
      sampled_storage_at: '2026-10-01T00:00:01.000Z',
    })
    expect(text('[data-billing-storage-sample]')).toBe(
      '1.20 GB measured at the start of this period.',
    )
    expect(text('[data-billing-storage-sample]')).not.toContain('without files in Deleted items')
    // a sample that waited past the period's first day names its date
    await render({
      ...PAID,
      sampled_storage_bytes: 1_200_000_000,
      sampled_storage_at: '2026-10-03T12:00:00.000Z',
    })
    expect(text('[data-billing-storage-sample]')).toBe(
      `1.20 GB measured on ${billingDate('2026-10-03T12:00:00.000Z')}.`,
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

  it("shows a daily period's average in the sample line's place, and a period sampled at its start no average", async () => {
    await render({ ...DAILY, storage_bytes: 7_000_000_000 }, { currency: 'usd' })
    expect(text('[data-billing-storage-average]')).toBe(
      '6.40 GB average so far, from 19 of this period’s 31 days. 2 of them estimated from the next measured day.',
    )
    expect(text('[data-billing-storage-sample]')).toBeNull()
    expect(container.textContent).toContain(
      'Storage is charged on the average of this period’s daily measurements, which is recorded shortly before the period ends.',
    )
    // recorded, and recorded without any measurement
    const recorded = { ...DAILY.storage_average!, final: true, measured: 31, estimated: 0 }
    await render(
      { ...DAILY, storage_overage_cents: 200, storage_average: recorded },
      { currency: 'usd' },
    )
    expect(text('[data-billing-storage-average]')).toBe(
      '6.40 GB average over this period’s 31 days.',
    )
    expect(container.textContent).toContain(
      'Extra storage charge recorded this period: $2.00, based on this period’s average storage.',
    )
    await render(
      { ...DAILY, storage_average: { ...recorded, bytes: null, measured: 0 } },
      { currency: 'usd' },
    )
    expect(text('[data-billing-storage-average]')).toBe(
      'No storage measurement was available for this period.',
    )
    expect(container.textContent).toContain(
      'No storage charge for this period, since no storage measurement was available.',
    )
    // a period sampled at its start shows its sample and none of the daily
    // text, the case that fails if the daily text shows for it
    await render({ ...PAID, sampled_storage_bytes: 1_200_000_000 }, { currency: 'usd' })
    expect(text('[data-billing-storage-sample]')).toBe(
      '1.20 GB measured at the start of this period.',
    )
    expect(container.querySelector('[data-billing-storage-average]')).toBeNull()
    expect(container.textContent).not.toMatch(/average|daily/)
    // nor for a trial
    await render(DAILY, { status: 'trialing' })
    expect(container.querySelector('[data-billing-storage-average]')).toBeNull()
  })
})

describe('the Usage section', () => {
  it("says usage can change while browsing, and reads API calls by account for the figures' bucket and Storage by project", async () => {
    await render(USAGE)
    expect(text('[data-billing-usage] p')).toMatch(
      /^Measured .+\. Usage can change while you browse\. Refresh shows the current figures and lists\.$/,
    )
    expect(named('billing:apiAccounts')).toEqual([{ org_id: 'org-1', period: 'month:2026-10' }])
    expect(named('billing:storageProjects')).toEqual([{ org_id: 'org-1' }])
    expect(network.query).toHaveBeenCalledTimes(2)
    expect(text('[data-billing-accounts-note]')).toBe('No recorded API calls this period.')
    expect(text('[data-billing-storage-note]')).toBe('No stored files.')
    // the account rows are BillingApiAccounts', a batch at a time
    expect(container.querySelector('[data-billing-accounts]')).not.toBeNull()
  })

  it('shows Loading usage or the error in place of the figures before they answered, with Storage by project and without the measurement line', async () => {
    await render(null)
    expect(text('[data-billing-usage-loading]')).toBe('Loading usage…')
    expect(text('[data-billing-usage] p')).toBe(
      'Usage can change while you browse. Refresh shows the current figures and lists.',
    )
    // no figure, so nothing a check could read as one
    expect(container.querySelector('[data-billing-storage-bytes]')).toBeNull()
    expect(container.querySelector('[data-billing-calls]')).toBeNull()
    // Storage by project reads at once; API calls by account waits for the bucket
    expect(named('billing:storageProjects')).toHaveLength(1)
    expect(named('billing:apiAccounts')).toHaveLength(0)

    await render(null, { error: 'Network down' })
    expect(text('[data-billing-usage-error]')).toBe('Usage could not be refreshed: Network down')
    expect(container.querySelector('[data-billing-usage-loading]')).toBeNull()
    expect(container.querySelector('[data-billing-storage-bytes]')).toBeNull()

    // a failed Refresh keeps the last figures under the error line
    await render(USAGE, { error: 'Network down' })
    expect(text('[data-billing-usage-error]')).toBe('Usage could not be refreshed: Network down')
    expect(text('[data-billing-calls]')).toBe('42 calls')
  })
})
