// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../components/ui/tooltip'
import { type BoardArgs, boardStandIn } from '../store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from '../store/milestoneStandIn.setup'
import { answerOverview } from '../store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'
import {
  answerProjectNav,
  type ForcedProjectNav,
  isProjectNavRead,
  projectNavStandIn,
} from '../store/projectNavStandIn.setup'
import { answerRoadmap } from '../store/roadmapStandIn.setup'

/* The views of a project on App and the real store, which holds no
   project, with the navigation stand-in answering projectNav.byIds from
   the whole: a Roadmap flag of a top-level project is fixed while the
   project cache loads it and movable once it answers Edit, its drop saving
   with the organization the cache gives, and a Viewer's stays fixed. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => {
  const live = (await import('../store/guard/liveDouble.setup')).liveOver(network)
  // the cases answer the project cache's reads themselves, with their force
  live.forceProjectNav('client')
  return { convex: network, live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let server: Snapshot
let navForce: ForcedProjectNav = {}
let phone = false
// the byIds reads asked, and every write App sent
let byIds: string[][] = []
let sent: { name: string; args: Record<string, unknown> }[] = []

beforeEach(() => {
  navForce = {}
  phone = false
  byIds = []
  sent = []
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
  Element.prototype.setPointerCapture = () => {}
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The Monday `weeks` weeks after this week's, as a stored day. */
function mondayIn(weeks: number) {
  const day = new Date()
  day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Plan, a top-level project, with Plan work, its sub-project, which holds
    the person's task and a grant of `subLevel` of theirs, and Plan's
    milestone next week; `planLevel` is the person's grant on Plan, none
    for null. The workspace holds no project, so the views read Plan from
    the project cache. */
function world({ planLevel }: { planLevel: 'user' | 'viewer' | null }): Snapshot {
  const snap = plannerFixture()
  const me = snap.profiles[0].id
  snap.profiles[0].org_role = 'user'
  const base = snap.projects[0]
  const org = snap.orgs[0].id
  snap.projects = [
    { ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 1, name: 'Plan', lead_id: undefined },
    {
      ...base,
      id: 'plan-a',
      type: 'project',
      key: 'PLA',
      num: 2,
      name: 'Plan work',
      parent_id: 'plan',
      lead_id: undefined,
    },
  ]
  snap.access = [
    { project_id: 'plan-a', profile_id: me, level: 'user' },
    ...(planLevel ? [{ project_id: 'plan', profile_id: me, level: planLevel }] : []),
  ]
  snap.issues.push({
    id: 't-plan',
    org_id: org,
    project_id: 'plan-a',
    num: 3,
    title: 'Plan task',
    description: '',
    status: 'todo',
    priority: 'medium',
    assignee_id: me,
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  snap.milestones.push({
    id: 'm-plan',
    project_id: 'plan',
    name: 'Plan launch',
    week: mondayIn(1),
    created_at: AT,
  })
  return snap
}

/** Boots the real store on `snap` and renders App at `path`. */
async function app(snap: Snapshot, path: string) {
  vi.resetModules()
  history.replaceState(null, '', path)
  server = snap
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(server))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(server, name, args, next, fail)
    else if (isProjectNavRead(name)) {
      if (name === 'projectNav:byIds') byIds.push([...(args as { ids: string[] }).ids])
      answerProjectNav(server, name, args, next, fail, { force: navForce })
    }
    return () => {}
  })
  // a numbered project address resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? projectNavStandIn(server, 'projectNav:resolve', args)
      : null,
  )
  network.mutation.mockImplementation(async (ref, args) => {
    sent.push({ name: getFunctionName(ref), args })
    return getFunctionName(ref) === 'roadmap:change' ? { count: 1 } : null
  })
  // the app's boot, which asks for no task, so the store holds none and
  // only the views name projects (the test default holds every task)
  const store = await import('../store/planner')
  await store.initStore()
  const { syncStatus } = await import('../lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('../App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  return store
}

