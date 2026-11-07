// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { Activity, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
  PROJECT_NAV_STAR,
  setFavoriteStandIn,
} from '../store/projectNavStandIn.setup'
import { isProjectSettingsRead, projectSettingsServer } from '../store/projectSettingsStandIn.setup'
import { TooltipProvider } from './ui/tooltip'

/* The All projects directory (components/ProjectDirectory.tsx) on the real
   store, with the navigation reads and the star answered by their stand-in
   (store/projectNavStandIn.setup.ts) from the workspace the test holds, and
   a project's settings by theirs (store/projectSettingsStandIn.setup.ts).
   The person holds a user seat in Testbed Labs with a grant on each
   top-level project a case plants, and with `partner` a user seat in
   Partner Co. A star goes through the store to a mutation double that
   applies the stand-in's star and sends the open reads' new answers before
   it answers, as Convex does. Typing runs on fake timers. Each case raises
   at most one figure of the design size: 200 top-level projects with
   everyday sub-projects, 200 readable sub-projects at 3 a project, or 30
   sub-projects under one project; the caps and the states come from a
   lowered cap and the stand-in's `force`. The store boots without every
   task, as the app does, so a case can tell that the directory asks for
   none. */

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

const NOW = '2026-09-14T08:00:00.000Z'

/** One subscription of a read, open until the page drops it. */
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
// a refusal every star gets instead of the stand-in's answer
let refuseStar: unknown
let whole: { next: (value: unknown) => void; fail: (error: unknown) => void } | null
let ORG: string
let ME: string
let PARTNER: string
let directory: typeof import('./ProjectDirectory')
let pickLib: typeof import('../lib/projectPick')
let version: typeof import('../store/usePlannerVersion')
let store: typeof import('../store/planner')
let actions: Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => void>>>

/** Lets answers and renders land. */
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
      else await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/** A name of ordinary length, numbered. */
const named = (n: number, what = 'Sensor programme') => `${what} ${String(n).padStart(3, '0')}`

/** The fixture with the person's seat of `role`, its projects cleared,
    and with `partner` a user seat in Partner Co. */
function base(partner = false, role: 'user' | 'admin' = 'user'): Snapshot {
  const next = plannerFixture()
  ORG = next.orgs[0].id
  ME = next.profiles[0].id
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
/** Adds a top-level project to `next` with a grant for the person's seat
    in its organization, answering its id. */
function top(next: Snapshot, name: string, o: { org?: string } = {}) {
  const org = o.org ?? ORG
  const id = crypto.randomUUID()
  next.projects.push({
    ...plannerFixture().projects[0],
    id,
    org_id: org,
    type: 'meta',
    key: `P${num}`,
    num: num++,
    name,
    created_at: NOW,
  })
  const seat = next.profiles.find((p) => p.org_id === org && next.myProfileIds.includes(p.id))
  if (seat) next.access.push({ project_id: id, profile_id: seat.id, level: 'user' })
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
const republish = () =>
  act(async () => {
    for (const s of subs) if (s.open && isProjectNavRead(s.name)) answer(s)
  })

/** Loads the store from `next`, with the reads answered by their stand-ins
    and the star by the stand-in's. */
async function load(next: Snapshot) {
  vi.resetModules()
  const { TASKS } = await import('../store/liveParts')
  TASKS.atBoot = false
  snap = next
  subs = []
  favorites = new Set()
  force = { favorites }
  holding = null
  refuseStar = undefined
  whole = null
  const settings = projectSettingsServer(() => snap)
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (isProjectSettingsRead(name)) return settings.watch(name, args, receive, fail)
    const s: Sub = { name, args, next: receive, fail, open: true }
    subs.push(s)
    if (isProjectNavRead(name)) {
      if (!holding?.(s)) answer(s)
    } else if (name === 'workspace:whole') {
      whole = { next: receive, fail }
      receive(structuredClone(snap))
    }
    return () => {
      s.open = false
    }
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name !== PROJECT_NAV_STAR) return null
    if (refuseStar) throw refuseStar
    setFavoriteStandIn(snap, favorites, args)
    // the reads the star changed answer before the star does
    await republish()
    return null
  })
  store = await import('../store/planner')
  await store.initStore()
  directory = await import('./ProjectDirectory')
  pickLib = await import('../lib/projectPick')
  version = await import('../store/usePlannerVersion')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** The directory on the store's version, one component for every render,
    so a render that hides or shows it keeps it mounted. */
