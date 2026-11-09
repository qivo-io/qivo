// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { Activity, act, useEffect, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
} from '../store/projectNavStandIn.setup'
import type { FocusRow } from './SidebarProjects'
import { TooltipProvider } from './ui/tooltip'

/* The sidebar's project tree (components/SidebarProjects.tsx) on the real
   store, with the navigation reads answered by their stand-in
   (store/projectNavStandIn.setup.ts) from the workspace the test holds.
   The person holds a user seat in Testbed Labs with a grant on each
   top-level project a case plants, and with `partner` a user seat in
   Partner Co. Each case raises at most one figure of the design size: 200
   live top-level projects with everyday sub-projects, or 30 sub-projects
   under one project with everyday top-level projects; the bounds and the
   states come from a lowered SIDEBAR_MOST and the stand-in's `force`. The
   store boots without every task, as the app does, so a case can tell
   that the tree asks for none. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
// the live double of the store that loaded last, whose project cache reads
// a case can hold
const double = vi.hoisted(() => ({
  live: null as null | { forceProjectNav(force: { byIdsLoading?: boolean } | null): void },
}))
vi.mock('../lib/convex', async () => {
  const live = (await import('../store/guard/liveDouble.setup')).liveOver(network)
  double.live = live
  return { convex: network, live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

/** One subscription of a read, open until the tree drops it. */
type Sub = {
  name: string
  args: Record<string, unknown>
  next: (value: unknown) => void
  fail: (error: unknown) => void
  open: boolean
}

let container: HTMLDivElement
let root: Root
let snap: Snapshot
let subs: Sub[]
let force: ForcedProjectNav
let favorites: Set<string>
// reads whose answers wait until the test delivers them
let holding: ((sub: Sub) => boolean) | null
let ORG: string
let PARTNER: string
let tree: typeof import('./SidebarProjects')
let pickLib: typeof import('../lib/projectPick')
let version: typeof import('../store/usePlannerVersion')
let store: typeof import('../store/planner')
let actions: Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => void>>>
// the tree's scrollTop writes, and every element's scrollTop
let scrolled: number[]
// App's focus request as the tree gets it, which lasts until the tree is
// done with it, as App holds it, and the requests the tree said it is done
// with
let request: FocusRow | null
let done: number[]
const tops = new WeakMap<Element, number>()

/** Lets answers and renders land. */
const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/** A name of ordinary length, numbered. */
const named = (n: number, what = 'Sensor programme') => `${what} ${String(n).padStart(3, '0')}`

/** The fixture with the person's seat of `role`, its projects cleared,
    and with `partner` a user seat in Partner Co. */
