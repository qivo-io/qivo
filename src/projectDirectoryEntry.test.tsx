// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'
import { answerProjectNav, isProjectNavRead } from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'

/* Where the main All projects entry goes, on the real store and App. The
   sidebar's All projects row and the phone's Projects tab open the project
   directory (`/app/~/projects`), which leaves the remembered project
   (UIPrefs.lastProject) as it was. The row lights for the directory and
   for the All projects scope the old paths still reach, and no project row
   or My view lights under the directory. The views' reads answer from
   their stand-ins, and the directory's from the navigation reads'
   stand-in. */

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

let container: HTMLDivElement
let root: Root
let phone = false

beforeEach(() => {
  phone = false
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
  sessionStorage.clear()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The fixture with its one person a member of Plan, a project over the
    fixture's sub-project. */
function member(): Snapshot {
  const snap = plannerFixture()
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  base.parent_id = 'plan'
  snap.profiles[0].org_role = 'user'
  snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'user' })
  return snap
}

/** Boots the real store on `snap` and renders App at `path`. */
async function app(snap: Snapshot, path: string) {
  vi.resetModules()
  history.replaceState(null, '', path)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(snap, name, args))
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(snap, name, args, next, fail)
    else if (isProjectNavRead(name)) answerProjectNav(snap, name, args, next, fail)
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  await store.initStore()
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

/** The element `selector` names, waited for through lazy views. */
const element = (selector: string) =>
  vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(selector)
      if (!found) throw new Error(`missing ${selector}`)
      return found
    },
    { timeout: 10_000 },
  )
const lit = (selector: string) => document.querySelector(selector)?.hasAttribute('data-on')
/** The project App remembered for the fixture's person, as the browser's
    copy of the preferences holds it. */
const remembered = (snap: Snapshot): string | undefined =>
  JSON.parse(localStorage.getItem(`planner.ui.v1:${snap.profiles[0].id}`) ?? '{}').lastProject
    ?.project_id

describe('the All projects entry', () => {
  it("opens the directory from the sidebar's row, lit alone, and keeps the remembered project", async () => {
    const snap = member()
    await app(snap, '/app/testbed/board/p/2')
    await element('[data-project-row="plan"][data-on]')
    // the Board of Plan remembers it
    await vi.waitFor(() => expect(remembered(snap)).toBe('plan'))
    await act(async () => (await element('[data-all-nav]')).click())
    await vi.waitFor(() => expect(location.pathname).toBe('/app/~/projects'))
    await element('[data-project-directory] [data-directory-row="plan"]')
    expect(lit('[data-all-nav]')).toBe(true)
    expect(lit('[data-project-row="plan"]')).toBe(false)
    expect(lit('[data-mine-nav]')).toBe(false)
    expect(remembered(snap)).toBe('plan')
    // the desktop page's title names the entry, and the page has no All
    // projects button of its own
    expect(document.querySelector('[data-page-header]')?.getAttribute('data-page-header')).toBe(
      'All projects',
    )
    expect(document.querySelectorAll('[data-all-nav]')).toHaveLength(1)
    // a press on the project goes back to its scope, with its row lit
    await act(async () =>
      (await element('[data-directory-row="plan"] [data-directory-open]')).click(),
    )
    await vi.waitFor(() => expect(lit('[data-project-row="plan"]')).toBe(true))
    expect(lit('[data-all-nav]')).toBe(false)
  })

  it('keeps My view unlit under the directory, and lights All projects for the old scope', async () => {
    const snap = member()
    await app(snap, '/app/~/board/mine')
    await vi.waitFor(() => expect(lit('[data-mine-nav]')).toBe(true))
    // My view remembers nothing, and neither does the directory
    expect(remembered(snap)).toBeUndefined()
    await act(async () => (await element('[data-all-nav]')).click())
    await element('[data-project-directory]')
    expect(lit('[data-all-nav]')).toBe(true)
    expect(lit('[data-mine-nav]')).toBe(false)
    expect(remembered(snap)).toBeUndefined()
    await act(async () => root.unmount())
    root = createRoot(container)
    // an address ending in /all still names the scope, which lights the row
    await app(snap, '/app/~/overview/all')
    await vi.waitFor(() => expect(lit('[data-all-nav]')).toBe(true))
    expect(document.querySelector('[data-project-directory]')).toBeNull()
  })

  it("opens the same directory from the phone's Projects tab", async () => {
    phone = true
    const snap = member()
    await app(snap, '/app/testbed/board/p/2')
    await vi.waitFor(() => expect(remembered(snap)).toBe('plan'))
    await act(async () => (await element('[data-projects-nav]')).click())
    await vi.waitFor(() => expect(location.pathname).toBe('/app/~/projects'))
    await element('[data-project-directory] [data-directory-row="plan"]')
    expect(document.querySelector('[data-all-nav]')).toBeNull()
    // the field takes no focus as the page opens
    expect(document.activeElement).not.toBe(document.querySelector('[data-directory-search]'))
    expect(remembered(snap)).toBe('plan')
  })
})