function Harness() {
  version.usePlannerVersion()
  return <directory.ProjectDirectory actions={actions} />
}

/** Renders the directory, shown or hidden as a kept page is (React's
    Activity, as components/KeptView.tsx hides one). */
async function render(mode: 'visible' | 'hidden' = 'visible') {
  for (const name of [
    'openProject',
    'openSettings',
    'openArchivedTasks',
    'newProject',
    'createOrg',
  ])
    actions[name] ??= vi.fn<(...args: unknown[]) => void>()
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Activity mode={mode}>
          <Harness />
        </Activity>
      </TooltipProvider>,
    ),
  )
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
  if (pickLib) Object.assign(pickLib.DIRECTORY_MOST, { children: 100 })
  vi.useRealTimers()
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
const field = () => find<HTMLInputElement>('[data-directory-search]')
/** The rows' ids in order. */
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-directory-row]')].map(
    (el) => el.dataset.directoryRow,
  )
/** The rows' names as their open buttons read them. */
const rowNames = () =>
  [...document.querySelectorAll<HTMLElement>('[data-directory-open]')].map(
    (el) => el.textContent?.trim() ?? '',
  )
const row = (id: string) => find(`[data-directory-row="${id}"]`)
const starOf = (id: string) => find<HTMLButtonElement>('[data-directory-star]', row(id))
const endLine = () => document.querySelector<HTMLElement>('[data-project-directory-end]')
const end = () => endLine()?.dataset.projectDirectoryEnd
const pageText = () => find('[data-project-directory]').textContent ?? ''
const open = (name?: string) => subs.filter((s) => s.open && (!name || s.name === name))
const asked = (name: string) => subs.filter((s) => s.name === `projectNav:${name}`)
const groups = () =>
  [...document.querySelectorAll<HTMLElement>('[data-directory-group]')].map(
    (el) => el.dataset.directoryGroup,
  )
const sentStars = () =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === PROJECT_NAV_STAR)
    .map(([, args]) => args)

async function key(value: string) {
  const input = field()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function wait(ms: number) {
  await act(async () => await vi.advanceTimersByTimeAsync(ms))
  await settle()
}
/** Types `value` and rests past the directory's pause. */
async function type(value: string) {
  await key(value)
  await wait(300)
}
async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  await act(async () => element.click())
  await settle()
}
const next = () => click(find('[data-project-directory-next]'))
const previous = () => click(find('[data-project-directory-previous]'))
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
}