function base(partner = false, role: 'user' | 'admin' = 'user'): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  next.profiles[0] = { ...next.profiles[0], org_role: role }
  next.projects = []
  PARTNER = crypto.randomUUID()
  if (partner) {
    const seat = crypto.randomUUID()
    next.orgs.push({ ...next.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
    next.profiles.push({ ...next.profiles[0], id: seat, org_id: PARTNER, org_role: 'user' })
    next.myProfileIds.push(seat)
  }
  return next
}

let num = 10
/** Adds a top-level project to `next`, with a grant for the person's seat
    in its organization unless `grant` is false, or led by them with
    `lead`, answering its id. */
function top(
  next: Snapshot,
  name: string,
  o: { org?: string; grant?: boolean; lead?: boolean } = {},
) {
  const org = o.org ?? ORG
  const id = crypto.randomUUID()
  const seat = next.profiles.find((p) => p.org_id === org && next.myProfileIds.includes(p.id))
  next.projects.push({
    ...plannerFixture().projects[0],
    id,
    org_id: org,
    type: 'meta',
    key: `P${num}`,
    num: num++,
    name,
    created_at: NOW,
    ...(o.lead && seat ? { lead_id: seat.id } : {}),
  })
  if (seat && o.grant !== false && !o.lead)
    next.access.push({ project_id: id, profile_id: seat.id, level: 'user' })
  return id
}
/** Adds a sub-project of `parent` to `next`, answering its id. */
function sub(next: Snapshot, parent: string, name: string) {
  const p = next.projects.find((x) => x.id === parent)
  if (!p) throw new Error('no parent')
  const id = crypto.randomUUID()
  next.projects.push({
    ...p,
    id,
    type: 'project',
    parent_id: parent,
    key: `S${num}`,
    num: num++,
    name,
  })
  return id
}

/** Answers subscription `s` from the workspace the test holds. */
const answer = (s: Sub) =>
  answerProjectNav(snap, s.name as never, s.args, s.next, s.fail, { force })

/** Sends every open navigation read its answer again, as Convex sends the
    reads a write changed. */
const republish = async () => {
  await act(async () => {
    for (const s of subs) if (s.open && isProjectNavRead(s.name)) answer(s)
  })
  await settle()
}

/** Seeds project `id`'s facts as a navigation row that showed it does
    (P.seedProjects), and holds the project cache's reads, so a scope
    opened from that row reads as loading with the row's facts. */
function seeded(id: string) {
  const p = snap.projects.find((x) => x.id === id)
  if (!p) throw new Error('no project')
  double.live?.forceProjectNav({ byIdsLoading: true })
  store.P.seedProjects([
    { id: p.id, org_id: p.org_id, name: p.name, num: p.num, parent_id: p.parent_id ?? null },
  ])
}

/** Loads the store from `next`, with the reads answered by their stand-in. */
async function load(next: Snapshot) {
  vi.resetModules()
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = false
  snap = next
  subs = []
  favorites = new Set()
  force = { favorites }
  holding = null
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    const s: Sub = { name, args, next: receive, fail, open: true }
    subs.push(s)
    if (isProjectNavRead(name)) {
      if (!holding?.(s)) answer(s)
    } else if (name === 'workspace:whole') receive(structuredClone(snap))
    return () => {
      s.open = false
    }
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  store = await import('../store/planner')
  // the project cache's reads answer from the whole, whatever a case
  // held before
  double.live?.forceProjectNav(null)
  await store.initStore()
  tree = await import('./SidebarProjects')
  pickLib = await import('../lib/projectPick')
  version = await import('../store/usePlannerVersion')
}

/** The tree on the store's version, one component for every render, with
    App's focus request, which ends once the tree is done with it. It names
    the scope's project and its top-level project with the project cache,
    as App's access guard does, since the tree places the scope by the
    cache's facts. */
function Harness({ scope }: { scope: string }) {
  version.usePlannerVersion()
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const topId = store.P.scopeInfo(scope).topId
  useEffect(() => {
    store.P.nameProjects('scope', topId && topId !== scope ? [scope, topId] : [scope])
  }, [scope, topId])
  return (
    <tree.SidebarProjects
      scope={scope}
      lit={(id) => id === scope}
      actions={actions}
      focusRow={request}
      onFocusRowDone={(n) => {
        done.push(n)
        if (request?.n !== n) return
        request = null
        redraw()
      }}
    />
  )
}

/** Renders the tree on `scope`, shown or hidden as App keeps it while
    Settings shows (React's Activity), with App's new focus request
    `focusRow`. */
async function render(scope: string, o: { mode?: 'visible' | 'hidden'; focusRow?: FocusRow } = {}) {
  if (o.focusRow) request = o.focusRow
  for (const name of [
    'openProject',
    'openProjects',
    'openSettings',
    'openArchivedTasks',
    'newProject',
  ])
    actions[name] ??= vi.fn<(...args: unknown[]) => void>()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Activity mode={o.mode ?? 'visible'}>
          <Harness scope={scope} />
        </Activity>
      </TooltipProvider>,
    ),
  )
  await settle()
  // the project cache's answer for the scope paints in the store's next
  // frame, and the reads it starts land after it
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await settle()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  Element.prototype.scrollIntoView = () => {}
  window.showToast = vi.fn()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // a layout: the tree is 320px tall from the window's top, and each
  // project row is 32px below the 40px header, moved by the tree's
  // scrollTop, which records what the tree writes
  scrolled = []
  request = null
  done = []
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, value)
      if (this.hasAttribute('data-sidebar-projects')) scrolled.push(value)
    },
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const list = this.closest('[data-sidebar-projects]')
    if (!list) return new DOMRect()
    if (this === list) return new DOMRect(0, 0, 273, 320)
    const rows = [...list.querySelectorAll('[data-project-row], [data-subproject-row]')]
    const at = rows.indexOf(this)
    return at < 0 ? new DOMRect() : new DOMRect(0, 40 + at * 32 - (tops.get(list) ?? 0), 273, 32)
  })
  actions = {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop')
  if (pickLib) Object.assign(pickLib.SIDEBAR_MOST, { list: 200, children: 100 })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  network.mutation.mockReset()
  network.query.mockReset()
  network.onUpdate.mockReset()
})

/** The element `selector` names, or a thrown error. */
function find<T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) {
  const element = scope.querySelector<T>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  return element
}
/** The top-level rows' ids in order. */
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-row]')].map(
    (el) => el.dataset.projectRow,
  )
/** The sub-project rows' names in order. */
const childNames = () =>
  [...document.querySelectorAll<HTMLElement>('[data-subproject-row] > button:first-child')].map(
    (el) => el.textContent ?? '',
  )
const row = (id: string) => find(`[data-project-row="${id}"]`)
const endOf = () => find('[data-sidebar-end]')
const end = () => endOf().dataset.sidebarEnd
const childrenEnd = () => find('[data-sidebar-children-end]')
const treeText = () => find('[data-sidebar-projects]').textContent ?? ''
const state = () => find('[data-sidebar-projects]').dataset.sidebarProjectsState
const open = (name?: string) => subs.filter((s) => s.open && (!name || s.name === name))
const asked = (name: string) => subs.filter((s) => s.name === `projectNav:${name}`)
const lit = () =>
  [...document.querySelectorAll<HTMLElement>('[data-sidebar-projects] [data-on]')].map(
    (el) => el.dataset.projectRow ?? el.dataset.subprojectRow,
  )

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
  await settle()
}
const loadMore = () => click(find('[data-sidebar-more]'))
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}

/** `n` top-level projects named in order, `subsOf` of them with the
    everyday 3 sub-projects each, answering their ids by name. */
