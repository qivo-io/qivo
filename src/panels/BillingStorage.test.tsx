// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StorageProjectRow, StorageProjects } from '../../convex/lib/billingTypes'
import { LIMITS } from '../../convex/lib/limits'
import { STORAGE_LIST } from '../lib/billingDisplay'
import { limitSentence } from '../lib/fieldLimits'
import { BillingStorage } from './BillingStorage'

/* Billing's Storage by project on its one-shot reads
   (billing.storageProjects), each answered by hand: the first batch on
   opening, Load more, the search, the notes of a stopped, failed, counting
   or full list, where focus goes across Load more and Retry, Refresh and
   the labels. */

const network = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))

type Pending = {
  args: Record<string, unknown>
  resolve: (value: StorageProjects) => void
  reject: (e: unknown) => void
}

let reads: Pending[]
let container: HTMLDivElement
let root: Root
let setRefresh: (n: number) => void
const DEFAULT_MOST = STORAGE_LIST.most

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reads = []
  network.query.mockReset()
  network.query.mockImplementation((ref: unknown, args: Record<string, unknown>) => {
    expect(getFunctionName(ref as never)).toBe('billing:storageProjects')
    return new Promise<StorageProjects>((resolve, reject) => reads.push({ args, resolve, reject }))
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  STORAGE_LIST.most = DEFAULT_MOST
  vi.unstubAllGlobals()
})

/** A project row: P<n>, largest first by n. */
const row = (n: number, extra: Partial<StorageProjectRow> = {}): StorageProjectRow => ({
  project_id: `p${n}`,
  num: n,
  key: `K${n}`,
  name: `Project ${n}`,
  status: 'active',
  bytes: 10_000 - n,
  files: 1,
  ...extra,
})
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i))
const ready = (list: StorageProjectRow[], next: string | null = null, stopped = false) =>
  ({ state: 'ready', rows: list, next, stopped }) as const

/** The page around the list, with its Refresh count. */
function Billing() {
  const [refresh, set] = useState(0)
  useLayoutEffect(() => {
    setRefresh = set
  }, [])
  return (
    <TooltipProvider>
      <BillingStorage orgId="org-1" refresh={refresh} />
    </TooltipProvider>
  )
}

const open = () => act(async () => root.render(<Billing />))
const answer = (value: StorageProjects, i = reads.length - 1) =>
  act(async () => reads[i].resolve(value))
const fail = (i = reads.length - 1) => act(async () => reads[i].reject(new Error('offline')))
const shown = () =>
  [...container.querySelectorAll<HTMLElement>('[data-billing-storage-row]')].map(
    (li) => li.dataset.billingStorageRow,
  )
const note = () =>
  container.querySelector('[data-billing-storage-note]')?.textContent?.replace('Retry', '').trim()
const more = () => container.querySelector<HTMLButtonElement>('[data-billing-storage-more]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-billing-storage-retry]')
const searchBox = () =>
  container.querySelector<HTMLInputElement>('[data-billing-storage-search]') as HTMLInputElement
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