describe('browsing', { timeout: 60_000 }, () => {
  it('lists 200 top-level projects 25 a page in the server’s order, one page read at a time', async () => {
    const next0 = base()
    // the projects figure at its design size; 20 of them with the everyday
    // 3 sub-projects, the rest with none
    const ids: string[] = []
    for (let n = 0; n < 200; n++) {
      const id = top(next0, named(199 - n))
      ids.push(id)
      if (n < 20) for (let s = 0; s < 3; s++) sub(next0, id, `Part ${s}`)
    }
    await load(next0)
    await render()
    const byName = [...ids].reverse()
    expect(rowIds()).toEqual(byName.slice(0, 25))
    expect(rowNames()[0]).toBe(named(0))
    // no later page read ahead, and no heading without a favorite
    expect(asked('page')).toHaveLength(1)
    expect(groups()).toEqual([])
    expect(document.querySelector('[data-project-directory-previous]')).toBeNull()
    for (let page = 1; page < 8; page++) {
      await next()
      expect(rowIds()).toEqual(byName.slice(page * 25, page * 25 + 25))
      // the page on screen is the one read open
      expect(open('projectNav:page')).toHaveLength(1)
    }
    expect(document.querySelector('[data-project-directory-next]')).toBeNull()
    expect(end()).toBe('end')
    await previous()
    expect(rowIds()).toEqual(byName.slice(150, 175))
    expect(open('projectNav:page')).toHaveLength(1)
    // eight pages and one back, each read once
    expect(asked('page')).toHaveLength(9)
    // no task asked, and no other read than the page
    expect(store.__layerProbe?.asks()).toEqual([])
    expect(open().map((s) => s.name)).toEqual(['workspace:whole', 'projectNav:page'])
  })

  it('heads the favorites and the rest, and a page without favorites has no headings', async () => {
    const next0 = base()
    const ids = Array.from({ length: 10 }, (_, n) => top(next0, named(n)))
    await load(next0)
    for (const id of [ids[9], ids[4], ids[7]]) favorites.add(id)
    force.batch = 5
    await render()
    expect(rowNames()).toEqual([named(4), named(7), named(9), named(0), named(1)])
    expect(groups()).toEqual(['favorites', 'rest'])
    const list = find('[data-project-directory]')
    const order = [...list.querySelectorAll('[data-directory-group], [data-directory-row]')].map(
      (el) => (el as HTMLElement).dataset.directoryGroup ?? 'row',
    )
    expect(order).toEqual(['favorites', 'row', 'row', 'row', 'rest', 'row', 'row'])
    expect(starOf(ids[4]).getAttribute('aria-pressed')).toBe('true')
    expect(starOf(ids[0]).getAttribute('aria-pressed')).toBe('false')
    await next()
    expect(rowNames()).toEqual([named(2), named(3), named(5), named(6), named(8)])
    expect(groups()).toEqual([])
  })

  it('says each state the reads answer as itself, never an empty list', async () => {
    const next0 = base()
    for (let n = 0; n < 12; n++) top(next0, named(n))
    await load(next0)
    force.notReady = true
    await render()
    expect(end()).toBe('held')
    expect(pageText()).toContain('Qivo is still preparing your project list.')
    expect(pageText()).not.toContain('no active projects')
    expect(rowIds()).toEqual([])
    // the refusal of a check the server could not finish, with Retry
    force.notReady = false
    force.unchecked = NAV_UNCHECKED
    await republish()
    await settle()
    expect(end()).toBe('held')
    expect(pageText()).toContain(NAV_UNCHECKED)
    expect(endLine()?.querySelector('[data-page-retry]')).not.toBeNull()
    // a page the read budget stopped goes on with Next
    force.unchecked = undefined
    force.stop = 2
    await republish()
    await settle()
    expect(end()).toBe('more')
    expect(pageText()).toContain('Qivo checked part of your projects. Next continues.')
    expect(rowIds()).toHaveLength(2)
    expect(document.querySelector('[data-project-directory-next]')).not.toBeNull()
    // a failed read offers Retry, which reads again
    force.stop = undefined
    force.fail = true
    await republish()
    await settle()
    expect(end()).toBe('failed')
    expect(pageText()).toContain("Couldn't load your projects.")
    force.fail = false
    const before = asked('page').length
    await click(find('[data-page-retry]'))
    expect(asked('page').length).toBeGreaterThan(before)
    expect(rowIds()).toHaveLength(12)
    // the end of the one page says nothing
    expect(endLine()).toBeNull()
  })

  it('shows a page whose read stopped where it began as stuck, with Retry', async () => {
    const next0 = base()
    for (let n = 0; n < 30; n++) top(next0, named(n))
    await load(next0)
    await render()
    // the second page's read stops where it began, checking nothing
    holding = (s) => s.name === 'projectNav:page' && !!s.args.after
    await click(find('[data-project-directory-next]'))
    const held = subs.find((s) => s.open && !!s.args.after) as Sub
    await act(async () =>
      held.next({ state: 'ok', rows: [], next: held.args.after, stopped: true }),
    )
    await settle()
    expect(end()).toBe('stuck')
    expect(pageText()).toContain('Qivo could not check part of your projects.')
    expect(endLine()?.querySelector('[data-page-retry]')).not.toBeNull()
    expect(rowIds()).toEqual([])
  })

  it('says the person has no active projects, and where an admin finds every project', async () => {
    for (const role of ['user', 'admin'] as const) {
      await load(base(false, role))
      await render()
      expect(end()).toBe('empty')
      expect(pageText()).toContain(
        'You have no active projects. Ask an organization admin or a project lead for access.',
      )
      expect(pageText().includes('Settings › Projects › All projects lists every project')).toBe(
        role === 'admin',
      )
      await act(async () => root.unmount())
      root = createRoot(container)
      vi.useRealTimers()
    }
  })
})