function projects(next: Snapshot, n: number, subsOf = 0) {
  const ids: string[] = []
  // planted in reverse, so the workspace's order is not the server's
  for (let i = n - 1; i >= 0; i--) {
    const id = top(next, named(i))
    ids.unshift(id)
    if (i < subsOf) for (let s = 0; s < 3; s++) sub(next, id, named(s, 'Part'))
  }
  return ids
}

describe('the order', { timeout: 60_000 }, () => {
  it('puts the favorites first with their marks, then the rest by name, each once, with labels and tags', async () => {
    const next0 = base(true)
    // about 20 top-level projects of two organizations, the second's
    // between the home organization's by name; Test twice
    const ids = projects(next0, 16)
    const partner = top(next0, `${named(7)} partner`, { org: PARTNER })
    const testA = top(next0, 'Test')
    const testB = top(next0, 'Test')
    const owned = top(next0, 'Owned with parts')
    for (let s = 0; s < 3; s++) sub(next0, owned, named(s, 'Part'))
    await load(next0)
    for (const id of [ids[12], ids[3], partner]) favorites.add(id)
    await render(owned)
    const numOf = (id: string) => snap.projects.find((p) => p.id === id)?.num
    // the server's order: the favorites by name across both seats, then
    // the rest by name, equal names by id, never the workspace's order or
    // one organization after another
    const rest = [
      owned,
      ...ids.filter((id) => id !== ids[3] && id !== ids[12]),
      ...[testA, testB].sort(),
    ]
    expect(rowIds()).toEqual([ids[3], partner, ids[12], ...rest])
    expect(new Set(rowIds()).size).toBe(rowIds().length)
    // the rows keep the server's order, whatever it is: an answer that puts
    // the rest in reverse shows them so, as the browser sorts nothing
    const page = open('projectNav:page')[0] as Sub
    const reversed = [ids[3], partner, ids[12], ...[...rest].reverse()]
    await act(async () =>
      page.next({
        state: 'ok',
        rows: reversed.map((id) => {
          const p = snap.projects.find((x) => x.id === id)
          return {
            id,
            org_id: p?.org_id,
            name: p?.name,
            num: p?.num,
            favorite: [ids[3], partner, ids[12]].includes(id),
          }
        }),
        next: null,
        stopped: false,
      }),
    )
    await settle()
    expect(rowIds()).toEqual(reversed)
    await republish()
    expect(rowIds()).toEqual([ids[3], partner, ids[12], ...rest])
    // each favorite in a group a screen reader names, with its mark beside
    // the name button, never inside it, and every row a sibling of the
    // others in one sequence
    const inGroup = (group: string) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-sidebar-group="${group}"] > [data-project-row]`,
        ),
      ].map((r) => r.dataset.projectRow)
    expect(inGroup('favorites')).toEqual([ids[3], partner, ids[12]])
    expect(inGroup('rest')).toEqual(rest)
    for (const group of document.querySelectorAll('[data-sidebar-group="favorites"]')) {
      expect(group.getAttribute('role')).toBe('group')
      expect(group.getAttribute('aria-label')).toBe('Favorite projects')
    }
    for (const group of document.querySelectorAll('[data-sidebar-group="rest"]')) {
      expect(group.getAttribute('role')).toBeNull()
      expect(group.querySelector('[data-sidebar-favorite]')).toBeNull()
    }
    expect(
      new Set([...document.querySelectorAll('[data-sidebar-group]')].map((g) => g.parentElement))
        .size,
    ).toBe(1)
    for (const id of [ids[3], partner, ids[12]]) {
      const mark = find('[data-sidebar-favorite]', row(id))
      expect(mark.getAttribute('aria-hidden')).toBe('true')
      expect(mark.closest('button')).toBeNull()
    }
    expect(row(ids[3]).querySelector('button')?.textContent).toBe(named(3))
    // another organization's row names it inside its name button
    const label = find('[data-sidebar-org]', row(partner))
    expect(label.textContent).toBe('Partner Co')
    expect(label.closest('button')).toBe(row(partner).querySelector('button'))
    expect(row(ids[0]).querySelector('[data-sidebar-org]')).toBeNull()
    // equal names carry their numbers
    expect(row(testA).querySelector('button')?.textContent).toBe(`Test #${numOf(testA)}`)
    expect(row(testB).querySelector('button')?.textContent).toBe(`Test #${numOf(testB)}`)
    // the scope's project shows its sub-projects, with no mark or star
    expect(childNames()).toEqual([named(0, 'Part'), named(1, 'Part'), named(2, 'Part')])
    expect(find('[data-sidebar-children]').querySelector('[data-sidebar-favorite]')).toBeNull()
    expect(document.querySelector('[aria-pressed]')).toBeNull()
    // no organization header, and one read of each list
    expect(document.querySelector('[data-org-header]')).toBeNull()
    expect(open('projectNav:page')).toHaveLength(1)
    expect(open('projectNav:children')).toHaveLength(1)
  })

  it("lists an admin's projects by ordinary access, never the workspace's", async () => {
    const next0 = base(false, 'admin')
    const mine = top(next0, 'Mine by grant')
    const led = top(next0, 'Led by me', { lead: true })
    // a project the admin only manages: the navigation reads leave it out
    // by ordinary access, as the server's rule does, so the store knows
    // nothing of it and offers no management of it, failing closed
    const managed = top(next0, 'Managed only', { grant: false })
    await load(next0)
    await render(mine)
    expect(store.P.project(managed)).toBeUndefined()
    expect(store.P.levelOn(managed)).toBeNull()
    expect(store.P.canManageOwnProjectAccess(managed)).toBe(false)
    expect(rowIds()).toEqual([led, mine])
    // the row menu of a project they see by a grant offers New sub-project…,
    // as they manage every project
    await click(find('[aria-label="Project actions"]', row(mine)))
    const menu = find('[data-slot="popover-content"]')
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent?.trim())).toContain(
      'New sub-project…',
    )
  })
})

