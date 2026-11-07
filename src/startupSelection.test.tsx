// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import type { UIPrefs } from './store/preferences'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  NAV_UNCHECKED,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'
import { taskRow } from './views/boardFixture.setup'

/* Startup selection on the real store and App (App.tsx opening,
   components/ProjectChooser.tsx). The workspace comes through the live
   double, the navigation reads from their stand-in over the server's copy
   (store/projectNavStandIn.setup.ts, with `force`), and projectNav.resolve,
   a one-shot query, from the same stand-in, which a case can hold back,
   fail or answer itself. The remembered project comes from the server's
   preferences (prefs:get), never the browser's copy, and a write of it
   goes out at once (prefs:save). Every subscription is logged in order with
   resolve's answer, so a case can tell that no view read anything before
   the server said the person may open the project.

   The person holds a user seat in Testbed Labs, with Luma Sensor and its
   sub-projects Firmware and Electronics, and one in Partner Co, with
   Partner portal and Portal API. A case raises at most one figure to its
   design size: 200 top-level projects with no sub-projects beside them, or
   30 sub-projects under one project; the picker's bound is lowered, never
   reached by seeding. Settings is a stand-in that only reports a project
   the person archived or deleted (onProjectGone). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => ({
  convex: network,
  live: (await import('./store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
// what Settings told App of a project the person archived or deleted, as
// the stand-in's buttons send it
const settings = vi.hoisted(() => ({ gone: { id: '', parent: null as string | null } }))
vi.mock('./panels/Settings', async () => {
  const { Button } = await import('./components/ui/button')
  return {
    SettingsScreen: ({
      onExit,
      onProjectGone,
    }: {
      onExit: () => void
      onProjectGone?: (id: string, parent: string | null) => void
    }) => (
      <div data-settings-stand-in>
        <Button
          type="button"
          data-gone
          onClick={() => onProjectGone?.(settings.gone.id, settings.gone.parent)}
        >
          Gone
        </Button>
        <Button type="button" data-exit onClick={onExit}>
          Exit
        </Button>
      </div>
    ),
  }
})

const NOW = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let phone = false
// what the server holds, the workspace last published
let server: Snapshot
let publish: (next: Snapshot) => void
let force: ForcedProjectNav
// every subscription App opened, and resolve's asks and answers, in order
let log: { name: string; args: unknown; at: number }[]
let asks: { args: unknown; at: number }[]
let answeredAt: number[]
let tick: number
// resolve waits for this while set, and answers this when set
let hold: Promise<void> | null
let resolveWith: ((args: unknown) => unknown) | null
// the server's preferences row, and what prefs:save sent
let prefs: Record<string, unknown> | null
let saves: Record<string, unknown>[]
// the task window's reads of a task the workspace does not hold
let windowReads: ((value: unknown) => void)[]
// what App remembered through the store (P.saveUINow)
let remembers: MockInstance<(patch: UIPrefs) => void>
let store: typeof import('./store/planner')
let pickLib: typeof import('./lib/projectPick')
let ORG: string
let ME: string
let PARTNER: string
let SEAT: string
let LUMA: string
let FW: string
let PORTAL: string

let num = 10
/** Adds a top-level project of `org` to `next`, with a grant for the
    person's seat there unless `grant` is false, answering its id. */
function meta(next: Snapshot, name: string, org = ORG, grant = true) {
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
  if (seat && grant) next.access.push({ project_id: id, profile_id: seat.id, level: 'user' })
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

/** The person's two seats, with `projects` false none of their projects.
    Luma Sensor is number 10, Firmware 11, Electronics 12, Partner portal 13
    and Portal API 14, and a project a case adds takes the next. */
function world(o: { role?: 'user' | 'admin'; projects?: boolean } = {}): Snapshot {
  num = 10
  const next = plannerFixture()
  ORG = next.orgs[0].id
  ME = next.profiles[0].id
  next.profiles[0] = { ...next.profiles[0], org_role: o.role ?? 'user' }
  next.projects = []
  PARTNER = crypto.randomUUID()
  SEAT = crypto.randomUUID()
  next.orgs.push({ ...next.orgs[0], id: PARTNER, name: 'Partner Co', slug: 'partner' })
  next.profiles.push({ ...next.profiles[0], id: SEAT, org_id: PARTNER, org_role: 'user' })
  next.myProfileIds.push(SEAT)
  if (o.projects === false) return next
  LUMA = meta(next, 'Luma Sensor')
  FW = sub(next, LUMA, 'Firmware')
  sub(next, LUMA, 'Electronics')
  PORTAL = meta(next, 'Partner portal', PARTNER)
  sub(next, PORTAL, 'Portal API')
  return next
}

/** What the person remembered, as the server's preferences row holds it. */
const remembering = (project: string, org = ORG) => ({
  lastProject: { org_id: org, project_id: project },
})

/** Boots the real store on `snap` with the server's preferences `row`
    and renders App at `path`, after `before` has run on the new modules. */
async function app(
  snap: Snapshot,
  path = '/app/testbed',
  row: Record<string, unknown> = {},
  before: () => void = () => {},
) {
  vi.resetModules()
  history.replaceState(null, '', path)
  server = snap
  prefs = row
  saves = []
  windowReads = []
  log = []
  asks = []
  answeredAt = []
  tick = 0
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    log.push({ name, args, at: ++tick })
    if (name === 'workspace:whole') {
      publish = (value) => {
        server = value
        next(structuredClone(value))
      }
      publish(snap)
    } else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(server, name, args, next, fail)
    else if (isProjectNavRead(name)) answerProjectNav(server, name, args, next, fail, { force })
    else if (name === 'taskWindow:task') windowReads.push(next)
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'prefs:get')
      return prefs && Object.keys(prefs).length ? { profile_id: ME, prefs, updated_at: NOW } : null
    if (name !== 'projectNav:resolve') return null
    asks.push({ args, at: ++tick })
    if (hold) await hold
    const answer = resolveWith ? resolveWith(args) : queryProjectNav(server, name, args, { force })
    answeredAt.push(++tick)
    return answer
  })
  // the preferences this person's store sends, not a store an earlier
  // case left with a save on its way
  network.mutation.mockImplementation(async (ref, args) => {
    if (getFunctionName(ref) === 'prefs:save' && args.profile_id === ME)
      saves.push(args.prefs as Record<string, unknown>)
    return null
  })
  store = await import('./store/planner')
  remembers = vi.spyOn(store.P, 'saveUINow')
  await store.initStore()
  pickLib = await import('./lib/projectPick')
  before()
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
}