describe('the star', { timeout: 60_000 }, () => {
  /** Twelve top-level projects in pages of five, the second page shown. */
  async function second() {
    const next0 = base()
    const ids = Array.from({ length: 12 }, (_, n) => top(next0, named(n)))
    await load(next0)
    force.batch = 5
    await render()
    await next()
    expect(rowNames()).toEqual([5, 6, 7, 8, 9].map((n) => named(n)))
    return ids
  }

  it('stars through the store, shows it at once and moves the row with the next answer, focus at its place', async () => {
    const ids = await second()
    const button = starOf(ids[6])
    button.focus()
    // the star waits for the server's answer a moment
    let release = () => {}
    network.mutation.mockImplementationOnce(
      (_ref, args) =>
        new Promise((resolve) => {
          release = () => {
            setFavoriteStandIn(snap, favorites, args)
            void republish().then(() => resolve(null))
          }
        }),
    )
    await click(button)
    expect(sentStars()).toEqual([{ org_id: ORG, project_id: ids[6], favorite: true }])
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-busy')).toBe('true')
    // a second press goes nowhere while the first is on its way
    await click(button)
    expect(sentStars()).toHaveLength(1)
    await act(async () => release())
    await settle()
    // the row left this page for the favorites on the first, and focus
    // went to the star of the row now at its place
    expect(rowNames()).toEqual([5, 7, 8, 9, 10].map((n) => named(n)))
    expect(document.activeElement).toBe(starOf(ids[7]))
    expect(pageText()).toContain(`${named(6)} is now a favorite.`)
    await previous()
    expect(rowNames()).toEqual([named(6), named(0), named(1), named(2), named(3)])
    expect(groups()).toEqual(['favorites', 'rest'])
    expect(starOf(ids[6]).getAttribute('aria-pressed')).toBe('true')
    expect(starOf(ids[6]).getAttribute('aria-busy')).toBeNull()
    // an unstar moves it back
    await click(starOf(ids[6]))
    expect(sentStars().at(-1)).toEqual({ org_id: ORG, project_id: ids[6], favorite: false })
    expect(rowNames()).toEqual([0, 1, 2, 3, 4].map((n) => named(n)))
    expect(groups()).toEqual([])
    expect(pageText()).toContain(`${named(6)} is no longer a favorite.`)
  })

  it('sends focus to the star at its place among a search page’s stars, which sub-project rows lack', async () => {
    const next0 = base()
    const parent = top(next0, 'Base')
    // twelve matches by name, top-level projects 7, 9, 10 and 11 among
    // sub-projects of Base, in pages of five
    const ids = Array.from({ length: 12 }, (_, n) =>
      [7, 9, 10, 11].includes(n)
        ? top(next0, named(n, 'Rig'))
        : sub(next0, parent, named(n, 'Rig')),
    )
    await load(next0)
    force.batch = 5
    await render()
    await type('rig')
    await next()
    const under = (n: number) => `Base › ${named(n, 'Rig')}`
    expect(rowNames()).toEqual([under(5), under(6), named(7, 'Rig'), under(8), named(9, 'Rig')])
    const button = starOf(ids[7])
    button.focus()
    await click(button)
    // the row left this page for the favorites on the first; the star at
    // its place among the stars is the next top-level row's
    expect(rowNames()).toEqual([under(5), under(6), under(8), named(9, 'Rig'), named(10, 'Rig')])
    expect(document.activeElement).toBe(starOf(ids[9]))
  })

  it('puts a refused star back and says why, the read-only refusal included', async () => {
    const ids = await second()
    for (const [refusal, said] of [
      [new ConvexError({ code: 'not_found', message: 'project not found' }), /^Couldn't save\./],
      // the read-only refusal in its own words (convex/lib/billingAccess.ts)
      [
        new ConvexError({
          code: 'forbidden',
          reason: 'billing_required',
          message:
            'This organization is read-only. An organization admin can subscribe or update payment details in Billing.',
        }),
        /^This organization is read-only\./,
      ],
    ] as const) {
      vi.mocked(window.showToast).mockClear()
      refuseStar = refusal
      await click(starOf(ids[5]))
      await settle()
      expect(starOf(ids[5]).getAttribute('aria-pressed')).toBe('false')
      expect(starOf(ids[5]).getAttribute('aria-busy')).toBeNull()
      expect(rowNames()[0]).toBe(named(5))
      expect(String(vi.mocked(window.showToast).mock.calls[0]?.[0])).toMatch(said)
    }
    expect(favorites.size).toBe(0)
  })

  it('goes out while the snapshot is stale, and not offline, without a seat or signed out', async () => {
    const ids = await second()
    await act(async () => whole?.fail(new Error('[CONVEX Q(workspace:whole)] Server Error')))
    await settle()
    expect(store.P.snapshotTrouble()?.kind).toBe('failed')
    await click(starOf(ids[5]))
    await settle()
    expect(sentStars()).toHaveLength(1)
    expect(favorites.has(ids[5])).toBe(true)

    for (const pause of ['offline', 'no seat', 'signed out'] as const) {
      await act(async () => root.unmount())
      root = createRoot(container)
      vi.useRealTimers()
      network.mutation.mockClear()
      const next0 = base()
      const mine = top(next0, named(0))
      await load(next0)
      await render()
      if (pause === 'offline') {
        // the pause counts time by the clock
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        const { syncStatus, OFFLINE_DELAY_MS } = await import('../lib/syncStatus')
        await act(async () => syncStatus.setSocket({ connected: false, everConnected: true }))
        await wait(OFFLINE_DELAY_MS + 1)
        expect(store.P.savePause()?.kind).toBe('offline')
      } else if (pause === 'no seat') await act(async () => whole?.next(null))
      else
        await act(async () =>
          whole?.fail(new ConvexError({ code: 'forbidden', message: 'not signed in' })),
        )
      await settle()
      vi.mocked(window.showToast).mockClear()
      await click(starOf(mine))
      await settle()
      expect(sentStars(), pause).toEqual([])
      expect(starOf(mine).getAttribute('aria-pressed'), pause).toBe('false')
      expect(window.showToast, pause).toHaveBeenCalled()
    }
  })
})

describe('the search', { timeout: 60_000 }, () => {
  it('asks once typing rests, without an org_id, and lists sub-projects with their project and other organizations by name', async () => {
    const next0 = base(true)
    const sensor = top(next0, 'Luma Sensor')
    const firmware = sub(next0, sensor, 'Firmware')
    const partner = top(next0, 'Partner Firmware', { org: PARTNER })
    top(next0, 'Luma Cloud')
    await load(next0)
    await render()
    await key('firm')
    await wait(249)
    expect(asked('search')).toHaveLength(0)
    await wait(1)
    expect(asked('search').map((s) => s.args)).toEqual([{ search: 'firm' }])
    // the page's read stopped with the new list
    expect(open('projectNav:page')).toHaveLength(0)
    expect(rowNames()).toEqual(['Luma Sensor › Firmware', 'Partner FirmwarePartner Co'])
    // a sub-project row opens it and holds no star, expand button or menu
    const subRow = row(firmware)
    expect(subRow.querySelector('[data-directory-star]')).toBeNull()
    expect(subRow.querySelector('[data-directory-expand]')).toBeNull()
    expect(subRow.querySelector('[data-directory-menu]')).toBeNull()
    expect(find('[data-directory-org]', row(partner)).textContent).toBe('Partner Co')
    expect(row(partner).querySelector('[data-directory-star]')).not.toBeNull()
    await click(find('[data-directory-open]', subRow))
    expect(actions.openProject).toHaveBeenCalledWith(firmware)
    // no match says so only once the server answered
    await key('nothing like this')
    expect(end()).not.toBe('none')
    await wait(300)
    expect(end()).toBe('none')
    expect(pageText()).toContain('No projects match “nothing like this”.')
    // clearing browses again from the first page
    await key('')
    await settle()
    expect(rowNames()).toEqual(['Luma Cloud', 'Luma Sensor', 'Partner FirmwarePartner Co'])
    expect(open('projectNav:search')).toHaveLength(0)
  })

  it('keeps the newer search when two answer in the wrong order, browses on spaces and accents, and stops at the limit', async () => {
    const next0 = base()
    top(next0, 'Alpha one')
    top(next0, 'Alpha two')
    top(next0, 'Beta')
    await load(next0)
    await render()
    holding = (s) => s.name === 'projectNav:search'
    await type('alpha')
    await type('alpha two')
    const [older, newer] = asked('search')
    expect(older.open).toBe(false)
    await act(async () => answer(newer))
    await act(async () => answer(older))
    await settle()
    expect(rowNames()).toEqual(['Alpha two'])
    // a text of spaces and accents only browses
    holding = null
    await type(' ́ ')
    expect(rowNames()).toEqual(['Alpha one', 'Alpha two', 'Beta'])
    expect(asked('search')).toHaveLength(2)
    // past the limit the field says so and nothing new is asked
    await type('x'.repeat(201))
    expect(end()).toBe('too_long')
    expect(asked('search')).toHaveLength(2)
    // Escape clears the text
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => field().dispatchEvent(event))
    await settle()
    expect(field().value).toBe('')
  })

  it('tags equal names among the rows shown and the projects a sub-project names', async () => {
    const next0 = base()
    const a = top(next0, 'Test')
    const b = top(next0, 'Test')
    sub(next0, a, 'Firmware')
    sub(next0, b, 'Firmware')
    await load(next0)
    await render()
    const numOf = (id: string) => snap.projects.find((p) => p.id === id)?.num
    expect(rowNames().sort()).toEqual([`Test #${numOf(a)}`, `Test #${numOf(b)}`].sort())
    await type('firmware')
    expect(rowNames().sort()).toEqual(
      [`Test #${numOf(a)} › Firmware`, `Test #${numOf(b)} › Firmware`].sort(),
    )
  })

  it('pages through a name 200 readable sub-projects share, eight pages of 25', async () => {
    const next0 = base()
    // the figure of sub-projects one person can read at its design size,
    // at the everyday 3 a project
    let made = 0
    for (let p = 0; made < 200; p++) {
      const parent = top(next0, named(p, 'Bench'))
      for (let s = 0; s < 3 && made < 200; s++) sub(next0, parent, named(made++, 'Rig'))
    }
    await load(next0)
    await render()
    await type('rig')
    const seen: string[] = []
    for (let page = 0; page < 8; page++) {
      if (page > 0) await next()
      expect(rowIds()).toHaveLength(25)
      seen.push(...(rowIds() as string[]))
      expect(open('projectNav:search')).toHaveLength(1)
    }
    expect(new Set(seen).size).toBe(200)
    expect(document.querySelector('[data-project-directory-next]')).toBeNull()
    expect(rowNames()[24]).toMatch(/^Bench \d{3} › Rig 199$/)
  })
})