describe('the projects figure', { timeout: 60_000 }, () => {
  it('loads 200 top-level projects 25 at a time on Load more and as the marker comes into view, one read a batch, and stops at a lowered bound', async () => {
    // IntersectionObserver reports the marker where the layout puts it,
    // out of view below 25 rows until a scroll
    const markers: ((seen: boolean) => void)[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        report: (seen: boolean) => void
        constructor(receive: (entries: { isIntersecting: boolean }[]) => void) {
          this.report = (seen) => receive([{ isIntersecting: seen }])
        }
        observe() {
          markers.push(this.report)
          this.report(false)
        }
        disconnect() {}
      },
    )
    const next0 = base()
    // the projects figure at its design size; 20 of them with the everyday
    // 3 sub-projects, the rest with none
    const ids = projects(next0, 200, 20)
    await load(next0)
    await render('mine')
    expect(rowIds()).toEqual(ids.slice(0, 25))
    expect(asked('page')).toHaveLength(1)
    // Load more pressed by keyboard reads the second batch, which has more
    // to come, so Load more stays and keeps focus
    const pressed = find('[data-sidebar-more]')
    pressed.focus()
    await click(pressed)
    expect(rowIds()).toEqual(ids.slice(0, 50))
    expect(open('projectNav:page')).toHaveLength(2)
    expect(document.activeElement).toBe(find('[data-sidebar-more]'))
    // the person moves focus off it; each scroll to the end reads one
    // batch more
    await act(async () => pressed.blur())
    for (let batch = 3; batch <= 8; batch++) {
      await act(async () => {
        markers.at(-1)?.(true)
        markers.at(-1)?.(false)
      })
      await settle()
      expect(rowIds()).toEqual(ids.slice(0, batch * 25))
      expect(open('projectNav:page')).toHaveLength(batch)
    }
    // loads by scrolling take no focus, also once the list ends after an
    // earlier press of Load more whose batch had landed
    expect(document.activeElement).toBe(document.body)
    // the end says nothing after rows, and nothing more is read
    expect(end()).toBe('end')
    expect(endOf().textContent).toBe('')
    expect(treeText()).not.toContain('No active projects')
    const read = asked('page').length
    await act(async () => markers.at(-1)?.(true))
    await settle()
    expect(asked('page')).toHaveLength(read)
    expect(store.__layerProbe?.asks()).toEqual([])
    expect(open().map((s) => s.name)).toEqual([
      'workspace:whole',
      ...Array(8).fill('projectNav:page'),
    ])

    // the same list under a bound of 50 stops at two batches and points
    // to All projects, whose button opens the directory
    await act(async () => root.unmount())
    root = createRoot(container)
    await load(next0)
    pickLib.SIDEBAR_MOST.list = 50
    await render('mine')
    await loadMore()
    expect(rowIds()).toEqual(ids.slice(0, 50))
    expect(end()).toBe('full')
    expect(endOf().textContent).toContain('More projects are in All projects.')
    expect(document.querySelector('[data-sidebar-more]')).toBeNull()
    const before = asked('page').length
    await act(async () => markers.at(-1)?.(true))
    await settle()
    expect(asked('page')).toHaveLength(before)
    expect(rowIds()).toHaveLength(50)
    await click(find('[data-sidebar-all]'))
    expect(actions.openProjects).toHaveBeenCalledTimes(1)
  })

  it("reads on to the scope's project, lights it and scrolls it into view once", async () => {
    const next0 = base()
    const ids = projects(next0, 200, 20)
    await load(next0)
    // the 150th project, in the sixth batch
    await render(ids[149])
    expect(rowIds()).toHaveLength(150)
    expect(open('projectNav:page')).toHaveLength(6)
    expect(lit()).toEqual([ids[149]])
    // its row, the 150th, came into the 320px tree once
    expect(scrolled).toEqual([40 + 150 * 32 - 320])
    // once the person scrolled away, a later answer and render scroll
    // nothing
    const list = find('[data-sidebar-projects]')
    tops.set(list, 0)
    await republish()
    await render(ids[149])
    expect(scrolled).toHaveLength(1)
    expect(tops.get(list)).toBe(0)
    // a scope change scrolls to the new scope's row once, which is in view
    await render(ids[2])
    expect(scrolled).toHaveLength(1)
    await render(ids[20])
    expect(scrolled).toEqual([40 + 150 * 32 - 320, 40 + 21 * 32 - 320])
    expect(lit()).toEqual([ids[20]])
  })

  it('stops the scope rule at the bound, at the end, and once the rows passed its place', async () => {
    const next0 = base()
    // the projects figure at its design size: 198 projects the person
    // reads and two the reads leave out, as a project whose share went
    // after a row showed it, one that sorts last and one that sorts among
    // the others by name
    const ids = projects(next0, 198, 20)
    const last = top(next0, 'Zulu without access', { grant: false })
    const middle = top(next0, `${named(60)} without access`, { grant: false })
    await load(next0)
    // a scope opened from such a row, whose seeded facts place it while
    // the project cache checks it, reads to the end of a list that never
    // holds it and lights nothing
    seeded(last)
    await render(last)
    expect(rowIds()).toHaveLength(198)
    expect(asked('page').filter((s) => s.open)).toHaveLength(8)
    expect(lit()).toEqual([])
    expect(scrolled).toEqual([])
    // one whose place the rows passed stops there: the third batch ends
    // past Sensor programme 060
    await act(async () => root.unmount())
    root = createRoot(container)
    await load(next0)
    seeded(middle)
    await render(middle)
    expect(rowIds()).toHaveLength(75)
    expect(lit()).toEqual([])
    // under a bound below the scope's place it stops at the bound
    await act(async () => root.unmount())
    root = createRoot(container)
    await load(next0)
    pickLib.SIDEBAR_MOST.list = 100
    await render(ids[149])
    expect(rowIds()).toHaveLength(100)
    expect(end()).toBe('full')
    expect(lit()).toEqual([])
    expect(open('projectNav:page')).toHaveLength(4)
  })
})

