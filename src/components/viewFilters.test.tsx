// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, type ReactNode, useEffect, useState } from 'react'
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
   (pickers.orgPeople through its stand-in), MENTION_BATCH a batch with the
   server's search and Load more, and the people already chosen first,
   named by id (people.byIds), also one a filter carried from a project of
   the login's other organization chose there. */

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
/** every pickers:orgPeople read's arguments, oldest first */
let asked: Record<string, unknown>[]
let shown: IssueFilters

/** Loads the store over an organization of `people` people, with `extra`
    changes. */
async function load({
  people = 1000,
  extra,
}: {
  people?: number
  extra?: (snap: Snapshot) => void
} = {}) {
  vi.resetModules()
  snap = plannerFixture()
  for (let i = 1; i < people; i++)
    snap.profiles.push({
      ...snap.profiles[0],
      id: person(i),
      auth_user_id: `account-${i}`,
      name: `Person ${String(i).padStart(4, '0')}`,
      initials: 'PE',
      email: `person${i}@example.test`,
    })
  extra?.(snap)
  asked = []
  network.query.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) !== 'pickers:orgPeople') return null
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

/** Renders the filters with `initial`, after `beside`, another open view
    whose effects run first. */
async function render(initial: Partial<IssueFilters> = {}, beside?: ReactNode) {
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
    // the filters on screen, for the cases to read once the render settled
    useEffect(() => {
      shown = filters
    })
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
        {beside}
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
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the view filter's Assignee menu among 1,000 people", { timeout: 30_000 }, () => {
  beforeEach(() => load())

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
    // the server's search over names and initials, never an address
    await typeSearch('0996 pe')
    expect(asked.at(-1)).toMatchObject({ search: '0996 pe' })
    expect(listed()).toEqual([person(996)])
    await typeSearch('person996@example')
    expect(asked.at(-1)).toMatchObject({ search: 'person996@example' })
    expect(listed()).toEqual([])
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

describe("the view filter's Assignee menu for a login in two organizations", () => {
  const PARTNER = 'org-partner'
  /** A partner organization where the login holds a seat and Pia works. */
  const twoOrgs = (snap: Snapshot) => {
    const me = snap.profiles[0]
    snap.orgs.push({ ...snap.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
    snap.profiles.push(
      { ...me, id: 'seat-partner', org_id: PARTNER },
      {
        ...me,
        id: 'pia',
        org_id: PARTNER,
        auth_user_id: 'account-pia',
        name: 'Pia Partner',
        initials: 'PP',
        email: 'pia@partner.test',
      },
    )
    snap.myProfileIds.push('seat-partner')
  }
  const trigger = () => document.querySelector('[data-filter-assignee-menu]')?.textContent

  it('names a chosen person of the other organization a filter carried here, never Unknown user', async () => {
    await load({ people: 30, extra: twoOrgs })
    // the scope is a project of the home organization; Pia was chosen in a
    // project of the partner organization, and the filter came along
    await render({ assignees: ['pia'] })
    await vi.waitFor(() => expect(trigger()).toContain('Pia'))
    expect(trigger()).not.toContain('Unknown user')
    await openMenu()
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-filter-assignee-chosen][data-filter-assignee="pia"]')
          ?.textContent,
      ).toContain('Pia Partner'),
    )
    expect(shown.assignees).toEqual(['pia'])
  })

  it('names a chosen person in the organization where another open view already names them', async () => {
    await load({ people: 30, extra: twoOrgs })
    const { usePeople } = await import('./usePeople')
    // another open view, such as Team sync or a task window, names Pia in
    // her own organization first, so the profile cache reads her there and
    // a read of the home organization would never answer for her
    function Elsewhere() {
      usePeople([{ org: PARTNER, id: 'pia' }])
      return null
    }
    await render({ assignees: ['pia'] }, <Elsewhere />)
    await vi.waitFor(() => expect(trigger()).toContain('Pia'))
    expect(trigger()).not.toContain('Loading')
    expect(shown.assignees).toEqual(['pia'])
  })
})
