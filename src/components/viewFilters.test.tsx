// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENTION_BATCH } from '../../convex/lib/limits'
import { mentionStandIn } from '../store/mentionStandIn.setup'
import { peopleSettingsStandIn } from '../store/peopleSettingsStandIn.setup'
import type { IssueFilters } from '../store/planner'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import { TooltipProvider } from './ui/tooltip'

/* The view filter's Assignee menu on the real store, among the design
   size's 1,000 people. The store holds nobody but the signed-in person, so
   the menu lists the organization's people from the server
   (pickers.mentions through its stand-in), MENTION_BATCH a batch with the
   server's search and Load more, and the people already chosen first,
   named by id (people.byIds). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const person = (n: number) => `person-${String(n).padStart(4, '0')}`

let snap: Snapshot
let store: typeof import('../store/planner')
let ui: typeof import('./viewFilters')
let container: HTMLDivElement
let root: Root
/** every pickers:mentions read's arguments, oldest first */
let asked: Record<string, unknown>[]
let shown: IssueFilters

async function load() {
  vi.resetModules()
  snap = plannerFixture()
  for (let i = 1; i < 1000; i++)
    snap.profiles.push({
      ...snap.profiles[0],
      id: person(i),
      auth_user_id: `account-${i}`,
      name: `Person ${String(i).padStart(4, '0')}`,
      initials: 'PE',
      email: `person${i}@example.test`,
    })
  asked = []
  network.query.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== 'pickers:mentions') return null
    asked.push(args)
    return mentionStandIn(snap, args)
  })
  network.onUpdate.mockImplementation((ref, args, next) => {
    if (getFunctionName(ref) === 'people:byIds')
      next(peopleSettingsStandIn(snap, 'people:byIds', args))
    else next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockResolvedValue(null)
  store = await import('../store/planner')
  await store.initStore()
  ui = await import('./viewFilters')
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)))

async function render(initial: Partial<IssueFilters> = {}) {
  const info = store.P.scopeInfo(snap.projects[0].id)
  if (!info) throw new Error('no scope')
  function Host() {
    const [filters, setFilters] = useState<IssueFilters>({
      mine: false,
      assignees: [],
      priority: null,
      stale: false,
      focus: false,
      search: '',
      ...initial,
    })
    shown = filters
    return (
      <ui.ViewFilters
        info={info as NonNullable<typeof info>}
        filters={filters}
        setFilters={setFilters}
      />
    )
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Host />
      </TooltipProvider>,
    ),
  )
  await settle()
}
const openMenu = async () => {
  await act(async () => document.querySelector<HTMLElement>('[data-filter-assignee-menu]')?.click())
  await settle()
}
const listed = () =>
  [...document.querySelectorAll<HTMLElement>('[data-filter-assignee]')].map(
    (row) => row.dataset.filterAssignee,
  )
const chosenRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-filter-assignee-chosen]')].map(
    (row) => row.dataset.filterAssignee,
  )
const typeSearch = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('[data-filter-assignee-search]')
  if (!input) throw new Error('no search box')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await rest()
  await settle()
}
const loadMore = () =>
  [...document.querySelectorAll<HTMLElement>('button, [role="option"], [role="menuitem"]')].find(
    (b) => b.textContent?.trim() === 'Load more',
  )

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await load()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the view filter's Assignee menu among 1,000 people", { timeout: 30_000 }, () => {
  it('lists the server’s people a batch at a time, never the store’s, and searches them on the server', async () => {
    // the store holds the signed-in person alone
    expect(store.P.users).toHaveLength(1)
    await render()
    expect(asked).toEqual([])
    await openMenu()
    expect(asked).toEqual([{ org_id: snap.orgs[0].id }])
    expect(listed()).toHaveLength(MENTION_BATCH)
    await act(async () => loadMore()?.click())
    await settle()
    expect(listed()).toHaveLength(2 * MENTION_BATCH)
    expect(asked[1]).toHaveProperty('after')
    // the server's search over names and addresses
    await typeSearch('person996@example')
    expect(asked.at(-1)).toMatchObject({ search: 'person996@example' })
    expect(listed()).toEqual([person(996)])
  })

  it('picks a person into the filter, shows the chosen first by name, and takes them back off', async () => {
    await render()
    await openMenu()
    await typeSearch('Person 0500')
    await act(async () =>
      document.querySelector<HTMLElement>(`[data-filter-assignee="${person(500)}"]`)?.click(),
    )
    await settle()
    expect(shown.assignees).toEqual([person(500)])
    // the chosen person leads the list, named by id, and is listed once,
    // also while the batch for the search still holds them
    expect(chosenRows()).toEqual([person(500)])
    expect(listed().filter((id) => id === person(500))).toHaveLength(1)
    await typeSearch('')
    expect(chosenRows()).toEqual([person(500)])
    expect(listed().filter((id) => id === person(500))).toHaveLength(1)
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          `[data-filter-assignee-chosen][data-filter-assignee="${person(500)}"]`,
        )?.textContent,
      ).toContain('Person 0500'),
    )
    await act(async () =>
      document.querySelector<HTMLElement>(`[data-filter-assignee-chosen]`)?.click(),
    )
    await settle()
    expect(shown.assignees).toEqual([])
  })
})
