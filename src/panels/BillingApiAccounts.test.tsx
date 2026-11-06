// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ApiAccountRow, ApiAccounts } from '../../convex/lib/billingTypes'
import { LIMITS } from '../../convex/lib/limits'
import type { ApiAccessEntry } from '../lib/apiAccess'
import { ACCOUNT_LIST } from '../lib/billingDisplay'
import { limitSentence } from '../lib/fieldLimits'
import { BillingApiAccounts } from './BillingApiAccounts'

/* Billing's API calls by account on its one-shot reads
   (billing.apiAccounts), each answered by hand: the first batch for the
   figures' bucket, Load more, the search, the notes of a stopped, failed,
   counting or full list, Refresh, and View credentials with the list's
   bucket. */

const network = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))

type Pending = {
  args: Record<string, unknown>
  resolve: (value: ApiAccounts) => void
  reject: (e: unknown) => void
}

const PERIOD = 'month:2026-10'
let reads: Pending[]
let container: HTMLDivElement
let root: Root
let setRefresh: (n: number) => void
let view: ReturnType<typeof vi.fn<(entry: ApiAccessEntry) => void>>
const DEFAULT_MOST = ACCOUNT_LIST.most

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reads = []
  view = vi.fn<(entry: ApiAccessEntry) => void>()
  network.query.mockReset()
  network.query.mockImplementation((ref: unknown, args: Record<string, unknown>) => {
    expect(getFunctionName(ref as never)).toBe('billing:apiAccounts')
    return new Promise<ApiAccounts>((resolve, reject) => reads.push({ args, resolve, reject }))
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  ACCOUNT_LIST.most = DEFAULT_MOST
  vi.unstubAllGlobals()
})

/** Account a<n>, most calls first by n. */
const row = (n: number, extra: Partial<ApiAccountRow> = {}): ApiAccountRow => ({
  profile_id: `a${n}`,
  name: `Account ${n}`,
  removed: false,
  calls: 10_000 - n,
  ...extra,
})
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i))
const ready = (list: ApiAccountRow[], next: string | null = null, stopped = false) =>
  ({ state: 'ready', rows: list, next, stopped }) as const

/** The page around the list, with its Refresh count. */
function Billing() {
  const [refresh, set] = useState(0)
  useLayoutEffect(() => {
    setRefresh = set
  }, [])
  return (
    <TooltipProvider>
      <BillingApiAccounts
        orgId="org-1"
        period={PERIOD}
        refresh={refresh}
        onViewCredentials={view}
      />
    </TooltipProvider>
  )
}

const open = () => act(async () => root.render(<Billing />))
const answer = (value: ApiAccounts, i = reads.length - 1) =>
  act(async () => reads[i].resolve(value))
const fail = (i = reads.length - 1) => act(async () => reads[i].reject(new Error('offline')))
const shown = () =>
  [...container.querySelectorAll<HTMLElement>('[data-billing-account]')].map(
    (li) => li.dataset.billingAccount,
  )
const note = () =>
  container.querySelector('[data-billing-accounts-note]')?.textContent?.replace('Retry', '').trim()
const more = () => container.querySelector<HTMLButtonElement>('[data-billing-accounts-more]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-billing-accounts-retry]')
const searchBox = () =>
  container.querySelector<HTMLInputElement>('[data-billing-accounts-search]') as HTMLInputElement
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(searchBox(), value)
    searchBox().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/* Lets typing rest past the search delay. */
const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)))
const click = (el: HTMLElement | null) => act(async () => el?.click())