describe('the expanded list', { timeout: 60_000 }, () => {
  it('lists 30 sub-projects 25 first and the rest on Load more, and stops when collapsed or another opens', async () => {
    const next0 = base()
    const big = top(next0, 'Luma Sensor')
    // the figure of live sub-projects under one project at its design size
    for (let s = 0; s < 30; s++) sub(next0, big, named(s, 'Board'))
    const other = top(next0, 'Luma Cloud')
    sub(next0, other, 'Frontend')
    await load(next0)
    await render()
    const toggle = () => find('[data-directory-expand]', row(big))
    await click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const children = () =>
      [...document.querySelectorAll<HTMLElement>('[data-directory-child]')].map((el) =>
        el.textContent?.trim(),
      )
    expect(children()).toHaveLength(25)
    expect(children()[0]).toBe(named(0, 'Board'))
    await click(find('[data-directory-more]'))
    expect(children()).toHaveLength(30)
    expect(document.querySelector('[data-directory-more]')).toBeNull()
    expect(find('[data-directory-children-end]').dataset.directoryChildrenEnd).toBe('end')
    expect(open('projectNav:children').length).toBeGreaterThan(0)
    // another project's list replaces it, and its reads stop
    await click(find('[data-directory-expand]', row(other)))
    expect(open('projectNav:children').map((s) => s.args.project_id)).toEqual([other])
    expect(children()).toEqual(['Frontend'])
    await click(find('[data-directory-child]'))
    expect(actions.openProject).toHaveBeenCalledWith(snap.projects.at(-1)?.id)
    // collapsing stops the read
    await click(find('[data-directory-expand]', row(other)))
    expect(open('projectNav:children')).toEqual([])
    expect(document.querySelector('[data-directory-children]')).toBeNull()
    // the expanded list reads names only, never a task
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it('asks for a search past a lowered cap, says a project it cannot open, and collapses on a page move or when the row leaves', async () => {
    const next0 = base()
    const ids = Array.from({ length: 8 }, (_, n) => top(next0, named(n)))
    for (let s = 0; s < 3; s++) sub(next0, ids[0], named(s, 'Part'))
    await load(next0)
    // batches of two, and a cap of two sub-projects
    force.batch = 2
    pickLib.DIRECTORY_MOST.children = 2
    await render()
    expect(rowIds()).toEqual([ids[0], ids[1]])
    await click(find('[data-directory-expand]', row(ids[0])))
    expect(find('[data-directory-children-end]').textContent).toBe(
      'Search to find more sub-projects.',
    )
    // a project with none says so once its list ended
    await click(find('[data-directory-expand]', row(ids[1])))
    expect(find('[data-directory-children-end]').textContent).toBe('No sub-projects you can open.')
    // a page move collapses it
    await next()
    expect(rowIds()).toEqual([ids[2], ids[3]])
    expect(open('projectNav:children')).toEqual([])
    expect(document.querySelector('[data-directory-children]')).toBeNull()
    // a project the person lost since the page answered
    snap.access = snap.access.filter((a) => a.project_id !== ids[2])
    await click(find('[data-directory-expand]', row(ids[2])))
    expect(find('[data-directory-children-end]').textContent).toBe(
      'You can no longer open this project.',
    )
    // and once the page's answer leaves the row out, it collapses
    await republish()
    await settle()
    expect(rowIds()).not.toContain(ids[2])
    expect(open('projectNav:children')).toEqual([])
    expect(document.querySelector('[data-directory-children]')).toBeNull()
  })

  it('mounts its scroll marker with the first rows, so only a scroll to the end loads more', async () => {
    // IntersectionObserver reports a marker where the layout puts it as it
    // is observed, in view below an empty list and out of view below 25
    // rows, until a scroll
    let inView = true
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
          this.report(inView)
        }
        disconnect() {}
      },
    )
    const next0 = base()
    const big = top(next0, 'Luma Sensor')
    for (let s = 0; s < 30; s++) sub(next0, big, named(s, 'Board'))
    await load(next0)
    await render()
    holding = (s) => s.name === 'projectNav:children'
    await click(find('[data-directory-expand]', row(big)))
    expect(asked('children')).toHaveLength(1)
    // the first rows land and push the marker below the fold
    inView = false
    await act(async () => answer(asked('children')[0]))
    await settle()
    const later = () => asked('children').filter((s) => s.args.after !== undefined)
    expect(document.querySelectorAll('[data-directory-child]')).toHaveLength(25)
    expect(later()).toEqual([])
    // a scroll to the list's end reads the next batch
    holding = null
    await act(async () => markers.at(-1)?.(true))
    await settle()
    expect(later()).toHaveLength(1)
    expect(document.querySelectorAll('[data-directory-child]')).toHaveLength(30)
  })

  it('says a batch that stopped where it began could not be checked, with Retry', async () => {
    const next0 = base()
    const big = top(next0, 'Luma Sensor')
    for (let s = 0; s < 30; s++) sub(next0, big, named(s, 'Board'))
    await load(next0)
    await render()
    await click(find('[data-directory-expand]', row(big)))
    // the second batch's read stops where it began, checking nothing
    holding = (s) => s.name === 'projectNav:children' && s.args.after !== undefined
    await click(find('[data-directory-more]'))
    const held = subs.find(
      (s) => s.open && s.name === 'projectNav:children' && s.args.after !== undefined,
    ) as Sub
    await act(async () =>
      held.next({ state: 'ok', rows: [], next: held.args.after, stopped: true }),
    )
    await settle()
    const note = find('[data-directory-children-note]')
    expect(note.dataset.directoryChildrenNote).toBe('stuck')
    expect(note.textContent).toBe('Qivo could not check part of the sub-projects.Retry')
  })
})