describe('the expanded list', { timeout: 60_000 }, () => {
  /** Luma Sensor with 30 sub-projects, the figure under one project at its
      design size, and two everyday projects. */
  async function bigProject() {
    const next0 = base()
    const big = top(next0, 'Luma Sensor', { lead: true })
    const boards = Array.from({ length: 30 }, (_, s) => sub(next0, big, named(s, 'Board')))
    const cloud = top(next0, 'Luma Cloud')
    sub(next0, cloud, 'Frontend')
    const empty = top(next0, 'Luma Empty')
    await load(next0)
    return { big, boards, cloud, empty }
  }

  it("lists the scope's 30 sub-projects 25 first and the rest on Load more, as siblings, and stops when the scope moves", async () => {
    const { big, cloud } = await bigProject()
    await render(big)
    expect(childNames()).toHaveLength(25)
    expect(childNames()[0]).toBe(named(0, 'Board'))
    // the rows are siblings in one container, so the branch line ends on
    // the last
    expect(
      find('[data-sidebar-children]').querySelectorAll(':scope > [data-subproject-row]'),
    ).toHaveLength(25)
    await click(find('[data-sidebar-children-more]'))
    expect(childNames()).toHaveLength(30)
    expect(
      find('[data-sidebar-children]').querySelectorAll(':scope > [data-subproject-row]'),
    ).toHaveLength(30)
    expect(childrenEnd().dataset.sidebarChildrenEnd).toBe('end')
    expect(childrenEnd().textContent).toBe('')
    // only the scope's project reads its sub-projects
    expect(open('projectNav:children').map((s) => s.args.project_id)).toEqual([big, big])
    // another project's scope ends the first list's reads
    await render(cloud)
    expect(open('projectNav:children').map((s) => s.args.project_id)).toEqual([cloud])
    expect(childNames()).toEqual(['Frontend'])
    // My view ends every one
    await render('mine')
    expect(open('projectNav:children')).toEqual([])
    expect(document.querySelector('[data-sidebar-children]')).toBeNull()
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it('reads on to a scoped sub-project, lights it and stops at a lowered bound', async () => {
    const { big, boards } = await bigProject()
    // the 28th sub-project, in the second batch
    await render(boards[27])
    expect(childNames()).toHaveLength(30)
    expect(lit()).toEqual([boards[27]])
    // its row, the 28th under the third project, came into the 320px
    // tree once its batch landed in the expanded list
    expect(scrolled).toEqual([40 + 31 * 32 - 320])
    expect(asked('children').filter((s) => s.open)).toHaveLength(2)
    // under a bound of 5, batches of five, the list asks for a search and
    // lights nothing
    await act(async () => root.unmount())
    root = createRoot(container)
    force.batch = 5
    pickLib.SIDEBAR_MOST.children = 5
    await render(boards[27])
    expect(childNames()).toHaveLength(5)
    expect(childrenEnd().textContent).toBe('Search to find more sub-projects.')
    expect(lit()).toEqual([])
    expect(store.P.project(big)).toBeDefined()
  })

  it('says each state of the expanded list, and offers Add sub-project to a lead only at a confirmed empty end', async () => {
    const { big, cloud, empty } = await bigProject()
    // a project the person leads with none: Add sub-project
    const leadEmpty = top(snap, 'Led and empty', { lead: true })
    await load(snap)
    await render(leadEmpty)
    expect(childrenEnd().textContent).toBe('Add sub-project')
    await click(childrenEnd())
    expect(actions.newProject).toHaveBeenCalledWith({ parent: leadEmpty })
    // one they only use says they can open none
    await render(empty)
    expect(childrenEnd().textContent).toBe('No sub-projects you can open.')
    // on its way, held, refused or failed it offers no Add sub-project
    holding = (s) => s.name === 'projectNav:children'
    await render(leadEmpty)
    expect(childrenEnd().textContent).toBe('Loading sub-projects…')
    holding = null
    force.notReady = true
    await render(big)
    await render(leadEmpty)
    expect(childrenEnd().textContent).toBe('Qivo is still preparing your project list.')
    force.notReady = false
    force.unchecked = NAV_UNCHECKED
    await render(big)
    await render(leadEmpty)
    expect(childrenEnd().textContent).toBe(`${NAV_UNCHECKED}Retry`)
    force.unchecked = undefined
    await click(find('button', childrenEnd()))
    expect(childrenEnd().textContent).toBe('Add sub-project')
    force.fail = true
    await render(big)
    await render(leadEmpty)
    expect(childrenEnd().textContent).toBe("Couldn't load the sub-projects.Retry")
    force.fail = false
    // a batch the read budget stopped shows beside Load more
    force.stop = 2
    await render(big)
    expect(childNames()).toHaveLength(2)
    expect(childrenEnd().textContent).toBe('Qivo checked part of the sub-projects.Load more')
    force.stop = undefined
    // a project the person can no longer open
    snap.access = snap.access.filter((a) => a.project_id !== cloud)
    await render(cloud)
    expect(childrenEnd().textContent).toBe('You can no longer open this project.')
    expect(document.querySelector('[data-sidebar-children-end] button')).toBeNull()
  })
})

describe('a star', { timeout: 60_000 }, () => {
  it("keeps the scope's project, its loaded sub-projects and focus inside it as stars move rows between the groups", async () => {
    const next0 = base()
    const big = top(next0, 'Luma Sensor', { lead: true })
    const boards = Array.from({ length: 30 }, (_, s) => sub(next0, big, named(s, 'Board')))
    const cloud = top(next0, 'Luma Cloud')
    const empty = top(next0, 'Luma Empty')
    const mesh = top(next0, 'Mesh relay')
    await load(next0)
    await render(big)
    await click(find('[data-sidebar-children-more]'))
    expect(childNames()).toHaveLength(30)
    // the two batches' reads, which no star asks again
    const reads = asked('children').length
    expect(open('projectNav:children')).toHaveLength(2)
    // focus on the 30th sub-project, as a keyboard user leaves it
    const focused = find(`[data-subproject-row="${boards[29]}"] > button`)
    await act(async () => focused.focus())
    /** Asserts the tree in `order`, Luma Sensor among `favorites`, with
        its 30 sub-projects read once and focus where it was. */
    const kept = (order: string[], favorites: string[]) => {
      expect(rowIds()).toEqual(order)
      expect(
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-sidebar-group="favorites"] > [data-project-row]',
          ),
        ].map((r) => r.dataset.projectRow),
      ).toEqual(favorites)
      expect(childNames()).toHaveLength(30)
      expect(asked('children')).toHaveLength(reads)
      expect(open('projectNav:children')).toHaveLength(2)
      expect(focused.isConnected).toBe(true)
      expect(document.activeElement).toBe(focused)
      expect(lit()).toEqual([big])
    }
    // a star of a project below it moves Luma Sensor's row in the page,
    // and React gives focus back to the moved node
    favorites.add(mesh)
    await republish()
    kept([mesh, cloud, empty, big], [mesh])
    // a star of Luma Sensor itself moves it into the favorites
    favorites.add(big)
    await republish()
    kept([big, mesh, cloud, empty], [big, mesh])
    // and an unstar back among the rest
    favorites.delete(big)
    await republish()
    kept([mesh, cloud, empty, big], [mesh])
  })
})

