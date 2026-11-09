// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerMilestones, isMilestoneRead } from './store/milestoneStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, underProgram } from './store/plannerFixture.setup'
import {
  answerProjectNav,
  isProjectNavRead,
  projectNavStandIn,
} from './store/projectNavStandIn.setup'
import { answerRoadmap } from './store/roadmapStandIn.setup'
import { type SyncArgs, teamSyncStandIn } from './store/teamSyncStandIn.setup'
import { taskRow } from './views/boardFixture.setup'

/* The main pages stay loaded while the person moves between them, on App
   and the real store (lib/keptPages.ts): each page opened stays in the
   page, hidden, and shows again as the same elements; Settings goes when
   the person leaves it; and once the person leaves the app alone for 30
   minutes, every kept page but the one shown goes. A Plan on roadmap made
   while the Roadmap waits for its answer plans the task once the answer
   holds it, only while the person stays on the Roadmap. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  double.live = liveOver(network, { taskWindow: 'client' })
  return { convex: network, live: double.live }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const MINUTE = 60_000
// the task comment threads the store subscribed to, and whether each stopped
const threads: { stopped: boolean }[] = []
// the milestone reads the store subscribed to, and whether each stopped
const milestoneWatches: { name: string; stopped: boolean }[] = []
const realTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // the clock jumps when a test says so, and runs on its own meanwhile
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.getAnimations = () => []
  // jsdom does not scroll: a scroll to a place sets the element's offset
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollTop = options.top ?? 0
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  /* Frames on the real clock: jsdom schedules its frames on the timer
     functions it found first, so once a case faked them and the clock
     moved, a later case would wait for frames that never come, and no page
     that leaves (components/KeptView.tsx) would ever go. */
  const frames = new Map<number, ReturnType<typeof realTimeout>>()
  let frame = 0
  vi.stubGlobal('requestAnimationFrame', (step: FrameRequestCallback) => {
    const id = ++frame
    frames.set(
      id,
      realTimeout(() => {
        frames.delete(id)
        step(performance.now())
      }, 16),
    )
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    realClearTimeout(frames.get(id))
    frames.delete(id)
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Waits for `find` to answer, through lazy modules that can take seconds
    to load on a busy worker. It polls on the real clock: the faked one
    runs only when a test moves it. */
async function waitFor<T>(find: () => T | null | undefined | false, what: string) {
  const end = performance.now() + 10_000
  for (;;) {
    const found = await act(async () => find())
    if (found) return found
    if (performance.now() > end) throw new Error(`missing ${what}`)
    await new Promise((resolve) => realTimeout(resolve, 20))
  }
}

type Snapshot = ReturnType<typeof plannerFixture>

/** Boots App on the fixture workspace, with what `prepare` adds, and the
    task window from `held` on still to load. Answers the organization's
    slug. */
/* Whether boot's server answers the task window's read of a task
   (windowTask), which the suite of Plan on roadmap turns on. */
let answersTasks = false
/* The Roadmap's reads boot's server holds back until `answerRoadmaps`
   answers them from the snapshot (store/roadmapStandIn.setup.ts), while
   `holdRoadmaps` is on. */
let holdRoadmaps = false
let answerRoadmaps = () => {}
/* The milestone reads boot's server holds back while `holdMilestones` is
   on, each sent by its entry in `heldMilestones` once a test calls it. */
let holdMilestones = false
const heldMilestones: (() => void)[] = []

/** The task window's read (convex/taskWindow.ts task) of the task `ref`
    names in `snap`, by its number (QN-n) or uuid, as an editor's, with its
    subtasks, or null for none. */
function windowTask(snap: Snapshot, ref: string) {
  const row = snap.issues.find((it) => it.id === ref || `QN-${it.num}` === ref.toUpperCase())
  if (!row) return null
  const subtasks = snap.issues
    .filter((it) => it.parent_id === row.id)
    .map(
      ({
        description: _d,
        parent_id: _p,
        has_hidden_parent: _hp,
        has_hidden_subtasks: _hs,
        ...short
      }) => ({ ...short, has_subtasks: false, level: 'lead' }),
    )
  return {
    state: 'ok',
    task: { ...row, has_subtasks: subtasks.length > 0 },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: subtasks, complete: true },
  }
}

async function boot(prepare: (snap: Snapshot) => void = () => {}, held: string | null = null) {
  vi.resetModules()
  const snap = plannerFixture()
  for (let n = 1; n <= 3; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
  snap.issues[0].title = 'Write the release notes'
  prepare(snap)
  // the fixture's project under a top-level project, as every writer stores
  // one that holds tasks, so the navigation reads and the project cache
  // answer it, where `prepare` did not place it
  if (snap.projects[0].parent_id === undefined && snap.projects[0].type !== 'meta')
    underProgram(snap)
  threads.length = 0
  milestoneWatches.length = 0
  holdMilestones = false
  heldMilestones.length = 0
  // the store, once it loaded, for what the person sees and may edit
  let P: typeof import('./store/planner')['P'] | null = null
  // sends the workspace as the server holds it now
  let publishWhole = () => {}
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      publishWhole = () => next(structuredClone(snap))
      publishWhole()
    } else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
    else if (name === 'teamSync:agenda')
      next(
        teamSyncStandIn(snap, args as SyncArgs, {
          sees: (id) => P?.canSee(id) ?? true,
          writes: (id) => P?.canWrite(id) ?? false,
        }),
      )
    else if (name === 'tasks:roadmap' || name === 'tasks:roadmapDependencies') {
      const answer = () => next(structuredClone(answerRoadmap(snap, name, args)))
      if (!holdRoadmaps) answer()
      else {
        const before = answerRoadmaps
        answerRoadmaps = () => {
          before()
          answer()
        }
      }
    } else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    else if (isMilestoneRead(name)) {
      const watch = { name, stopped: false }
      const answer = () => {
        if (!watch.stopped) answerMilestones(snap, name, args, next, fail)
      }
      if (holdMilestones) heldMilestones.push(answer)
      else answer()
      milestoneWatches.push(watch)
      return () => {
        watch.stopped = true
      }
    } else if (name === 'teamSync:lastComments')
      next({ rows: [{ issue_id: 't1', at: '2026-09-10T08:00:00.000Z' }], complete: true })
    else if (name === 'taskWindow:task' && answersTasks) {
      // the window's own read of a task the workspace does not hold, by its
      // number or uuid; another stays on its way
      const answer = windowTask(snap, String((args as { ref: string }).ref))
      if (answer) next(answer)
    } else if (name === 'snapshot:threadComments') {
      next({ comments: [], earlier: false })
      const thread = { stopped: false }
      threads.push(thread)
      return () => {
        thread.stopped = true
      }
    }
    // the navigation lists the views and pickers read, as the server
    // answers them
    if (isProjectNavRead(name) && name !== 'projectNav:byIds')
      answerProjectNav(snap, name, args, next, fail)
    return () => {}
  })
  // a numbered project address resolves through projectNav.resolve
  network.query.mockImplementation(async (ref, args) =>
    getFunctionName(ref) === 'projectNav:resolve'
      ? projectNavStandIn(snap, 'projectNav:resolve', args)
      : null,
  )
  // the server holds an Inbox read and sends its rows before it answers, as
  // Convex does, so the inbox item a task window reads follows it
  network.mutation.mockImplementation(async (ref, args) => {
    await Promise.resolve()
    const name = getFunctionName(ref)
    const a = args as { issue_id?: string }
    const read =
      name === 'messages:readItem'
        ? (m: Snapshot['messages'][number]) => m.issue_id === a.issue_id
        : null
    if (read) {
      const at = '2026-09-14T09:00:00.000Z'
      snap.messages = snap.messages.map((m) => (!m.read_at && read(m) ? { ...m, read_at: at } : m))
      publishWhole()
    }
    return null
  })
  const store = await import('./store/planner')
  P = store.P
  double.live?.holdWindow(held)
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
  return location.pathname.split('/')[2]
}