describe('opening and the menu', { timeout: 60_000 }, () => {
  it('opens a project as the sidebar does, and says when the workspace does not hold it yet', async () => {
    const next0 = base()
    const plan = top(next0, 'Plan')
    await load(next0)
    // a project the server lists that the workspace has not delivered yet
    const late = top(snap, 'Late arrival')
    await render()
    await click(find('[data-directory-open]', row(plan)))
    expect(actions.openProject).toHaveBeenCalledWith(plan)
    await click(find('[data-directory-open]', row(late)))
    expect(actions.openProject).toHaveBeenCalledTimes(1)
    expect(find('[data-directory-status]').textContent).toBe(
      'Late arrival has not loaded yet. Try again in a moment.',
    )
    // People & settings names the project
    const people = [...row(plan).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('People & settings'),
    )
    await click(people)
    expect(actions.openSettings).toHaveBeenCalledWith(`project:${plan}`)
  })

  it('clears its note and goes back to the top on a page move', async () => {
    const next0 = base()
    for (let n = 0; n < 12; n++) top(next0, named(n))
    await load(next0)
    // first by name, and not yet in the workspace
    const late = top(snap, 'Late arrival')
    force.batch = 5
    await render()
    await click(find('[data-directory-open]', row(late)))
    const status = () => find('[data-directory-status]').textContent
    expect(status()).toBe('Late arrival has not loaded yet. Try again in a moment.')
    const list = find('[data-project-directory]')
    list.scrollTop = 400
    await next()
    expect(rowIds()).not.toContain(late)
    expect(status()).toBe('')
    expect(list.scrollTop).toBe(0)
  })

  it('offers New sub-project… after Archived tasks once the project’s settings allow it', async () => {
    const next0 = base()
    const led = top(next0, 'Led by me')
    const ledRow = next0.projects.find((p) => p.id === led)
    if (ledRow) ledRow.lead_id = ME
    const granted = top(next0, 'Granted')
    await load(next0)
    // one the person leads that the workspace has not delivered yet: the
    // server's settings judge it, not the workspace's grants
    const late = top(snap, 'Late led')
    const lateRow = snap.projects.find((p) => p.id === late)
    if (lateRow) lateRow.lead_id = ME
    await render()
    const items = async (id: string) => {
      await click(find('[data-directory-menu]', row(id)))
      await settle()
      const menu = find('[data-slot="popover-content"]')
      const out = [...menu.querySelectorAll('button')].map((b) => b.textContent?.trim())
      await click([...menu.querySelectorAll('button')][0])
      return out
    }
    expect(await items(led)).toEqual(['Archived tasks', 'New sub-project…'])
    expect(actions.openArchivedTasks).toHaveBeenCalledWith(led)
    expect(await items(granted)).toEqual(['Archived tasks'])
    expect(await items(late)).toEqual(['Archived tasks', 'New sub-project…'])
  })
})