describe('the states', { timeout: 60_000 }, () => {
  it('says each state the reads answer as itself, and has no active projects only at an empty end', async () => {
    const next0 = base()
    const ids = projects(next0, 12)
    await load(next0)
    force.notReady = true
    await render('mine')
    expect(end()).toBe('held')
    expect(state()).toBe('held')
    expect(treeText()).toContain('Qivo is still preparing your project list.')
    expect(treeText()).not.toContain('No active projects')
    expect(endOf().querySelector('button')).toBeNull()
    // the refusal of a check the server could not finish, with Retry
    force.notReady = false
    force.unchecked = NAV_UNCHECKED
    await republish()
    expect(end()).toBe('held')
    expect(endOf().textContent).toBe(`${NAV_UNCHECKED}Retry`)
    expect(treeText()).not.toContain('No active projects')
    // a batch the read budget stopped goes on with Load more
    force.unchecked = undefined
    force.stop = 2
    await republish()
    expect(end()).toBe('more')
    expect(endOf().textContent).toBe('Qivo checked part of your projects.Load more')
    expect(rowIds()).toEqual(ids.slice(0, 2))
    // a failed read offers Retry, which reads again
    force.stop = undefined
    force.fail = true
    await republish()
    expect(end()).toBe('failed')
    expect(state()).toBe('failed')
    expect(endOf().textContent).toBe("Couldn't load more projects.Retry")
    force.fail = false
    await click(find('button', endOf()))
    expect(rowIds()).toEqual(ids)
    expect(state()).toBe('ok')
    expect(end()).toBe('end')
  })

  it('says a first batch that failed, and a batch above the last that failed, as themselves', async () => {
    const next0 = base()
    const ids = projects(next0, 10)
    await load(next0)
    force.fail = true
    await render('mine')
    expect(end()).toBe('failed')
    expect(endOf().textContent).toBe("Couldn't load your projects.Retry")
    expect(treeText()).not.toContain('No active projects')
    force.fail = false
    await click(find('button', endOf()))
    // batches of five; the first fails once the second has answered
    force.batch = 5
    await republish()
    await loadMore()
    expect(rowIds()).toEqual(ids)
    expect(end()).toBe('end')
    const first = open('projectNav:page').find((s) => s.args.after === undefined) as Sub
    await act(async () => first.fail(new Error('the read failed')))
    await settle()
    // the list claims no end, and the batch's note follows its rows
    expect(end()).toBe('partial')
    const note = find('[data-sidebar-note]')
    expect(note.textContent).toBe("Couldn't load part of your projects.Retry")
    expect(rowIds()).toEqual(ids)
    expect(
      note.previousElementSibling
        ?.querySelector('[data-project-row]')
        ?.getAttribute('data-project-row'),
    ).toBe(ids[4])
    await click(find('button', note))
    expect(document.querySelector('[data-sidebar-note]')).toBeNull()
  })

  it('has no active projects only at an empty end, and tells an admin where every project is', async () => {
    for (const role of ['user', 'admin'] as const) {
      const next0 = base(false, role)
      // a project the admin reaches only by admin status
      top(next0, 'Managed only', { grant: false })
      await load(next0)
      await render('mine')
      expect(end()).toBe('end')
      expect(endOf().textContent).toBe(
        role === 'admin'
          ? 'No active projects. Settings › Projects › All projects lists every project of your organization.'
          : 'No active projects.',
      )
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })
})

describe('rows', { timeout: 60_000 }, () => {
  it('offers New sub-project… where the person leads, and opens every row at once with its facts seeded', async () => {
    const next0 = base()
    const led = top(next0, 'Led by me', { lead: true })
    const used = top(next0, 'Used by me')
    await load(next0)
    // a project the server lists that no row showed before, which its
    // whole holds too, so the project cache answers it
    const late = top(snap, 'Late arrival')
    const whole = subs.find((s) => s.name === 'workspace:whole' && s.open)
    await act(async () => whole?.next(structuredClone(snap)))
    await republish()
    await render('mine')
    const items = async (id: string) => {
      await click(find('[aria-label="Project actions"]', row(id)))
      // the open menu names its row's project with the project cache, whose
      // answer the store paints in its next frame
      await vi.waitFor(() => expect(store.P.projectState(id)).toBe('ok'))
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await settle()
      const menu = find('[data-slot="popover-content"]')
      const out = [...menu.querySelectorAll('button')].map((b) => b.textContent?.trim())
      await click([...menu.querySelectorAll('button')].at(-1))
      return out
    }
    // the menu names its row's project with the project cache, so New
    // sub-project… shows where the person leads it, and a pick also moves
    // the scope to its row's project, for every row, saying nothing
    expect(await items(led)).toEqual(['New sub-project…', 'Project settings', 'Archived tasks'])
    expect(await items(used)).toEqual(['Project settings', 'Archived tasks'])
    expect(await items(late)).toEqual(['Project settings', 'Archived tasks'])
    expect(actions.openArchivedTasks).toHaveBeenCalledWith(late)
    expect(actions.openProject.mock.calls).toEqual([[led], [used], [late]])
    // a press opens any row's project at once, as it does a project the
    // cache answered, with the row's facts seeded so its views ask while
    // the cache checks it: no check of the server and no toast
    await click(find('button', row(used)))
    expect(actions.openProject).toHaveBeenLastCalledWith(used)
    await click(row(led))
    expect(actions.openProject).toHaveBeenLastCalledWith(led)
    await click(find('button', row(late)))
    expect(actions.openProject).toHaveBeenLastCalledWith(late)
    expect(actions.openProject).toHaveBeenCalledTimes(6)
    expect(store.P.project(late)).toMatchObject({ id: late, name: 'Late arrival', type: 'meta' })
    expect(
      network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'projectNav:resolve'),
    ).toEqual([])
    expect(window.showToast).not.toHaveBeenCalled()
  })
})