describe('API calls by account', () => {
  it("reads the figures' bucket on opening, and Load more appends the next without a row twice", async () => {
    await open()
    expect(reads.map((r) => r.args)).toEqual([{ org_id: 'org-1', period: PERIOD }])
    expect(note()).toBe('Loading API calls by account…')
    await answer(ready(rows(0, 25), 'c1'))
    expect(shown()).toEqual(rows(0, 25).map((r) => r.profile_id))
    expect(more()?.textContent).toBe('Load more')
    expect(container.textContent).toContain(
      'Most calls first. Each account’s total covers all of its credentials.',
    )

    await click(more())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD, cursor: 'c1' })
    expect(more()?.textContent).toBe('Loading…')
    // a second press while it reads sends nothing
    await click(more())
    expect(reads).toHaveLength(2)
    // a24 came back after a re-rank; the list shows it once
    await answer(ready([row(24), ...rows(25, 10)], null))
    expect(shown()).toHaveLength(35)
    expect(new Set(shown()).size).toBe(35)
    expect(more()).toBeNull()
    expect(note()).toBeUndefined()
  })

  it('shows each account’s total with View credentials, which hands over the list’s bucket, and a Removed user', async () => {
    await open()
    await answer(
      ready([
        row(1, { name: 'Nora Lind', calls: 30 }),
        row(2, { profile_id: 'gone', name: 'Removed user', removed: true, calls: 1 }),
      ]),
    )
    const text = [...container.querySelectorAll('[data-billing-account]')].map(
      (li) => li.textContent,
    )
    expect(text).toEqual([
      'Nora Lind30 callsView credentials',
      'Removed user1 callView credentials',
    ])
    // the credentials are API access's to show, a page at a time
    expect(container.querySelector('[data-billing-account] li')).toBeNull()
    const link = container.querySelector<HTMLButtonElement>(
      '[data-billing-view-credentials="gone"]',
    )
    expect(link?.getAttribute('aria-label')).toBe('View credentials of Removed user')
    await click(link)
    expect(view).toHaveBeenCalledWith({ org_id: 'org-1', profile_id: 'gone', period_key: PERIOD })
  })

  it('starts only this list over for a search, keeps the search on Refresh, and drops an older search’s answer', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await type('zoe')
    await rest()
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD, search: 'zoe' })
    const zoe = reads.length - 1
    // the search changes again before the answer lands; that answer is dropped
    await type('zoe relay')
    await rest()
    await answer(ready([row(7, { name: 'Zoë' })]), zoe)
    expect(shown()).toEqual([])
    await answer(ready([row(3, { name: 'Zoë relay' })]))
    expect(shown()).toEqual(['a3'])

    // Refresh reads the first batch again with the search kept
    const before = reads.length
    await act(async () => setRefresh(1))
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD, search: 'zoe relay' })
    expect(searchBox().value).toBe('zoe relay')

    // Escape clears a typed search first, and the full list reads again
    await act(async () =>
      searchBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(searchBox().value).toBe('')
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD })
  })

  it('says a stopped batch goes on, and says no accounts match or no calls only at the real end', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await type('zeph')
    await rest()
    await answer(ready([], 'c2', true))
    expect(note()).toBe(
      'Qivo checked part of the list and found no matches there. Load more continues.Load more',
    )
    expect(container.textContent).not.toContain('No accounts match.')
    await click(more())
    await answer(ready([row(40, { name: 'Zephyr' })], 'c3', true))
    expect(note()).toBe('Qivo checked part of the list. Load more continues.Load more')
    await click(more())
    await answer(ready([], null))
    expect(shown()).toEqual(['a40'])
    expect(note()).toBeUndefined()

    await type('nothing here')
    await rest()
    await answer(ready([], null))
    expect(note()).toBe('No accounts match.')

    // without a search, an empty bucket's real end; a stopped empty batch
    // is no end
    await type('')
    await answer(ready([], 'c9', true))
    expect(container.textContent).not.toContain('No recorded API calls this period.')
    await click(more())
    await answer(ready([], null))
    expect(note()).toBe('No recorded API calls this period.')
  })

  it('keeps its rows after a failed Load more, and Retry reads the same place or the first batch again', async () => {
    await open()
    await fail()
    expect(note()).toBe("Couldn't load API calls by account.")
    await click(retry())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD })
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await fail()
    expect(shown()).toHaveLength(25)
    expect(note()).toBe("Couldn't load more accounts.")
    await click(retry())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', period: PERIOD, cursor: 'c1' })
    await answer(ready(rows(25, 5)))
    expect(shown()).toHaveLength(30)
  })

  it('says the calls are being counted, at first and for a later batch', async () => {
    await open()
    await answer({ state: 'counting' })
    expect(note()).toBe('API calls are being counted. Check again later.')
    expect(shown()).toEqual([])
    await act(async () => setRefresh(1))
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await answer({ state: 'counting' })
    expect(shown()).toHaveLength(25)
    expect(note()).toBe('API calls are being counted again. Refresh to start the list over.')
    expect(retry()).toBeNull()
  })

  it('asks for a search once it holds `most` rows, and sends nothing for a search past the limit', async () => {
    ACCOUNT_LIST.most = 30
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await answer(ready(rows(25, 25), 'c2'))
    expect(shown()).toHaveLength(50)
    expect(more()).toBeNull()
    expect(note()).toBe('Search to find more accounts.')

    const sent = reads.length
    await type('x'.repeat(LIMITS.search.max + 1))
    await rest()
    expect(reads).toHaveLength(sent)
    expect(note()).toBe(limitSentence(LIMITS.search))
  })

  it('moves focus to the first new row once Load more goes', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    act(() => more()?.focus())
    await click(more())
    expect(document.activeElement).toBe(more())
    await answer(ready(rows(25, 5)))
    expect(more()).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[data-billing-account="a25"]'))
  })
})