/** Goes to `address` as Back or Forward would. */
const go = (address: string) =>
  act(async () => {
    history.pushState(null, '', address)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

/** The container of the shown main page `page`, once its content is in. */
const shownPage = (page: string) =>
  waitFor(() => {
    const box = document.querySelector<HTMLElement>(`[data-workspace-view="${page}"]`)
    return box?.querySelector('[data-kept-content]')?.firstElementChild && box
  }, `the shown ${page}`)

const hiddenPages = () =>
  [...document.querySelectorAll<HTMLElement>('main [data-hidden-view]')].map(
    (box) => box.dataset.hiddenView,
  )

describe('the main pages kept while the person uses the app', { timeout: 30_000 }, () => {
  it('keeps each page opened, unloads Settings, and releases the hidden pages after 30 idle minutes', async () => {
    const org = await boot()
    await go(`/app/${org}/board/mine`)
    const board = await shownPage('kanban')
    await go(`/app/${org}/overview/mine`)
    const overview = await shownPage('overview')
    await go(`/app/${org}/roadmap/mine`)
    await shownPage('roadmap')
    await go(`/app/${org}/inbox`)
    const inbox = await shownPage('inbox')
    expect(hiddenPages().sort()).toEqual(['kanban', 'overview', 'roadmap'])

    // back to a kept page: the same elements show again
    await go(`/app/${org}/board/mine`)
    expect(await shownPage('kanban')).toBe(board)
    expect(board.isConnected && overview.isConnected && inbox.isConnected).toBe(true)

    // Settings shows over the kept pages, and goes when the person leaves
    await go(`/app/${org}/settings/account`)
    await waitFor(() => document.querySelector('[data-settings-page]'), 'Settings')
    expect(hiddenPages().sort()).toEqual(['inbox', 'kanban', 'overview', 'roadmap'])
    const back = await waitFor(
      () => document.querySelector<HTMLElement>('[data-settings-back]'),
      "Settings' way back",
    )
    await act(async () => back.click())
    expect(await shownPage('kanban')).toBe(board)
    expect(document.querySelector('[data-settings-page]')).toBeNull()

    // input within the 30 minutes keeps every page
    await act(async () => vi.advanceTimersByTime(29 * MINUTE))
    window.dispatchEvent(new PointerEvent('pointermove'))
    await act(async () => vi.advanceTimersByTime(29 * MINUTE))
    expect(hiddenPages().sort()).toEqual(['inbox', 'overview', 'roadmap'])

    // 30 minutes without input: only the page on screen stays
    await act(async () => vi.advanceTimersByTime(MINUTE))
    await waitFor(() => !overview.isConnected && !inbox.isConnected, 'the released pages gone')
    expect(hiddenPages()).toEqual([])
    expect(board.isConnected).toBe(true)

    // a released page opens anew, as on a first visit
    await go(`/app/${org}/overview/mine`)
    const again = await shownPage('overview')
    expect(again).not.toBe(overview)
    expect(hiddenPages()).toEqual(['kanban'])
  })

  it("keeps the Overview's milestone reads on their fixed slots while it is kept, and forgets them once it is not", async () => {
    const org = await boot((snap) => {
      // the fixture's project as a sub-project (p/1) of a top-level one,
      // which holds a milestone next week
      const program = underProgram(snap).projects[1]
      const day = new Date()
      day.setDate(day.getDate() + 7 - ((day.getDay() + 6) % 7))
      const week = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      snap.milestones.push({
        id: 'ms-1',
        project_id: program.id,
        name: 'Program launch',
        week,
        created_at: '2026-09-14T08:00:00.000Z',
      })
    })
    const { P, OVERVIEW_MILESTONE_SLOTS } = await import('./store/planner')
    const live = () => milestoneWatches.filter((w) => !w.stopped && w.name === 'milestones:section')
    const holding = () =>
      OVERVIEW_MILESTONE_SLOTS.upcoming.filter((slot) => P.milestoneRead(slot).state !== 'loading')
    await go(`/app/${org}/overview/p/1`)
    const page = await shownPage('overview')
    await waitFor(() => page.querySelector('[data-overview-milestone="ms-1"]'), 'the row')
    expect(live()).toHaveLength(1)
    // must fail for numbered slots: the answer is on a fixed slot
    expect(holding()).toHaveLength(1)
    // hidden behind the Board, the read stops and keeps its answer
    await go(`/app/${org}/board/p/1`)
    await shownPage('kanban')
    await waitFor(() => live().length === 0, 'the stopped milestone read')
    expect(P.milestoneRead(holding()[0] ?? '')).toMatchObject({ state: 'ok', current: false })
    // 30 minutes without input: the Overview is no longer kept, and its reads go
    await act(async () => vi.advanceTimersByTime(30 * MINUTE))
    await waitFor(() => !page.isConnected, 'the released Overview page')
    expect(holding()).toEqual([])
    expect(live()).toEqual([])
  })

  it("keeps the Roadmap's milestone reads while it is kept, two at most through a scope switch, and forgets them once it is not", async () => {
    const org = await boot((snap) => {
      // the fixture's project as a sub-project (p/1) of a top-level one,
      // and another top-level project with a sub-project of its own (p/51),
      // each with a milestone next week
      const program = underProgram(snap).projects[1]
      const day = new Date()
      day.setDate(day.getDate() + 7 - ((day.getDay() + 6) % 7))
      const week = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      for (const [id, project, name] of [
        ['ms-1', program.id, 'Program launch'],
        ['ms-2', 'other', 'Other launch'],
      ])
        snap.milestones.push({
          id,
          project_id: project,
          name,
          week,
          created_at: '2026-09-14T08:00:00.000Z',
        })
      snap.projects.push(
        { ...program, id: 'other', key: 'OTH', num: 50, name: 'Other' },
        {
          ...snap.projects[0],
          id: 'other-a',
          key: 'OTA',
          num: 51,
          name: 'Other work',
          parent_id: 'other',
        },
      )
    })
    const { P, ROADMAP_MILESTONE_SLOTS } = await import('./store/planner')
    const live = () => milestoneWatches.filter((w) => !w.stopped && w.name === 'milestones:between')
    // the answers the Roadmap's two slots hold
    const held = () =>
      ROADMAP_MILESTONE_SLOTS.map((slot) => P.milestoneRead(slot)).filter(
        (read) => read.state !== 'loading',
      )
    await go(`/app/${org}/roadmap/p/1`)
    const first = await shownPage('roadmap')
    await waitFor(() => first.querySelector('[data-msflag="ms-1"]'), 'the flag')
    expect(live()).toHaveLength(1)
    // a pan reads the new window, then lets the old one go
    await act(async () => first.querySelector<HTMLElement>('[data-win="fwd"]')?.click())
    await waitFor(() => live().length === 1 && held().length === 1, 'the new window alone')
    // another scope mounts a Roadmap anew, which takes the two slots over
    await go(`/app/${org}/roadmap/p/51`)
    const other = await waitFor(
      () =>
        document.querySelector('[data-workspace-view="roadmap"] [data-roadmap-milestones="ok"]'),
      "the other project's flags",
    )
    expect(other.querySelector('[data-msflag="ms-2"]')).not.toBeNull()
    expect(live()).toHaveLength(1)
    expect(held()).toHaveLength(1)
    // the slot that holds the shown answer
    const holding = () =>
      ROADMAP_MILESTONE_SLOTS.filter((slot) => P.milestoneRead(slot).state !== 'loading')
    const [shown] = holding()
    /** Hides the Roadmap behind the same scope's Board: its read stops and
        keeps its answer, as a kept page's effects stop while it hides. */
    const hide = async () => {
      await go(`/app/${org}/board/p/51`)
      await shownPage('kanban')
      await waitFor(() => live().length === 0, 'the stopped read')
      expect(held()).toEqual([expect.objectContaining({ state: 'ok', current: false })])
      expect(document.querySelector('[data-hidden-view="roadmap"]')).not.toBeNull()
    }
    await hide()
    // back on the Roadmap, while the server holds the read's answer back,
    // the kept flag shows at once, refreshing, and the same slot reads again
    holdMilestones = true
    const watched = milestoneWatches.length
    await go(`/app/${org}/roadmap/p/51`)
    const back = await waitFor(
      () =>
        document.querySelector(
          '[data-workspace-view="roadmap"] [data-roadmap-milestones="refreshing"]',
        ),
      'the kept flags, refreshing',
    )
    // must fail: a show that releases the shown slot, so the flag goes and
    // the read starts again from loading
    expect(back.querySelector('[data-msflag="ms-2"]')).not.toBeNull()
    expect(live()).toHaveLength(1)
    expect(milestoneWatches).toHaveLength(watched + 1)
    expect(holding()).toEqual([shown])
    expect(held()).toEqual([expect.objectContaining({ state: 'ok', current: false })])
    holdMilestones = false
    await act(async () => {
      for (const send of heldMilestones.splice(0)) send()
    })
    await waitFor(
      () =>
        document.querySelector('[data-workspace-view="roadmap"] [data-roadmap-milestones="ok"]'),
      'the current flags',
    )
    expect(holding()).toEqual([shown])
    await hide()
    // 30 minutes without input: the Roadmap is no longer kept, and its reads go
    await act(async () => vi.advanceTimersByTime(30 * MINUTE))
    await waitFor(
      () => !document.querySelector('[data-hidden-view="roadmap"]'),
      'the released Roadmap',
    )
    expect(held()).toEqual([])
    for (const slot of ROADMAP_MILESTONE_SLOTS)
      expect(P.milestoneRead(slot)).toEqual({ state: 'loading' })
    expect(live()).toEqual([])
  })

  it('opens an address that once named all projects on the project chooser at once, asking for no task', async () => {
    // 12,800 task numbers make 64 task windows; the last starts at fc000000
    const org = await boot((snap) => {
      underProgram(snap)
      snap.orgs[0].next_issue_num = 64 * 200
      // at the front door, with no scope chosen
      history.replaceState(null, '', '/app/testbed')
    }, 'fc000000')
    const { __layerProbe } = await import('./store/planner')
    await waitFor(() => document.querySelector('[data-project-chooser]'), 'the chooser')
    // what the boot asked for
    __layerProbe?.asks()
    await go(`/app/${org}/roadmap/all`)
    await waitFor(() => document.querySelector('[data-project-chooser]'), 'the chooser')
    expect(document.querySelector('[data-workspace-view="roadmap"]')).toBeNull()
    expect(document.body.textContent).not.toContain('opens once every task has loaded')
    // no view and no task of the workspace is asked for
    expect(__layerProbe?.asks()).toEqual([])
  })

  it('mounts the pages of a new scope anew, and keeps the Inbox', async () => {
    const org = await boot()
    await go(`/app/${org}/inbox`)
    const inbox = await shownPage('inbox')
    await go(`/app/${org}/board/p/1`)
    const board = await shownPage('kanban')
    await go(`/app/${org}/board/mine`)
    const mine = await shownPage('kanban')
    expect(mine).not.toBe(board)
    await waitFor(() => !board.isConnected, "the old scope's Board gone")
    await go(`/app/${org}/inbox`)
    expect(await shownPage('inbox')).toBe(inbox)
  })
})

describe('Plan on roadmap while the Roadmap reads its answer', { timeout: 30_000 }, () => {
  /* QN-5, Plan the launch, unassigned and unplanned. The store boots
     without the workspace's tasks, as the app does, so its window shows it
     from its own read, and Plan on roadmap opens the Roadmap at once, which
     asks the server for its tasks, the planned one among them, and asks for
     no task of the workspace. Boot's server holds the Roadmap's answers
     back until `answerRoadmaps`. */
  const LAUNCH = '01000000-0000-4000-8000-000000000005'
  beforeEach(async () => {
    answersTasks = true
    holdRoadmaps = true
    answerRoadmaps = () => {}
    const { TASKS } = await import('./store/liveParts')
    TASKS.atBoot = false
  })
  afterEach(async () => {
    answersTasks = false
    holdRoadmaps = false
    answerRoadmaps = () => {}
    // no write went out on a path that needs every task, and no paint threw
    const { __layerProbe } = await import('./store/planner')
    expect(__layerProbe?.faults()).toEqual([])
  })
  /* The writes of a planning session, which gives an unscheduled task its
     starter bar. */
  const dateWrites = () =>
    network.mutation.mock.calls
      .map(([ref]) => getFunctionName(ref))
      .filter((name) => name === 'issues:update' || name === 'roadmap:change')

  /** Boots without the tasks, opens QN-5's window and presses Plan on
      roadmap, or Show on roadmap when `group` gives QN-5 a subtask, which
      opens the Roadmap of QN-5's top-level project at once with its
      answer on its way. Answers the organization's slug. */
  async function planWhileLoading(group = false) {
    const org = await boot((snap) => {
      underProgram(snap)
      snap.issues.push({
        ...taskRow(snap, LAUNCH, 'todo', 5),
        title: 'Plan the launch',
        assignee_id: undefined,
      })
      if (group)
        snap.issues.push({
          ...taskRow(snap, '01000000-0000-4000-8000-000000000006', 'todo', 6),
          parent_id: LAUNCH,
        })
    })
    network.mutation.mockClear()
    // the journal answers how many operations the visit holds, as the
    // server's roadmap.change does
    network.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'roadmap:change' ? { count: 1 } : null,
    )
    await go(`/app/${org}/board/tasks/qn-5`)
    const plan = await waitFor(
      () => document.querySelector<HTMLButtonElement>('[data-plan-on-roadmap]'),
      'Plan on roadmap',
    )
    expect(plan.textContent).toBe(group ? 'Show on roadmap' : 'Plan on roadmap')
    const { P } = await import('./store/planner')
    expect(P.taskLoad()).toEqual({ state: 'not_asked' })
    await act(async () => plan.click())
    const roadmap = await shownPage('roadmap')
    await waitFor(
      () =>
        roadmap.querySelector('[data-roadmap-root]')?.getAttribute('data-roadmap-state') ===
        'loading',
      'the Roadmap waiting for its answer',
    )
    expect(roadmap.textContent).not.toContain('opens once every task has loaded')
    // the Roadmap asked for no task of the workspace
    expect(P.taskLoad()).toEqual({ state: 'not_asked' })
    const { __layerProbe } = await import('./store/planner')
    expect(__layerProbe?.asks()).toEqual([])
    return org
  }

  /** Lets the Roadmap's held answers arrive, and those it asks for later. */
  async function loadTheAnswer() {
    holdRoadmaps = false
    await act(async () => {
      answerRoadmaps()
      answerRoadmaps = () => {}
      await new Promise((resolve) => realTimeout(resolve, 0))
    })
    await (await import('./lib/workspaceChunks')).loadRoadmap()
  }

  it("plans the task once the Roadmap's answer holds it, while the person waits on the Roadmap", async () => {
    await planWhileLoading()
    await loadTheAnswer()
    await waitFor(() => dateWrites().length > 0, "the planning session's starter bar")
    await waitFor(() => document.querySelector('[data-plan-card]'), 'the planning card')
    // the session's task went with the Roadmap's read, past its filters
    const asked = network.onUpdate.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'tasks:roadmap')
      .map(([, args]) => args as { planned_task?: { id: string } })
    expect(asked.some((args) => args.planned_task?.id === LAUNCH)).toBe(true)
  })

  it('starts no planning session at a later visit when the person left the Roadmap while it waited', async () => {
    const org = await planWhileLoading()
    await go(`/app/${org}/board/mine`)
    await shownPage('kanban')
    await loadTheAnswer()
    await go(`/app/${org}/roadmap/p/99`)
    const roadmap = await shownPage('roadmap')
    await waitFor(
      () => roadmap.querySelector('[data-roadmap-root][data-roadmap-state="ok"]'),
      'the Roadmap with its answer',
    )
    await act(async () => new Promise((resolve) => realTimeout(resolve, 50)))
    expect(document.querySelector('[data-plan-card]')).toBeNull()
    expect(dateWrites()).toEqual([])
  })

  it('starts no planning session at a later visit when the Inbox covered the Roadmap while it waited', async () => {
    // the Inbox is a page over the Roadmap, so the view stays roadmap meanwhile
    const org = await planWhileLoading()
    await go(`/app/${org}/inbox`)
    await shownPage('inbox')
    await loadTheAnswer()
    await go(`/app/${org}/roadmap/p/99`)
    const roadmap = await shownPage('roadmap')
    await waitFor(
      () => roadmap.querySelector('[data-roadmap-root][data-roadmap-state="ok"]'),
      'the Roadmap with its answer',
    )
    await act(async () => new Promise((resolve) => realTimeout(resolve, 50)))
    expect(document.querySelector('[data-plan-card]')).toBeNull()
    expect(dateWrites()).toEqual([])
  })

  it('shows no task at a later visit when the person left the Roadmap while a Show on roadmap waited', async () => {
    const org = await planWhileLoading(true)
    await go(`/app/${org}/overview/mine`)
    await shownPage('overview')
    await loadTheAnswer()
    await go(`/app/${org}/roadmap/p/99`)
    const roadmap = await shownPage('roadmap')
    await waitFor(
      () => roadmap.querySelector('[data-roadmap-root][data-roadmap-state="ok"]'),
      'the Roadmap with its answer',
    )
    await act(async () => new Promise((resolve) => realTimeout(resolve, 50)))
    expect(document.querySelector('[data-roadmap-revealed]')).toBeNull()
  })
})