describe('reading', { timeout: 60_000 }, () => {
  it('stops every read while the tab or the tree hides, keeps its rows, and reads again on return', async () => {
    const next0 = base()
    const ids = projects(next0, 40, 3)
    await load(next0)
    await render(ids[1])
    await loadMore()
    const reading = () =>
      open()
        .filter((s) => isProjectNavRead(s.name))
        .map((s) => JSON.stringify([s.name, s.args]))
        .sort()
    const before = reading()
    expect(before).toHaveLength(3)
    await setVisibility('hidden')
    expect(reading()).toEqual([])
    expect(rowIds()).toEqual(ids)
    await setVisibility('visible')
    expect(reading()).toEqual(before)
    // hidden as while Settings shows: the reads stop, the rows stay, and
    // the same batches read again, refreshing until they answered
    const shown = row(ids[30])
    await render(ids[1], { mode: 'hidden' })
    expect(reading()).toEqual([])
    holding = () => true
    await render(ids[1])
    expect(row(ids[30])).toBe(shown)
    expect(state()).toBe('refreshing')
    for (const s of open()) if (isProjectNavRead(s.name)) await act(async () => answer(s))
    await settle()
    expect(state()).toBe('ok')
    expect(reading()).toEqual(before)
    expect(childNames()).toHaveLength(3)
    expect(store.__layerProbe?.asks()).toEqual([])
  })
})