/** Holds resolve's answers until the answer it returns is called. */
function holdResolve() {
  let release = () => {}
  hold = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    hold = null
    await act(async () => release())
    await settle()
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
/** Waits for `find` to hold, through lazy views that can take seconds. */
const until = (find: () => unknown, what: string) =>
  vi.waitFor(
    () => {
      if (!find()) throw new Error(`missing ${what}`)
    },
    { timeout: 10_000 },
  )
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const chooserState = () => q('[data-project-chooser]')?.getAttribute('data-project-chooser-state')
const chooser = (state: string) => until(() => chooserState() === state, `the ${state} chooser`)
const line = () => q('[data-project-chooser-line]')?.textContent
const note = () => q('[data-project-chooser-note]')?.textContent
const shown = () => q('[data-workspace-view]')?.getAttribute('data-workspace-view')
const picks = () =>
  [...document.querySelectorAll<HTMLElement>('[data-project-chooser] [data-project-pick]')].map(
    (b) => b.dataset.projectPick,
  )
/** The reads of the Overview, the Board and the Roadmap App opened. */
const viewReads = () =>
  log.filter(
    (s) =>
      s.name === 'tasks:board' ||
      s.name.startsWith('tasks:roadmap') ||
      s.name.startsWith('overview:'),
  )
/** The projects App remembered, in order, each sent at once
    (P.saveUINow), and null for a write that cleared it. */
const sentProjects = () =>
  remembers.mock.calls.flatMap(([patch]) =>
    'lastProject' in patch ? [patch.lastProject?.project_id ?? null] : [],
  )
const lastSent = () => sentProjects().at(-1)
async function click(element: Element | null | undefined) {
  if (!element) throw new Error('nothing to click')
  await act(async () => (element as HTMLElement).click())
  await settle()
}
/** Goes to `address` as Back or Forward would. */
const go = (address: string) =>
  act(async () => {
    history.pushState(null, '', address)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
/** Unmounts App, as leaving the page does, and clears the browser's copy
    of the preferences, so the next boot reads the server's alone. */
async function leave() {
  await act(async () => root.unmount())
  root = createRoot(container)
  localStorage.clear()
}

beforeEach(() => {
  phone = false
  force = {}
  hold = null
  resolveWith = null
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  localStorage.clear()
  if (pickLib) Object.assign(pickLib.PROJECT_PICKER_MOST, { list: 200, children: 50 })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('opening the remembered project', { timeout: 60_000 }, () => {
  it('opens a remembered project of either seat, and a sub-project, after one resolve of its id, before any view reads', async () => {
    const snap = world()
    for (const [id, org] of [
      [LUMA, ORG],
      [PORTAL, PARTNER],
      [FW, ORG],
    ] as const) {
      const release = holdResolve()
      await app(structuredClone(snap), '/app/testbed', remembering(id, org))
      const entries = history.length
      await chooser('checking')
      const name = snap.projects.find((p) => p.id === id)?.name
      expect(line()).toBe(`Opening ${name}…`)
      expect(asks.map((a) => a.args)).toEqual([{ project_id: id }])
      expect(viewReads()).toEqual([])
      expect(q('[data-project-picker]')).toBeNull()
      await release()
      await until(() => shown() === 'overview', 'the Overview')
      const p = store.P.project(id)
      expect(location.pathname).toBe(
        `/app/${org === ORG ? 'testbed' : 'partner'}/overview/p/${p?.num}`,
      )
      // the address became the view's in place, and nothing more was asked
      expect(history.length).toBe(entries)
      expect(asks).toHaveLength(1)
      // the view's reads start only after the answer
      await until(() => viewReads().length > 0, "the Overview's reads")
      expect(viewReads()[0].at).toBeGreaterThan(answeredAt[0])
      // unchanged, so not sent again
      expect(sentProjects()).toEqual([])
      await leave()
    }
  })

  it('shows the chooser when the remembered project is no longer available, and never another project', async () => {
    const snap = world()
    const archived = meta(snap, 'Old programme')
    const project = snap.projects.find((p) => p.id === archived)
    if (project) project.archived_at = NOW
    const lost = meta(snap, 'Taken away', ORG, false)
    for (const id of [archived, crypto.randomUUID(), lost]) {
      await app(structuredClone(snap), '/app/testbed', remembering(id))
      await chooser('lost')
      expect(note()).toBe('The project you opened last is no longer available to you.')
      await until(() => picks().length === 2, 'the two seats’ projects')
      expect(shown()).toBeUndefined()
      expect(viewReads()).toEqual([])
      expect(location.pathname).toBe('/app/testbed')
      // a loss leaves what is remembered
      expect(sentProjects()).toEqual([])
      expect(store.P.loadUI().lastProject?.project_id).toBe(id)
      await leave()
    }
  })

  it('says a check that could not finish with Retry, never the chooser or a view, and opens once Retry gets ok', async () => {
    const snap = world()
    force = { unchecked: NAV_UNCHECKED }
    await app(snap, '/app/testbed', remembering(LUMA))
    await chooser('retry')
    expect(line()).toBe(NAV_UNCHECKED)
    expect(q('[data-project-picker]')).toBeNull()
    expect(viewReads()).toEqual([])
    await leave()
    // a failed read
    force = {}
    resolveWith = () => {
      throw new Error('the read failed')
    }
    await app(snap, '/app/testbed', remembering(LUMA))
    await chooser('retry')
    expect(line()).toBe("Couldn't check the project you opened last.")
    expect(q('[data-project-picker]')).toBeNull()
    expect(shown()).toBeUndefined()
    // the sidebar stays usable meanwhile
    expect(q('aside [data-mine-nav]')).not.toBeNull()
    resolveWith = null
    await click(q('[data-project-chooser-retry]'))
    await until(() => shown() === 'overview', 'the Overview')
    expect(asks).toHaveLength(2)
    expect(location.pathname).toBe('/app/testbed/overview/p/10')
  })

  it("says Couldn't open with Retry where the server says ok and the current workspace lacks the project", async () => {
    const snap = world()
    // the server holds a project the workspace's delivery has not brought
    const held = structuredClone(snap)
    const late = meta(held, 'Late programme')
    resolveWith = (args) => queryProjectNav(held, 'projectNav:resolve', args)
    await app(snap, '/app/testbed', remembering(late))
    await chooser('retry')
    expect(line()).toBe("Couldn't open Late programme.")
    expect(q('[data-project-picker]')).toBeNull()
    expect(shown()).toBeUndefined()
    expect(viewReads()).toEqual([])
    // Retry asks again, and opens once the delivery brought it
    resolveWith = (args) => {
      publish({ ...held, delivered_at: '2026-09-15T09:00:00.000Z' })
      return queryProjectNav(held, 'projectNav:resolve', args)
    }
    await click(q('[data-project-chooser-retry]'))
    await until(() => shown() === 'overview', 'the Overview')
    expect(asks).toHaveLength(2)
    expect(store.P.scopeInfo(late)?.name).toBe('Late programme')
  })

  it('drops a check’s answer once the person moved to another address meanwhile', async () => {
    const release = holdResolve()
    await app(world(), '/app/testbed', remembering(LUMA))
    await chooser('checking')
    // Back or Forward reaches an address under a slug this login cannot
    // resolve, which shows the chooser with its note and checks nothing
    await go('/app/globex/board/p/3')
    await chooser('lost')
    await release()
    expect(chooserState()).toBe('lost')
    expect(note()).toBe('That project is not available to you.')
    expect(shown()).toBeUndefined()
    expect(viewReads()).toEqual([])
  })

  it('keeps the remembered project for a task address of a task in it, else opens the task’s sub-project, checking nothing', async () => {
    const snap = world()
    // QN-7 in Firmware, which the workspace holds from its boot
    snap.orgs[0].next_issue_num = 8
    snap.issues.push({
      ...taskRow(snap, '01000000-0000-4000-8000-000000000007', 'todo', 7),
      project_id: FW,
    })
    for (const [id, org, name] of [
      [LUMA, ORG, 'Luma Sensor'],
      [PORTAL, PARTNER, 'Firmware'],
    ] as const) {
      await app(structuredClone(snap), '/app/testbed/board/tasks/qn-7', remembering(id, org))
      await until(() => shown() === 'kanban', 'the Board')
      expect(q('[data-scope-crumb] h1')?.textContent).toBe(name)
      expect(asks).toEqual([])
      // a task's address chose the scope, so nothing is remembered
      expect(sentProjects()).toEqual([])
      if (id === LUMA) await leave()
    }
    // the person's own press on the scope the task chose remembers it
    await until(() => q(`aside [data-subproject-row="${FW}"] > button`), "Firmware's row")
    await click(q(`aside [data-subproject-row="${FW}"] > button`))
    await until(() => lastSent() === FW, 'Firmware remembered')
  })

  it('never restores a saved All projects or My view, and lets an address that names a scope win', async () => {
    const snap = world()
    for (const scope of ['all', 'mine']) {
      await app(structuredClone(snap), '/app/testbed', { scope, view: 'kanban' })
      await chooser('choose')
      expect(asks).toEqual([])
      expect(location.pathname).toBe('/app/testbed')
      await leave()
    }
    await app(structuredClone(snap), '/app/testbed/board/mine', remembering(LUMA))
    await until(() => shown() === 'kanban', 'My view’s Board')
    expect(location.pathname).toBe('/app/~/board/mine')
    await leave()
    await app(structuredClone(snap), '/app/~/board/all', remembering(LUMA))
    await until(() => shown() === 'kanban', 'All projects’ Board')
    expect(location.pathname).toBe('/app/~/board/all')
    await leave()
    // a held project's address opens it, with no check, and is remembered
    await app(structuredClone(snap), '/app/partner/roadmap/p/13', remembering(LUMA))
    await until(() => shown() === 'roadmap', 'the Roadmap')
    expect(asks).toEqual([])
    await until(() => lastSent() === PORTAL, 'Partner portal remembered')
  })
})

describe('the chooser', { timeout: 60_000 }, () => {
  it('lists both seats’ projects with no fixed row, and a pick opens on the view shown, remembered, in place', async () => {
    const snap = world()
    await app(snap, '/app/testbed', { view: 'kanban' })
    await chooser('choose')
    await until(() => picks().length === 2, 'the rows')
    expect(picks()).toEqual([LUMA, PORTAL])
    expect(q('[data-project-chooser] [data-project-pick-org]')?.textContent).toBe('Partner Co')
    expect(q('[data-project-pick-all]')).toBeNull()
    expect(asks).toEqual([])
    // one h1, the top bar's, which names the chooser
    expect([...document.querySelectorAll('h1')].map((h) => h.textContent)).toEqual([
      'Choose a project',
    ])
    expect(q('[data-view-switch]')).not.toBeNull()
    expect(q('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens on the Board.',
    )
    // showing the chooser writes nothing
    expect(sentProjects()).toEqual([])
    const entries = history.length
    await click(q(`[data-project-pick="${PORTAL}"]`))
    await until(() => shown() === 'kanban', 'the Board')
    expect(location.pathname).toBe('/app/partner/board/p/13')
    expect(history.length).toBe(entries)
    await until(() => lastSent() === PORTAL, 'the pick remembered')
    expect(saves.at(-1)?.lastProject).toEqual({ org_id: PARTNER, project_id: PORTAL })
  })

  it('shows the chooser again when Forward returns to its entry, which Back left for the Inbox', async () => {
    const snap = world()
    await app(snap, '/app/testbed', { view: 'kanban' })
    await chooser('choose')
    // the Inbox takes the chooser's entry in place
    await click(q('[data-view-switch] [aria-label^="Inbox"]'))
    await until(() => location.pathname === '/app/~/inbox', 'the Inbox')
    expect(q('[data-project-chooser]')).toBeNull()
    // a view pill leaves the Inbox for the chooser, in an entry of its own
    await click(
      [...document.querySelectorAll('[data-view-switch] button')].find(
        (b) => b.textContent?.trim() === 'Roadmap',
      ),
    )
    await chooser('choose')
    expect(location.pathname).toBe('/app/testbed')
    const entries = history.length
    await act(async () => history.back())
    await settle()
    await until(() => location.pathname === '/app/~/inbox', 'the Inbox again')
    expect(q('[data-project-chooser]')).toBeNull()
    // Forward shows the chooser on the view it showed, at its own address
    await act(async () => history.forward())
    await settle()
    await chooser('choose')
    expect(location.pathname).toBe('/app/testbed')
    expect(q('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens on the Roadmap.',
    )
    expect(history.length).toBe(entries)
    expect(asks).toEqual([])
    expect(viewReads()).toEqual([])
  })

  it('keeps the filters through a loss and the pick that follows', async () => {
    const snap = world()
    await app(snap, `/app/testbed/board/p/10`)
    await until(() => q('[data-filter-search] input'), 'the filter row')
    const field = q<HTMLInputElement>('[data-filter-search] input')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'flash',
      )
      field?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Luma Sensor's grant goes
    publish({
      ...server,
      access: server.access.filter((a) => a.project_id !== LUMA),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await chooser('lost')
    expect(note()).toBe('Luma Sensor is no longer available to you.')
    expect(location.pathname).toBe('/app/testbed')
    await until(() => picks().includes(PORTAL), 'Partner portal')
    await click(q(`[data-project-pick="${PORTAL}"]`))
    await until(
      () => q<HTMLInputElement>('[data-filter-search] input')?.value === 'flash',
      'the filter',
    )
  })

  it('on the phone, opens the Inbox at a bare address with no check, and shows the chooser elsewhere without a keyboard', async () => {
    phone = true
    const snap = world()
    await app(structuredClone(snap), '/app/testbed', remembering(LUMA))
    await until(
      () => q('[data-inbox-list]') || document.body.textContent?.includes('Inbox'),
      'the Inbox',
    )
    await settle()
    // no tab leads to the scope beneath the Inbox, so nothing is checked
    expect(asks).toEqual([])
    expect(q('[data-project-chooser]')).toBeNull()
    await leave()
    await app(structuredClone(snap), '/app/testbed/board')
    await chooser('choose')
    await until(() => q('[data-project-picker-search]'), 'the field')
    expect(document.activeElement).not.toBe(q('[data-project-picker-search]'))
    expect(q('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens in its task list.',
    )
    // a pick opens the project's task list, whatever view the address named
    await leave()
    await app(structuredClone(snap), '/app/testbed/roadmap')
    await chooser('choose')
    await until(() => picks().includes(LUMA), 'Luma Sensor')
    await click(q(`[data-project-pick="${LUMA}"]`))
    await until(() => location.pathname === '/app/testbed/board/p/10', "Luma Sensor's task list")
  })

  it('takes focus in its field on a desktop where focus is nowhere', async () => {
    await app(world(), '/app/testbed')
    await chooser('choose')
    await until(() => q('[data-project-picker-search]'), 'the field')
    expect(document.activeElement).toBe(q('[data-project-picker-search]'))
  })
})

describe('what is remembered', { timeout: 60_000 }, () => {
  it('is written by a project address, a sidebar row and a directory row, and never by My view, the directory, All projects or Team sync', async () => {
    const snap = world()
    await app(snap, '/app/testbed/overview/p/10')
    await until(() => lastSent() === LUMA, 'the address remembered')
    // My view, the directory, an All projects address and Team sync leave it
    await click(q('aside [data-mine-nav]'))
    await until(() => location.pathname === '/app/~/overview/mine', 'My view')
    await click(q('aside [data-all-nav]'))
    await until(() => location.pathname === '/app/~/projects', 'the directory')
    await go('/app/~/board/all')
    await until(() => shown() === 'kanban', 'All projects')
    await click(q('aside [data-sync-nav]'))
    await until(() => location.pathname.includes('/sync'), 'Team sync')
    await settle()
    expect(sentProjects()).toEqual([LUMA])
    // a sidebar row
    await until(() => q(`aside [data-project-row="${PORTAL}"] button`), "the tree's row")
    await click(q(`aside [data-project-row="${PORTAL}"] button`))
    await until(() => lastSent() === PORTAL, 'the row remembered')
    // a directory row
    await click(q('aside [data-all-nav]'))
    await until(() => q(`[data-directory-row="${LUMA}"] [data-directory-open]`), 'the row')
    await click(q(`[data-directory-row="${LUMA}"] [data-directory-open]`))
    await until(() => lastSent() === LUMA, 'the directory row remembered')
    expect(sentProjects()).toEqual([LUMA, PORTAL, LUMA])
  })
})

describe('at the design size', { timeout: 60_000 }, () => {
  /** 200 live top-level projects of the home organization, named in
      order, with no sub-projects, answering their ids in name order. */
  function manyProjects() {
    const next = world({ projects: false })
    const ids: string[] = []
    for (let n = 0; n < 200; n++)
      ids.push(meta(next, `Sensor programme ${String(n).padStart(3, '0')}`))
    return { next, ids }
  }

  it('opens a remembered project that sorts 150th after one resolve, with no picker and no view read before', async () => {
    const { next, ids } = manyProjects()
    const release = holdResolve()
    await app(next, '/app/testbed', remembering(ids[149]))
    await chooser('checking')
    expect(line()).toBe('Opening Sensor programme 149…')
    expect(q('[data-project-picker]')).toBeNull()
    expect(viewReads()).toEqual([])
    await release()
    await until(() => shown() === 'overview', 'the Overview')
    expect(asks.map((a) => a.args)).toEqual([{ project_id: ids[149] }])
    await until(() => viewReads().length > 0, "the Overview's reads")
    expect(viewReads()[0].at).toBeGreaterThan(answeredAt[0])
  })

  it('lists 25 at first, 50 with Load more, and then asks for a search at a lowered bound', async () => {
    const { next } = manyProjects()
    await app(next, '/app/testbed', {}, () => {
      Object.assign(pickLib.PROJECT_PICKER_MOST, { list: 50 })
    })
    await chooser('choose')
    await until(() => picks().length === 25, 'the first batch')
    await click(q('[data-project-chooser] [data-project-picker-more]'))
    await until(() => picks().length === 50, 'the second batch')
    await until(() => q('[data-project-picker-note="full"]'), 'the bound line')
    expect(q('[data-project-picker-note="full"]')?.textContent).toBe(
      'Search to find more projects.',
    )
  })

  it('opens a remembered 28th of 30 sub-projects after one resolve, with no picker and no view read before', async () => {
    const next = world()
    // Luma Sensor's 30 sub-projects, the design size, in place of its two
    next.projects = next.projects.filter((p) => p.parent_id !== LUMA)
    const kids: string[] = []
    for (let n = 1; n <= 30; n++) kids.push(sub(next, LUMA, `Module ${String(n).padStart(2, '0')}`))
    const release = holdResolve()
    await app(next, '/app/testbed', remembering(kids[27]))
    await chooser('checking')
    expect(line()).toBe('Opening Module 28…')
    expect(q('[data-project-picker]')).toBeNull()
    expect(viewReads()).toEqual([])
    await release()
    await until(() => shown() === 'overview', 'the Overview')
    expect(store.P.scopeInfo(kids[27])?.name).toBe('Module 28')
    expect(asks.map((a) => a.args)).toEqual([{ project_id: kids[27] }])
  })
})

describe('the empty end', { timeout: 60_000 }, () => {
  it('shows the empty state with the directory’s words and New project only where the list ended confirmed empty', async () => {
    const member =
      'You have no active projects. Ask an organization admin or a project lead for access.'
    await app(world({ projects: false }), '/app/testbed')
    await chooser('empty')
    expect(q('[data-project-chooser]')?.textContent).toContain(member)
    expect(q('[data-project-chooser]')?.textContent).toContain('New project')
    await leave()
    await app(world({ role: 'admin', projects: false }), '/app/testbed')
    await chooser('empty')
    expect(q('[data-project-chooser]')?.textContent).toContain(
      `${member} Settings › Projects › All projects lists every project of your organization.`,
    )
    // a list held back or failing never shows it
    for (const held of [{ notReady: true }, { fail: true }] as ForcedProjectNav[]) {
      await leave()
      force = held
      await app(world({ projects: false }), '/app/testbed')
      await chooser('choose')
      await until(() => q('[data-project-picker-note]'), 'the note')
      expect(q('[data-empty-state]')).toBeNull()
    }
  })
})

describe('the access guard and Settings', { timeout: 60_000 }, () => {
  it('shows the chooser with a note when the scope goes, its sub-project too, and leaves My view and All projects', async () => {
    const snap = world()
    // the project removed from the workspace
    await app(structuredClone(snap), '/app/testbed/board/p/10')
    await until(() => shown() === 'kanban', 'the Board')
    publish({
      ...server,
      projects: server.projects.filter((p) => p.id !== LUMA && p.parent_id !== LUMA),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await chooser('lost')
    expect(note()).toBe('Luma Sensor is no longer available to you.')
    expect(store.P.project(PORTAL)).toBeDefined()
    expect(location.pathname).toBe('/app/testbed')
    // the loss leaves what is remembered
    expect(sentProjects()).toEqual([LUMA])
    await leave()
    // an archived sub-project
    await app(structuredClone(snap), `/app/testbed/board/p/11`)
    await until(() => shown() === 'kanban', 'the Board')
    publish({
      ...server,
      projects: server.projects.filter((p) => p.id !== FW),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await chooser('lost')
    expect(note()).toBe('Firmware is no longer available to you.')
    await leave()
    // the scope's top-level project gone while the workspace still holds
    // the sub-project, which the person holds a grant on of its own
    const direct = structuredClone(snap)
    direct.access.push({ project_id: FW, profile_id: ME, level: 'user' })
    await app(direct, `/app/testbed/board/p/11`)
    await until(() => shown() === 'kanban', 'the Board')
    publish({
      ...server,
      projects: server.projects.filter((p) => p.id !== LUMA),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await chooser('lost')
    expect(note()).toBe('Firmware is no longer available to you.')
    await leave()
    // a sub-project the person lost under a parent they still see
    const granted = structuredClone(snap)
    granted.access = granted.access.filter((a) => a.project_id !== LUMA)
    granted.access.push({ project_id: FW, profile_id: ME, level: 'user' })
    const elsewhere = sub(granted, LUMA, 'Elsewhere')
    granted.access.push({ project_id: elsewhere, profile_id: ME, level: 'user' })
    await app(granted, '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', 'the Board')
    publish({
      ...server,
      access: server.access.filter((a) => a.project_id !== FW),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await chooser('lost')
    expect(store.P.canSee(LUMA)).toBe(true)
    expect(note()).toBe('Firmware is no longer available to you.')
    await leave()
    // My view and the All projects address stay as they are
    for (const address of ['/app/~/board/mine', '/app/~/board/all']) {
      await app(structuredClone(snap), address)
      await until(() => shown() === 'kanban', 'the Board')
      publish({ ...server, access: [], delivered_at: '2026-09-15T09:00:00.000Z' })
      await settle()
      expect(location.pathname).toBe(address)
      expect(q('[data-project-chooser]')).toBeNull()
      await leave()
    }
  })

  it("moves to the gone project's parent from Settings, else to the chooser without a note, and leaves the scope for another project's archive", async () => {
    const snap = world()
    await app(snap, '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', 'the Board')
    const settingsThen = async (
      gone: { id: string; parent: string | null },
      whileOpen: () => void = () => {},
    ) => {
      settings.gone = gone
      await click(q('aside [data-settings-nav]'))
      await until(() => q('[data-gone]'), 'Settings')
      await click(q('[data-gone]'))
      whileOpen()
      await click(q('[data-exit]'))
    }
    // another project's archive leaves the scope
    await settingsThen({ id: PORTAL, parent: null })
    await until(() => shown() === 'kanban', 'the Board')
    expect(location.pathname).toBe('/app/testbed/board/p/11')
    // the scope's own archive moves to its parent, which is remembered only
    // once its view shows, never under Settings
    await settingsThen({ id: FW, parent: LUMA }, () => expect(sentProjects()).toEqual([FW]))
    await until(() => location.pathname === '/app/testbed/board/p/10', "the parent's Board")
    await until(() => lastSent() === LUMA, 'the parent remembered')
    // the top-level project's own archive shows the chooser with no note
    await settingsThen({ id: LUMA, parent: null })
    await chooser('choose')
    expect(note()).toBe('')
  })

  it('takes the note the guard showed away when a delete’s delivery landed before its answer', async () => {
    const snap = world()
    await app(snap, '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', 'the Board')
    settings.gone = { id: FW, parent: LUMA }
    await click(q('aside [data-settings-nav]'))
    await until(() => q('[data-gone]'), 'Settings')
    // the delivery without Firmware lands first
    publish({
      ...server,
      projects: server.projects.filter((p) => p.id !== FW),
      delivered_at: '2026-09-15T09:00:00.000Z',
    })
    await settle()
    await click(q('[data-gone]'))
    await click(q('[data-exit]'))
    await until(() => location.pathname === '/app/testbed/board/p/10', "the parent's Board")
    expect(q('[data-project-chooser]')).toBeNull()
  })
})

describe('a project address the workspace does not hold', { timeout: 60_000 }, () => {
  it('checks it by organization and number, holding the address, and opens it once held', async () => {
    const snap = world()
    const held = structuredClone(snap)
    snap.projects = snap.projects.filter((p) => p.id !== PORTAL && p.parent_id !== PORTAL)
    // the server says ok, and the delivery that brings it lands with it
    resolveWith = (args) => {
      publish({ ...held, delivered_at: '2026-09-15T09:00:00.000Z' })
      return queryProjectNav(held, 'projectNav:resolve', args)
    }
    const release = holdResolve()
    await app(snap, '/app/partner/board/p/13')
    await chooser('checking')
    expect(line()).toBe('Opening that project…')
    expect(asks.map((a) => a.args)).toEqual([{ org_id: PARTNER, num: 13 }])
    expect(location.pathname).toBe('/app/partner/board/p/13')
    const entries = history.length
    await release()
    await until(() => shown() === 'kanban', 'the Board')
    expect(location.pathname).toBe('/app/partner/board/p/13')
    expect(history.length).toBe(entries)
  })

  it('shows the chooser with a note where it is not available, asks by uuid, and reads nothing under an unknown slug', async () => {
    const snap = world()
    await app(structuredClone(snap), '/app/testbed/board/p/99')
    await chooser('lost')
    expect(note()).toBe('That project is not available to you.')
    expect(asks.map((a) => a.args)).toEqual([{ org_id: ORG, num: 99 }])
    expect(location.pathname).toBe('/app/testbed')
    await leave()
    const far = crypto.randomUUID()
    await app(structuredClone(snap), `/app/testbed/board/p/${far}`)
    await chooser('lost')
    expect(asks.map((a) => a.args)).toEqual([{ project_id: far }])
    await leave()
    await app(structuredClone(snap), '/app/globex/board/p/3', remembering(LUMA))
    await chooser('lost')
    expect(note()).toBe('That project is not available to you.')
    expect(asks).toEqual([])
  })

  it('keeps the address through a failed check and Retry, and checks one Back or Forward reaches in its own entry', async () => {
    const snap = world()
    resolveWith = () => {
      throw new Error('the read failed')
    }
    await app(structuredClone(snap), '/app/testbed/board/p/99')
    await chooser('retry')
    expect(line()).toBe("Couldn't check that project.")
    expect(location.pathname).toBe('/app/testbed/board/p/99')
    await click(q('[data-project-chooser-retry]'))
    await chooser('retry')
    expect(asks).toHaveLength(2)
    expect(location.pathname).toBe('/app/testbed/board/p/99')
    // Back or Forward from a project to an address the workspace does not
    // hold checks it, and its answer takes that entry, pushing none
    resolveWith = null
    await go('/app/testbed/board/p/10')
    await until(() => shown() === 'kanban', "Luma Sensor's Board")
    await go('/app/testbed/board/p/99')
    const entries = history.length
    await chooser('lost')
    expect(note()).toBe('That project is not available to you.')
    expect(asks.map((a) => a.args)).toEqual([
      { org_id: ORG, num: 99 },
      { org_id: ORG, num: 99 },
      { org_id: ORG, num: 99 },
    ])
    expect(location.pathname).toBe('/app/testbed')
    expect(history.length).toBe(entries)
    // and one the server says the person may open opens in it, in place
    const held = structuredClone(server)
    server.projects = server.projects.filter((p) => p.id !== PORTAL && p.parent_id !== PORTAL)
    publish({ ...server, delivered_at: '2026-09-15T09:00:00.000Z' })
    resolveWith = (args) => {
      publish({ ...held, delivered_at: '2026-09-15T10:00:00.000Z' })
      return queryProjectNav(held, 'projectNav:resolve', args)
    }
    await go('/app/partner/roadmap/p/13')
    const now = history.length
    await until(() => shown() === 'roadmap', "Partner portal's Roadmap")
    expect(asks.at(-1)?.args).toEqual({ org_id: PARTNER, num: 13 })
    expect(location.pathname).toBe('/app/partner/roadmap/p/13')
    expect(history.length).toBe(now)
  })
})

describe('a task address the workspace does not hold', { timeout: 60_000 }, () => {
  /** The task window's answer for QN-7 in Firmware, or `state`. */
  const taskAnswer = (state?: string) => {
    if (state) return { state }
    const row = {
      id: '01000000-0000-4000-8000-000000000007',
      org_id: ORG,
      project_id: FW,
      num: 7,
      title: 'Flash the bootloader',
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    }
    return {
      state: 'ok',
      task: { ...row, has_subtasks: false },
      level: 'lead',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    }
  }

  it('boots with no scope and no check, lets the task name its project, and remembers nothing', async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
    try {
      await app(world(), '/app/testbed/board/tasks/qn-7', remembering(PORTAL, PARTNER))
      await until(() => windowReads.length > 0, "the window's read")
      await settle()
      // the remembered project waits, unchecked and unopened
      expect(asks).toEqual([])
      expect(viewReads()).toEqual([])
      expect(q('[data-project-chooser]')).toBeNull()
      await act(async () => {
        for (const read of windowReads) read(taskAnswer())
      })
      await until(() => shown() === 'kanban', "Firmware's Board")
      expect(store.P.scopeInfo(FW)).not.toBeNull()
      expect(asks).toEqual([])
      // a task's address chose it, so it is not remembered
      expect(sentProjects()).toEqual([])
    } finally {
      TASKS.atBoot = true
    }
  })

  it('takes the startup rule once the task names no project', async () => {
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
    try {
      await app(world(), '/app/testbed/board/tasks/qn-7', remembering(PORTAL, PARTNER))
      await until(() => windowReads.length > 0, "the window's read")
      await act(async () => {
        for (const read of windowReads) read(taskAnswer('unavailable'))
      })
      await until(() => asks.length === 1, 'the check of the remembered project')
      expect(asks[0].args).toEqual({ project_id: PORTAL })
      await until(() => shown() === 'kanban', "Partner portal's Board")
    } finally {
      TASKS.atBoot = true
    }
  })
})

describe('an open or a check that waits, and the person’s next move', { timeout: 60_000 }, () => {
  /** `snap` and a copy whose Late programme the server lists and opens
      while the workspace's delivery has not brought it, with the copy's
      delivery a moment later. */
  function lateWorld() {
    const snap = world()
    const held = structuredClone(snap)
    const late = meta(held, 'Late programme')
    return { snap, held, late }
  }
  let hour = 9
  /** Delivers `value` to the workspace, newer than the delivery before. */
  const deliver = (value: Snapshot) =>
    publish({
      ...structuredClone(value),
      delivered_at: `2026-09-15T${String(hour++ % 24).padStart(2, '0')}:00:00.000Z`,
    })
  const viewPill = (name: string) =>
    [...document.querySelectorAll('[data-view-switch] button')].find(
      (b) => b.textContent?.trim() === name,
    )
  const toast = () => q('.planner-toast-host')?.textContent ?? ''
  const crumb = () => q('[data-scope-crumb] h1')?.textContent

  it('drops a sidebar open once the person moves elsewhere, with its toast, so its answer opens nothing', async () => {
    const { snap, held, late } = lateWorld()
    // the server's ok, with the delivery that brings the project
    resolveWith = (args) => {
      deliver(held)
      return queryProjectNav(held, 'projectNav:resolve', args)
    }
    await app(snap, '/app/testbed/overview/p/10', {}, () => {
      server = held
    })
    // Back follows the view pill, so it reaches the Board's entry
    const moves: [string, () => Promise<unknown>][] = [
      ['My view', () => click(q('aside [data-mine-nav]'))],
      ['the Inbox', () => click(q('[data-view-switch] [aria-label^="Inbox"]'))],
      ['All projects', () => click(q('aside [data-all-nav]'))],
      ['Team sync', () => click(q('aside [data-sync-nav]'))],
      ['a view pill', () => click(viewPill('Board'))],
      ['Back', () => act(async () => history.back())],
    ]
    for (const [what, moveOn] of moves) {
      // on Luma Sensor's Overview, with a workspace that lacks the project
      await go('/app/testbed/overview/p/10')
      await until(() => shown() === 'overview' && crumb() === 'Luma Sensor', `${what}: Luma Sensor`)
      deliver(snap)
      server = held
      await settle()
      expect(store.P.project(late)).toBeUndefined()
      const release = holdResolve()
      await until(() => q(`aside [data-project-row="${late}"] button`), `${what}: the row`)
      await click(q(`aside [data-project-row="${late}"] button`))
      expect(toast()).toContain('Opening Late programme…')
      const from = location.pathname
      await moveOn()
      await settle()
      const there = location.pathname
      expect(there, what).not.toBe(from)
      expect(toast(), what).not.toContain('Opening Late programme…')
      await release()
      // the answer brought the project, and opened nothing
      expect(store.P.project(late), what).toBeDefined()
      expect(location.pathname, what).toBe(there)
      expect(toast(), what).not.toContain('Late programme')
    }
    expect(sentProjects()).not.toContain(late)
  })

  it('drops startup’s check for a view pill and for an open that starts to wait in a list, so its answer opens nothing', async () => {
    const { snap, held, late } = lateWorld()
    let release = holdResolve()
    await app(structuredClone(snap), '/app/testbed', remembering(PORTAL, PARTNER))
    await chooser('checking')
    await click(viewPill('Board'))
    // the chooser takes the check's place, on the view the person chose
    await chooser('choose')
    expect(q('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens on the Board.',
    )
    await release()
    expect(chooserState()).toBe('choose')
    expect(shown()).toBeUndefined()
    expect(viewReads()).toEqual([])
    expect(location.pathname).toBe('/app/testbed')
    await leave()
    // a sidebar row the workspace does not hold, whose answer lands second
    resolveWith = (args) => {
      if ((args as { project_id?: string }).project_id === late) deliver(held)
      return queryProjectNav(held, 'projectNav:resolve', args)
    }
    release = holdResolve()
    await app(structuredClone(snap), '/app/testbed', remembering(PORTAL, PARTNER), () => {
      server = held
    })
    await chooser('checking')
    await until(() => q(`aside [data-project-row="${late}"] button`), 'the row')
    await click(q(`aside [data-project-row="${late}"] button`))
    await chooser('choose')
    await release()
    await until(() => shown() === 'overview', "Late programme's Overview")
    expect(crumb()).toBe('Late programme')
    expect(asks.map((a) => a.args)).toEqual([{ project_id: PORTAL }, { project_id: late }])
    await until(() => lastSent() === late, 'the pick remembered')
    expect(sentProjects()).toEqual([late])
  })
})