describe('Storage by project', () => {
  it('reads the first batch on opening, and Load more appends the next without a row twice', async () => {
    await open()
    expect(reads.map((r) => r.args)).toEqual([{ org_id: 'org-1' }])
    expect(note()).toBe('Loading storage by project…')
    await answer(ready(rows(0, 25), 'c1'))
    expect(shown()).toEqual(rows(0, 25).map((r) => `${r.project_id}:${r.num}`))
    expect(more()?.textContent).toBe('Load more')

    await click(more())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', cursor: 'c1' })
    expect(more()?.textContent).toBe('Loading…')
    // a second press while it reads sends nothing
    await click(more())
    expect(reads).toHaveLength(2)
    // P24 grew past the cursor and comes again; the list shows it once
    await answer(ready([row(24), ...rows(25, 10)], null))
    expect(shown()).toHaveLength(35)
    expect(new Set(shown()).size).toBe(35)
    expect(more()).toBeNull()
    expect(note()).toBeUndefined()
    // a row of the same project id under another number is its own row
    await act(async () => setRefresh(1))
    await answer(ready([row(1), row(1, { num: 99, name: 'Earlier owner', status: 'removed' })]))
    expect(shown()).toEqual(['p1:1', 'p1:99'])
  })

  it('starts only this list over for a search, keeps the search on Refresh, and drops an older search’s answer', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await type('cafe')
    await rest()
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', search: 'cafe' })
    const cafe = reads.length - 1
    // the search changes again before the answer lands; that answer is dropped
    await type('cafe racer')
    await rest()
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', search: 'cafe racer' })
    await answer(ready([row(7, { name: 'Café Bar' })]), cafe)
    expect(shown()).toEqual([])
    await answer(ready([row(3, { name: 'Café Racer' })]))
    expect(shown()).toEqual(['p3:3'])

    // Refresh reads the first batch again with the search kept
    const before = reads.length
    await act(async () => setRefresh(1))
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', search: 'cafe racer' })
    expect(searchBox().value).toBe('cafe racer')
    await answer(ready([row(3, { name: 'Café Racer' })]))
    expect(shown()).toEqual(['p3:3'])

    // Escape clears a typed search first, and the full list reads again
    await act(async () =>
      searchBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(searchBox().value).toBe('')
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1' })
  })

  it('says a stopped batch goes on, and says no projects match only at the real end', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await type('zeph')
    await rest()
    await answer(ready([], 'c2', true))
    expect(note()).toBe(
      'Qivo checked part of the list and found no matches there. Load more continues.Load more',
    )
    expect(container.textContent).not.toContain('No projects match.')
    await click(more())
    await answer(ready([row(40, { name: 'Zephyr' })], 'c3', true))
    expect(note()).toBe('Qivo checked part of the list. Load more continues.Load more')
    await click(more())
    await answer(ready([], null))
    expect(shown()).toEqual(['p40:40'])
    expect(note()).toBeUndefined()

    await type('nothing here')
    await rest()
    await answer(ready([], null))
    expect(note()).toBe('No projects match.')
  })

  it('keeps its rows after a failed Load more, and Retry reads the same place or the first batch again', async () => {
    await open()
    await fail()
    expect(note()).toBe("Couldn't load storage by project.")
    await click(retry())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1' })
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await fail()
    expect(shown()).toHaveLength(25)
    expect(note()).toBe("Couldn't load more projects.")
    await click(retry())
    expect(reads.at(-1)?.args).toEqual({ org_id: 'org-1', cursor: 'c1' })
    await answer(ready(rows(25, 5)))
    expect(shown()).toHaveLength(30)
  })

  it('keeps keyboard focus across Load more and Retry, and moves it to the search box when a first batch’s Retry goes', async () => {
    const focused = () => document.activeElement
    await open()
    await fail()
    act(() => retry()?.focus())
    await click(retry())
    // the Retry went with its line, so focus moves to the search box
    expect(note()).toBe('Loading storage by project…')
    expect(focused()).toBe(searchBox())
    await answer(ready(rows(0, 25), 'c1'))
    expect(focused()).toBe(searchBox())

    act(() => more()?.focus())
    await click(more())
    expect(focused()).toBe(more())
    // a failed Load more's Retry is the same button, so focus stays on it
    await fail()
    expect(focused()).toBe(retry())
    await click(retry())
    expect(focused()).toBe(more())
    // once Load more goes, focus moves to the first new row
    await answer(ready(rows(25, 5)))
    expect(more()).toBeNull()
    expect(focused()).toBe(container.querySelector('[data-billing-storage-row="p25:25"]'))

    // a Refresh that takes a failed first batch's Retry away moves nothing,
    // also after a Retry of that list's first batch failed again
    await act(async () => setRefresh(1))
    await fail()
    act(() => retry()?.focus())
    await click(retry())
    expect(focused()).toBe(searchBox())
    await fail()
    // Refresh disables itself while it reads, which leaves focus nowhere
    act(() => retry()?.focus())
    act(() => retry()?.blur())
    await act(async () => setRefresh(2))
    expect(note()).toBe('Loading storage by project…')
    expect(focused()).toBe(document.body)
  })

  it('says storage is being counted, at first and for a later batch', async () => {
    await open()
    await answer({ state: 'counting' })
    expect(note()).toBe('Storage is being counted. Check again later.')
    expect(shown()).toEqual([])
    await act(async () => setRefresh(1))
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await answer({ state: 'counting' })
    expect(shown()).toHaveLength(25)
    expect(note()).toBe('Storage is being counted again. Refresh to start the list over.')
    expect(retry()).toBeNull()
  })

  it('asks for a search once it holds `most` rows, and says No stored files for an empty organization', async () => {
    STORAGE_LIST.most = 30
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    await click(more())
    await answer(ready(rows(25, 25), 'c2'))
    expect(shown()).toHaveLength(50)
    expect(more()).toBeNull()
    expect(note()).toBe('Search to find more projects.')

    await act(async () => setRefresh(1))
    await answer(ready([]))
    expect(note()).toBe('No stored files.')
  })

  it('sends nothing for a search past the limit and says why', async () => {
    await open()
    await answer(ready(rows(0, 25), 'c1'))
    const sent = reads.length
    await type('x'.repeat(LIMITS.search.max + 1))
    await rest()
    expect(reads).toHaveLength(sent)
    expect(note()).toBe(limitSentence(LIMITS.search))
  })

  it('labels archived projects, projects in Deleted items and removed ones, with their keys', async () => {
    await open()
    await answer(
      ready([
        row(1),
        row(2, { status: 'archived', name: 'Old line' }),
        row(3, { status: 'deleted', name: 'Dropped' }),
        row(4, { status: 'removed', key: null, name: 'Board rev' }),
        row(5, { status: 'removed', key: null, num: null, name: null, files: 3 }),
      ]),
    )
    const text = [...container.querySelectorAll('[data-billing-storage-row]')].map(
      (li) => li.textContent,
    )
    expect(text).toEqual([
      'K1Project 110.0 KB · 1 file',
      'K2Old lineArchived10.0 KB · 1 file',
      'K3DroppedIn Deleted items10.0 KB · 1 file',
      'Board revRemoved10.0 KB · 1 file',
      'Removed projectRemoved10.0 KB · 3 files',
    ])
    // the size and file count alone, as the staging check reads them
    expect(
      [...container.querySelectorAll('[data-billing-storage-size]')].map((s) => s.textContent),
    ).toEqual([...Array(4).fill('10.0 KB · 1 file'), '10.0 KB · 3 files'])
    expect(shown().at(-1)).toBe('p5:')
  })
})