function waitFor<T>(find: () => T | null | undefined | false, what: string) {
  return vi.waitFor(
    () => {
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
const flag = (id: string) =>
  document.querySelector<HTMLElement>(`[data-workspace-view] [data-msflag="${id}"]`)

/** Drags flag `id` by `weeks` weeks of the Roadmap's 36 px week. */
async function drag(id: string, weeks: number) {
  const handle = flag(id)
  if (!handle) throw new Error(`no flag of ${id}`)
  const pointer = (type: string, clientX: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 })
  await act(async () => handle.dispatchEvent(pointer('pointerdown', 100)))
  await act(async () => handle.dispatchEvent(pointer('pointermove', 100 + weeks * 36)))
  await act(async () => handle.dispatchEvent(pointer('pointerup', 100 + weeks * 36)))
  await settle()
}
/** The milestone moves App sent, with the organization each went to. */
const moves = () =>
  sent.filter((s) => s.name === 'roadmap:change' || s.name === 'projects:updateMilestone')

describe('a Roadmap flag of a project only the project cache holds', { timeout: 30_000 }, () => {
  it('is fixed while the cache loads its project, and sends nothing', async () => {
    navForce = { byIdsLoading: true }
    const { P } = await app(world({ planLevel: 'user' }), '/app/~/roadmap/p/2')
    await waitFor(() => flag('m-plan'), "Plan's flag")
    expect(byIds.some((ids) => ids.includes('plan'))).toBe(true)
    expect(P.projectState('plan')).toBe('loading')
    expect(P.canWrite('plan')).toBe(false)
    await drag('m-plan', 2)
    expect(moves()).toEqual([])
  })

  it('moves once the cache answers Edit, and saves with the organization the cache gives', async () => {
    const snap = world({ planLevel: 'user' })
    const { P } = await app(snap, '/app/~/roadmap/p/2')
    await waitFor(() => flag('m-plan'), "Plan's flag")
    await waitFor(() => P.canWrite('plan'), 'the cache answering Plan')
    await settle()
    await drag('m-plan', 2)
    // a move goes out only once milestoneOrg found an organization, here
    // the cache's
    expect(moves()).toHaveLength(1)
    expect(P.orgOf('plan')).toBe(snap.orgs[0].id)
    const org = moves()[0].args.org_id
    if (org !== undefined) expect(org).toBe(snap.orgs[0].id)
  })

  it("stays fixed for someone who sees the project only for navigation, as a Viewer's", async () => {
    const { P } = await app(world({ planLevel: null }), '/app/~/roadmap/p/2')
    await waitFor(() => flag('m-plan'), "Plan's flag")
    await waitFor(() => P.projectState('plan') === 'ok', 'the cache answering Plan')
    expect(P.levelOn('plan')).toBe('viewer')
    await drag('m-plan', 2)
    expect(moves()).toEqual([])
  })

  it('releases the project once no view or scope names it', async () => {
    // Plan's task is no one's, so My view shows nothing of Plan
    const snap = world({ planLevel: 'user' })
    for (const task of snap.issues) if (task.id === 't-plan') task.assignee_id = undefined
    const { P } = await app(snap, '/app/~/roadmap/p/2')
    await waitFor(() => P.canWrite('plan'), 'the cache answering Plan')
    await act(async () => {
      history.pushState(null, '', '/app/~/roadmap/mine')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await settle()
    await waitFor(() => P.cacheStats().reads.length === 0, 'the reads stopped')
    expect(P.canWrite('plan')).toBe(false)
  })
})

describe("the phone agenda's milestone rows of a project only the cache holds", {
  timeout: 30_000,
}, () => {
  /** The label of the agenda's row of milestone `id`. */
  const label = (id: string) =>
    document
      .querySelector<HTMLElement>(`[data-agenda-milestone="${id}"]`)
      ?.getAttribute('aria-label')

  it('say Open while the cache loads the project', async () => {
    phone = true
    navForce = { byIdsLoading: true }
    await app(world({ planLevel: 'user' }), '/app/~/roadmap/p/2')
    await waitFor(() => label('m-plan'), "Plan's agenda row")
    expect(label('m-plan')).toBe('Open milestone Plan launch')
  })

  it('say Edit once the cache answers Edit', async () => {
    phone = true
    const { P } = await app(world({ planLevel: 'user' }), '/app/~/roadmap/p/2')
    await waitFor(() => P.canWrite('plan'), 'the cache answering Plan')
    await waitFor(() => label('m-plan') === 'Edit milestone Plan launch', 'the Edit label')
  })

  it('say View for a project seen only for navigation', async () => {
    phone = true
    const { P } = await app(world({ planLevel: null }), '/app/~/roadmap/p/2')
    await waitFor(() => P.projectState('plan') === 'ok', 'the cache answering Plan')
    await waitFor(() => label('m-plan') === 'View milestone Plan launch', 'the View label')
  })
})

describe("My view's Overview rows and milestones of a program only the cache holds", {
  timeout: 30_000,
}, () => {
  it("name it from the Overview's own answers, show its names, and stop reading it on leaving My view", async () => {
    const snap = world({ planLevel: 'user' })
    // no scope names the program, and Home, a project the person leads with
    // a sub-project, is the scope to go to after My view
    const me = snap.profiles[0].id
    snap.projects.push(
      {
        ...snap.projects[0],
        id: 'home',
        type: 'meta',
        key: 'HOME',
        num: 5,
        name: 'Home',
        lead_id: me,
      },
      {
        ...snap.projects[1],
        id: 'home-a',
        key: 'HOA',
        num: 6,
        name: 'Home work',
        parent_id: 'home',
      },
    )
    // a paused task of the person's, which My view's Paused list shows
    const task = snap.issues.find((t) => t.id === 't-plan')
    if (!task) throw new Error('no Plan task')
    task.paused = true
    const { P } = await app(snap, '/app/~/overview/mine')
    const row = () =>
      [...document.querySelectorAll<HTMLElement>('[data-workspace-view] [data-ovrow]')].find((r) =>
        r.textContent?.includes('Plan task'),
      )
    // the row's place and the milestone's project label from the cache
    await waitFor(() => row()?.textContent?.includes('Plan, Plan work'), "the row's place")
    // the label above the milestone's name, which shows only once known
    await waitFor(
      () =>
        document.querySelector(
          '[data-workspace-view] [data-overview-milestone="m-plan"] .overview-milestone-text > span',
        )?.textContent === 'Plan',
      "the milestone's project label",
    )
    // the Paused list's answer named the sub-project, and the milestone
    // section's `mine` answer the program itself
    expect(byIds.some((ids) => ids.includes('plan-a'))).toBe(true)
    expect(byIds.some((ids) => ids.includes('plan'))).toBe(true)
    // Home's Overview names neither, so the reads name only Home's own
    // projects: the scope and the sub-project its health table lists
    await act(async () => {
      history.pushState(null, '', '/app/~/overview/p/5')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await settle()
    const read = () => P.cacheStats().reads.flat()
    await waitFor(() => !read().includes('plan') && !read().includes('plan-a'), 'the reads stopped')
    await waitFor(() => read().includes('home'), "Home's read")
    expect(read().sort()).toEqual(['home', 'home-a'])
    expect(P.projectState('plan-a')).toBe('loading')
  })
})