describe('the reveal', { timeout: 60_000 }, () => {
  it("reveals the scope's row again after a scope that names no row, such as My view", async () => {
    const next0 = base()
    const ids = projects(next0, 30, 3)
    // A, the 21st project, with a sub-project of its own
    const a = ids[20]
    const part = sub(next0, a, 'Zulu part')
    await load(next0)
    const list = () => find('[data-sidebar-projects]')
    const into = 40 + 21 * 32 - 320
    await render(a)
    expect(scrolled).toEqual([into])
    // the person scrolls back to the top and goes to My view, which names
    // no row, and back to A, whose row comes into view again; A's
    // sub-projects load no more from here on
    tops.set(list(), 0)
    await render('mine')
    expect(scrolled).toEqual([into])
    holding = (s) => s.name === 'projectNav:children'
    await render(a)
    expect(scrolled).toEqual([into, into])
    expect(lit()).toEqual([a])
    // the same through a sub-project of A the tree does not hold yet, its
    // list still loading
    tops.set(list(), 0)
    await render(part)
    expect(childNames()).toEqual([])
    expect(lit()).toEqual([])
    expect(scrolled).toEqual([into, into])
    await render(a)
    expect(scrolled).toEqual([into, into, into])
    // a render on the same scope scrolls nothing
    tops.set(list(), 0)
    await render(a)
    expect(scrolled).toEqual([into, into, into])
  })
})

describe('focus', { timeout: 60_000 }, () => {
  it('focuses a requested row once the server lists it, in the tree’s view, and drops a request it cannot meet', async () => {
    const next0 = base()
    const ids = projects(next0, 20)
    await load(next0)
    await render(ids[0])
    // a project created now, past the rows the tree shows, which the
    // server lists only with its next answer
    const made = top(snap, 'Zulu new project')
    await load(snap)
    holding = (s) => s.name === 'projectNav:page'
    await render(made, { focusRow: { id: made, n: 1 } })
    expect(document.activeElement).toBe(document.body)
    holding = null
    for (const s of open('projectNav:page')) await act(async () => answer(s))
    await settle()
    const button = find('button', row(made))
    expect(document.activeElement).toBe(button)
    // the tree told App it took the request, which App then ends
    expect(done).toContain(1)
    expect(request).toBeNull()
    // the row, the 21st, scrolled into the tree's view
    expect(tops.get(find('[data-sidebar-projects]'))).toBe(40 + 21 * 32 - 320)
    // a request whose row shows while focus is elsewhere moves nothing
    const other = find('button', row(ids[4]))
    other.focus()
    await render(made, { focusRow: { id: ids[9], n: 2 } })
    expect(document.activeElement).toBe(other)
    // a request for a row the ended list lacks is dropped, so the row
    // takes no focus when a later answer brings it
    other.blur()
    const later = top(snap, 'Alpha later')
    await render(made, { focusRow: { id: later, n: 3 } })
    expect(request).toBeNull()
    await republish()
    expect(find('button', row(later)).textContent).toBe('Alpha later')
    expect(document.activeElement).toBe(document.body)
    expect([...new Set(done)]).toEqual([1, 2, 3])
  })

  it("brings a row focused by Load more's rule or a program into the tree's view, and leaves a pressed one", async () => {
    const next0 = base()
    const ids = projects(next0, 30)
    await load(next0)
    await render('mine')
    const list = find('[data-sidebar-projects]')
    // Load more pressed by keyboard at the list's end: once it leaves,
    // focus goes to the first new row, which comes into view
    const more = find('[data-sidebar-more]')
    more.focus()
    await click(more)
    expect(document.querySelector('[data-sidebar-more]')).toBeNull()
    expect(document.activeElement).toBe(find('button', row(ids[25])))
    expect(tops.get(list)).toBe(40 + 26 * 32 - 320)
    // a row a program focuses comes into view too, above as below
    await act(async () => find('button', row(ids[0])).focus())
    expect(tops.get(list)).toBe(40)
    // a press inside the tree scrolls nothing
    const pressed = find('button', row(ids[29]))
    scrolled.length = 0
    await act(async () => {
      pressed.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      pressed.focus()
    })
    expect(scrolled).toEqual([])
  })
})