describe('a kept page and a hidden tab', { timeout: 60_000 }, () => {
  it('stops every read while hidden and shows the page it was on at once on return', async () => {
    const next0 = base()
    const ids = Array.from({ length: 12 }, (_, n) => top(next0, named(n)))
    for (let s = 0; s < 3; s++) sub(next0, ids[5], named(s, 'Part'))
    await load(next0)
    force.batch = 5
    await render()
    await next()
    await click(find('[data-directory-expand]', row(ids[5])))
    const reading = () =>
      open()
        .filter((s) => isProjectNavRead(s.name))
        .map((s) => JSON.stringify([s.name, s.args]))
        .sort()
    const before = reading()
    expect(before).toHaveLength(2)
    // a hidden tab stops the reads and keeps the rows
    await setVisibility('hidden')
    expect(reading()).toEqual([])
    expect(rowNames()).toEqual([5, 6, 7, 8, 9].map((n) => named(n)))
    await setVisibility('visible')
    expect(reading()).toEqual(before)
    // another page shows: the kept page's reads stop, its rows stay
    const shown = find('[data-directory-row]')
    await render('hidden')
    expect(reading()).toEqual([])
    await render('visible')
    // the page it was on at once, the same elements, read again
    expect(find('[data-directory-row]')).toBe(shown)
    expect(rowNames()).toEqual([5, 6, 7, 8, 9].map((n) => named(n)))
    expect(reading()).toEqual(before)
    expect(document.querySelectorAll('[data-directory-child]')).toHaveLength(3)
    expect(store.__layerProbe?.asks()).toEqual([])
  })
})
