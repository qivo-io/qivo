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
import {
  answerProjectNav,
  isProjectNavRead,
  queryProjectNav,
} from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'
import { type SyncArgs, teamSyncStandIn } from './store/teamSyncStandIn.setup'
import { taskRow } from './views/boardFixture.setup'

/* Team sync's person jumps (App.tsx showPersonOn, views/TeamSync.tsx
   PersonJumps) on the real store and App. Over all projects or a team,
   the Board and Roadmap buttons beside a person open that view with no
   project chosen: the project chooser with the person filter kept and a
   line that says whose tasks a pick will show, never All projects, My view
   or a project the person did not pick. A pick opens that project's view
   filtered to the person in place of the chooser's entry; Back returns to
   Team sync and Forward to the chooser, with its line, on a phone too,
   where the front door otherwise opens the Inbox, also after a Back past
   Team sync to a project, as the chooser's entry carries the person,
   while the filters still hold them; once they do not, that entry takes
   the startup rule. A project sync's jump opens that project. The person, Planner, holds an admin seat in
   Testbed Labs, with Luma Sensor and its sub-projects Firmware and
   Electronics and one open task of theirs in Firmware, and Ops, a team of
   them that Luma Sensor is shared with. Everyday values, no figure at its
   design size. */

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

const NOW = '2026-09-14T08:00:00.000Z'

let container: HTMLDivElement
let root: Root
let server: Snapshot
// every subscription App opened, in order, and projectNav.resolve's asks
let log: { name: string; args: unknown }[]
let asks: unknown[]
let prefs: Record<string, unknown>
// whether matchMedia answers as a phone (lib/useMobile.ts)
let phone = false
let store: typeof import('./store/planner')
let ME: string
let LUMA: string
let FW: string
let TEAM: string
let ORG: string

/** The person's workspace: Luma Sensor with Firmware and Electronics, one
    open task of theirs in Firmware, and a team of theirs sharing Luma
    Sensor. */
function world(): Snapshot {
  const next = plannerFixture()
  const org = next.orgs[0].id
  ORG = org
  ME = next.profiles[0].id
  const base = next.projects[0]
  LUMA = crypto.randomUUID()
  FW = crypto.randomUUID()
  next.projects = [
    { ...base, id: LUMA, type: 'meta', key: 'LUMA', num: 10, name: 'Luma Sensor' },
    { ...base, id: FW, type: 'project', parent_id: LUMA, key: 'FW', num: 11, name: 'Firmware' },
    {
      ...base,
      id: crypto.randomUUID(),
      type: 'project',
      parent_id: LUMA,
      key: 'EL',
      num: 12,
      name: 'Electronics',
    },
  ]
  next.access.push({ project_id: LUMA, profile_id: ME, level: 'user' })
  TEAM = crypto.randomUUID()
  next.teams.push({
    id: TEAM,
    org_id: org,
    name: 'Ops',
    track_delay_default: false,
    created_at: NOW,
  })
  next.teamMembers.push({ team_id: TEAM, profile_id: ME, is_leader: true })
  next.teamAccess.push({ project_id: LUMA, team_id: TEAM, level: 'user' })
  next.issues.push({
    ...taskRow(next, crypto.randomUUID(), 'todo', 1),
    project_id: FW,
    title: 'Flash the board',
  })
  return next
}

/** Boots App at `path` on `snap`, with the server's preferences `row`. */
async function app(snap: Snapshot, path: string, row: Record<string, unknown> = {}) {
  vi.resetModules()
  history.replaceState(null, '', path)
  server = snap
  prefs = row
  log = []
  asks = []
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    log.push({ name, args })
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server, args as BoardArgs))
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies')
      next(answerRoadmap(server, name, args))
    else if (name.startsWith('overview:')) answerOverview(server, name, args, next, fail)
    else if (isMilestoneRead(name)) answerMilestones(server, name, args, next, fail)
    else if (isProjectNavRead(name)) answerProjectNav(server, name, args, next, fail)
    else if (name === 'teamSync:agenda')
      next(
        teamSyncStandIn(server, args as SyncArgs, {
          sees: (id) => store?.P.canSee(id) ?? true,
          writes: (id) => store?.P.canWrite(id) ?? false,
        }),
      )
    else if (name === 'teamSync:lastComments') next({ rows: [], complete: true })
    return () => {}
  })
  network.query.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'prefs:get')
      return Object.keys(prefs).length ? { profile_id: ME, prefs, updated_at: NOW } : null
    if (name !== 'projectNav:resolve') return null
    asks.push(args)
    return queryProjectNav(server, name, args)
  })
  network.mutation.mockResolvedValue(null)
  store = await import('./store/planner')
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

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}
const until = (find: () => unknown, what: string) =>
  vi.waitFor(
    () => {
      if (!find()) throw new Error(`missing ${what}`)
    },
    { timeout: 10_000 },
  )
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const chooserState = () => q('[data-project-chooser]')?.getAttribute('data-project-chooser-state')
const purpose = () => q('[data-project-chooser-purpose]')?.textContent ?? null
const shown = () => q('[data-workspace-view]')?.getAttribute('data-workspace-view')
/** The Board's and the Roadmap's task reads, in order. */
const taskReads = () => log.filter((s) => s.name === 'tasks:board' || s.name === 'tasks:roadmap')
/** The people filter each task read sent. */
const owners = () =>
  taskReads().map((s) => (s.args as { filters: { owners: string[] } }).filters.owners)
async function click(element: Element | null | undefined) {
  if (!element) throw new Error('nothing to click')
  await act(async () => (element as HTMLElement).click())
  await settle()
}
/** Back or Forward through the page's history, as the browser does. */
async function step(by: -1 | 1) {
  const moved = new Promise((resolve) =>
    window.addEventListener('popstate', resolve, { once: true }),
  )
  await act(async () => {
    history.go(by)
    await moved
  })
  await settle()
}
/** Opens Team sync at `path` and presses the person's `jump` button. */
async function jump(path: string, which: 'board' | 'roadmap') {
  await until(() => q('[data-workspace-view]') || q('[data-project-chooser]'), 'the app')
  history.pushState(null, '', path)
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
  await settle()
  const button = `[data-sync-person-${which}="${ME}"]`
  await until(() => q(button), `the person's ${which} jump`)
  await click(q(button))
}

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Team sync's person jumps", { timeout: 60_000 }, () => {
  for (const [label, path] of [
    ['all projects', () => `/app/testbed/sync/all/people/${ME}`],
    ['a team', () => `/app/testbed/sync/team/${TEAM}/people/${ME}`],
  ] as const)
    it(`opens the chooser with the person filter and a line over ${label}, reads no task until a pick, and the pick opens that project filtered`, async () => {
      await app(world(), '/app/testbed/board/p/11')
      await until(() => shown() === 'kanban', 'the Board')
      await jump(path(), 'board')
      await until(() => chooserState() === 'choose', 'the chooser')
      expect(purpose()).toBe("Choose a project to see Planner's tasks on the Board.")
      // the front door, never a view over all projects, My view or a project
      expect(location.pathname).toBe('/app/testbed')
      expect(shown()).toBeUndefined()
      expect(q('aside [data-all-nav]')?.hasAttribute('data-on')).toBe(false)
      const before = taskReads().length
      const entries = history.length
      await settle()
      expect(taskReads()).toHaveLength(before)
      expect(asks).toEqual([])
      // a pick opens that project's Board filtered to the person, in place
      await click(q(`[data-project-chooser] [data-project-pick="${LUMA}"]`))
      await until(() => shown() === 'kanban', 'the Board of the pick')
      expect(location.pathname).toBe('/app/testbed/board/p/10')
      expect(history.length).toBe(entries)
      await until(() => taskReads().length > before, "the Board's read")
      expect(owners().at(-1)).toEqual([ME])
      // Back returns to Team sync and Forward to the picked Board
      await step(-1)
      await until(() => location.pathname === path(), 'Team sync')
      await step(1)
      await until(() => shown() === 'kanban', 'the Board again')
      expect(location.pathname).toBe('/app/testbed/board/p/10')
    })

  it('names the Roadmap in its line, and Back before a pick then Forward shows the chooser again with it, not the remembered project', async () => {
    // the person opened Luma Sensor last, which the startup rule would open
    await app(world(), '/app/testbed/roadmap/p/10', {
      lastProject: { org_id: ORG, project_id: LUMA },
    })
    await until(() => shown() === 'roadmap', 'the Roadmap')
    await jump(`/app/testbed/sync/all/people/${ME}`, 'roadmap')
    await until(() => chooserState() === 'choose', 'the chooser')
    expect(purpose()).toBe("Choose a project to see Planner's tasks on the Roadmap.")
    const entries = history.length
    const reads = taskReads().length
    await step(-1)
    await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
    expect(q('[data-project-chooser]')).toBeNull()
    await step(1)
    await until(() => chooserState() === 'choose', 'the chooser again')
    expect(purpose()).toBe("Choose a project to see Planner's tasks on the Roadmap.")
    expect(location.pathname).toBe('/app/testbed')
    expect(history.length).toBe(entries)
    // no check of the remembered project, and no task read
    expect(asks).toEqual([])
    expect(taskReads()).toHaveLength(reads)
  })

  it('on a phone, Back before a pick then Forward shows the chooser again with its task list line, not the Inbox the front door opens there', async () => {
    phone = true
    await app(world(), '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', "Firmware's task list")
    await jump(`/app/testbed/sync/all/people/${ME}`, 'board')
    await until(() => chooserState() === 'choose', 'the chooser')
    const line = "Choose a project to see Planner's tasks in its task list."
    expect(purpose()).toBe(line)
    expect(location.pathname).toBe('/app/testbed')
    const entries = history.length
    await step(-1)
    await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
    expect(q('[data-project-chooser]')).toBeNull()
    await step(1)
    await until(() => chooserState() === 'choose', 'the chooser again')
    expect(purpose()).toBe(line)
    expect(shown()).toBeUndefined()
    expect(q('[data-inbox-page-state]')).toBeNull()
    expect(location.pathname).toBe('/app/testbed')
    expect(history.length).toBe(entries)
    expect(asks).toEqual([])
  })

  it("opens a project sync's own project, with no chooser and no line", async () => {
    await app(world(), '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', 'the Board')
    await jump(`/app/testbed/sync/p/10/people/${ME}`, 'board')
    await until(
      () => shown() === 'kanban' && location.pathname === '/app/testbed/board/p/10',
      'Luma',
    )
    expect(q('[data-project-chooser]')).toBeNull()
    expect(owners().at(-1)).toEqual([ME])
  })

  it('shows the chooser without a line on the Overview, which has no person filter', async () => {
    await app(world(), '/app/testbed/board/p/11')
    await until(() => shown() === 'kanban', 'the Board')
    await jump(`/app/testbed/sync/all/people/${ME}`, 'board')
    await until(() => chooserState() === 'choose', 'the chooser')
    expect(purpose()).not.toBeNull()
    // a view the line does not speak for: the Overview shows no filter
    await click(
      [...document.querySelectorAll('[data-view-switch] button')].find(
        (b) => b.textContent?.trim() === 'Overview',
      ),
    )
    await until(() => chooserState() === 'choose', 'the chooser on the Overview')
    expect(purpose()).toBeNull()
    expect(q('[data-project-chooser]')?.textContent).toContain(
      'The project you choose opens on the Overview.',
    )
  })

  /** Jumps from Team sync over all projects on the Board, then goes Back
      past Team sync to the project the drive booted on, `path`. */
  async function backPastSync(path: string) {
    await jump(`/app/testbed/sync/all/people/${ME}`, 'board')
    await until(() => chooserState() === 'choose', 'the chooser')
    await step(-1)
    await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
    await step(-1)
    await until(() => shown() === 'kanban' && location.pathname === path, 'the project')
    expect(q('[data-project-chooser]')).toBeNull()
  }

  for (const device of ['desktop', 'phone'] as const)
    it(`on a ${device}, Forward past Team sync after Back past it to a project shows the chooser again with its line, not the remembered project${device === 'phone' ? ' or the Inbox' : ''}`, async () => {
      phone = device === 'phone'
      // the person opened Firmware last, which the startup rule would open
      await app(world(), '/app/testbed/board/p/11', {
        lastProject: { org_id: ORG, project_id: FW },
      })
      await until(() => shown() === 'kanban', "Firmware's Board")
      const entries = history.length
      await backPastSync('/app/testbed/board/p/11')
      const reads = taskReads().length
      await step(1)
      await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
      await step(1)
      await until(() => chooserState() === 'choose', 'the chooser again')
      expect(purpose()).toBe(
        phone
          ? "Choose a project to see Planner's tasks in its task list."
          : "Choose a project to see Planner's tasks on the Board.",
      )
      expect(location.pathname).toBe('/app/testbed')
      expect(shown()).toBeUndefined()
      expect(q('[data-inbox-page-state]')).toBeNull()
      expect(history.length).toBe(entries + 2)
      // no check of the remembered project, and no task read
      expect(asks).toEqual([])
      expect(taskReads()).toHaveLength(reads)
    })

  it('takes the startup rule on Forward onto the jump once a filter change on the Board left the person filter, with no line', async () => {
    await app(world(), '/app/testbed/board/p/11', {
      lastProject: { org_id: ORG, project_id: FW },
    })
    await until(() => shown() === 'kanban', "Firmware's Board")
    await backPastSync('/app/testbed/board/p/11')
    // the Board shows the person filter the jump set; clearing it changes
    // the filters, which no control on the chooser can
    await until(() => q('[data-filter-x="assignee"]'), 'the person filter')
    await click(q('[data-filter-x="assignee"]'))
    expect(q('[data-filter-x="assignee"]')).toBeNull()
    await step(1)
    await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
    await step(1)
    // the remembered project, once the server checked it
    await until(
      () => shown() === 'kanban' && location.pathname === '/app/testbed/board/p/11',
      'the remembered Board',
    )
    expect(asks).not.toEqual([])
    expect(purpose()).toBeNull()
    expect(q('[data-project-chooser]')).toBeNull()
  })

  it("on a phone, takes the startup rule's Inbox on Forward onto the jump once Show all tasks left the person filter", async () => {
    phone = true
    // Electronics holds no task of the person, so its list offers Show all tasks
    await app(world(), '/app/testbed/board/p/12')
    await until(() => shown() === 'kanban', "Electronics' task list")
    await backPastSync('/app/testbed/board/p/12')
    const all = await vi.waitFor(
      () => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Show all tasks',
        )
        if (!button) throw new Error('missing Show all tasks')
        return button
      },
      { timeout: 10_000 },
    )
    await click(all)
    await step(1)
    await until(() => location.pathname === `/app/testbed/sync/all/people/${ME}`, 'Team sync')
    await step(1)
    await until(() => q('[data-inbox-page-state]'), 'the Inbox')
    expect(purpose()).toBeNull()
  })
})
