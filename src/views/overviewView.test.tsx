// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealthAnswer, ListAnswer, OverviewRow } from '../../convex/lib/overview'
import type { ForcedOverview } from '../store/overviewStandIn.setup'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* The Overview from the server's answers (views/Overview.tsx): the summary,
   the delays and the two lists read through the store (P.watchOverview),
   answered by the Overview's stand-in over the fixture's workspace
   (store/overviewStandIn.setup.ts). Every root, figure and list state with
   its markers; a figure that is not given never shows a number; the
   sentence; the lists' batches, notes and Load more; the health table's
   rows, states, cells, notes, search and Load more; the chooser of All
   projects; My view's notes; the phone; opening a row; an own archive; a
   hidden tab, a kept page and a new day. */

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

let container: HTMLDivElement
let root: Root
let phone = false

beforeEach(() => {
  phone = false
  Element.prototype.getAnimations = () => []
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
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // a case's spies, such as the reading position's boxes, end with it
  vi.restoreAllMocks()
})

/* When the file started, so a case that moves the clock keeps its days. */
const STARTED = Date.now()

/** `hours`:`minutes` on the day `offset` days from the day the file
    started, local time. */
const at = (offset: number, hours: number, minutes = 0) => {
  const d = new Date(STARTED)
  d.setDate(d.getDate() + offset)
  return d.setHours(hours, minutes, 0, 0)
}
/** Today's date `offset` days on, YYYY-MM-DD, local time. */
const day = (offset: number) => {
  const d = new Date(at(offset, 12))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const rootOf = () => document.querySelector<HTMLElement>('[data-overview-root]')
const state = () => rootOf()?.dataset.overviewState
const figure = (name: string, within = document.body) =>
  within.querySelector<HTMLElement>(`[data-ov-figure="${name}"]`)
const strip = () => document.querySelector<HTMLElement>('[data-ov-strip]') ?? document.body
const list = (kind: 'attention' | 'paused') =>
  document.querySelector<HTMLElement>(`[data-ov-list="${kind}"]`)
const rows = (kind: 'attention' | 'paused') => [
  ...(list(kind)?.querySelectorAll<HTMLElement>(
    kind === 'paused' ? '[data-ovrow]' : '[data-atrisk]',
  ) ?? []),
]
const sentence = () => document.querySelector('[data-ov-summary]')?.textContent ?? ''
const message = () =>
  document.querySelector('[data-empty-state] [data-empty-state-title]')?.textContent
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null)?.click())

/** Sets the page's visibility, as the browser does when a tab hides. */
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

/** A top-level project, Plan, over two sub-projects, One (the fixture's)
    and Two, that tracks delay. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One', track_delay: true })
  snap.projects.push({ ...base, id: 'two', key: 'TWO', num: 3, name: 'Two', parent_id: 'plan' })
}

/** `n` overdue tasks and `n` paused ones in One, with one more of each in
    Two, and a Done task. */
const work =
  (n = 3) =>
  (snap: Snapshot) => {
    plan(snap)
    let num = 0
    for (let i = 0; i < n; i++) {
      snap.issues.push({ ...taskRow(snap, `late${i}`, 'progress', ++num), due_date: day(-10 - i) })
      snap.issues.push({ ...taskRow(snap, `held${i}`, 'todo', ++num), paused: true })
    }
    snap.issues.push({
      ...taskRow(snap, 'two-late', 'review', ++num),
      project_id: 'two',
      due_date: day(-2),
    })
    snap.issues.push({ ...taskRow(snap, 'done', 'done', ++num), due_date: day(-30) })
  }

type Board = Awaited<ReturnType<typeof loadBoard>>

/** Loads the fixture with `prepare` over `scope` and renders the Overview,
    with its actions recorded; `force` answers the Overview's queries' states
    from the first subscription on. */
async function overview(
  prepare: (snap: Snapshot) => void,
  { scope = 'plan', force = {} as ForcedOverview, hold = false } = {},
) {
  const board = await loadBoard(network, prepare, { scope })
  board.server.overview.force = force
  board.server.overview.hold = hold
  const { Overview } = await import('./Overview')
  const opened: string[] = []
  const actions = {
    setScope: vi.fn(),
    setView: vi.fn(),
    openIssue: (id: string) => opened.push(id),
    newIssue: vi.fn(),
    newProject: vi.fn(),
    newMilestone: vi.fn(),
    editMilestone: vi.fn(),
    openPalette: vi.fn(),
  }
  const render = (view?: (info: ScopeInfo) => React.ReactNode) =>
    board.renderView(root, view ?? ((info) => <Overview info={info} actions={actions} />))
  await render()
  return { board, actions, opened, Overview, render }
}

/** Forces `force` and has every Overview read answer again. */
async function reanswer(board: Board, force: ForcedOverview) {
  board.server.overview.force = force
  await board.answer()
}

describe('the Overview from its answers', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the summary's counts, the delays and the first batch of each list, with their markers", async () => {
    await overview(work())
    expect(state()).toBe('ok')
    expect(rootOf()?.getAttribute('aria-busy')).toBeNull()
    // 3 late and 3 paused leaves in One, a task in review in Two and a Done one
    expect(figure('completion', strip())?.textContent).toContain('1 of 8 tasks done')
    expect(figure('completion', strip())?.dataset.ovFigureState).toBe('ok')
    expect(figure('progress', strip())?.textContent).toContain('3')
    expect(figure('review')?.textContent).toBe('1 in review')
    expect(figure('paused', strip())?.textContent).toContain('3')
    expect(sentence()).toBe('4 tasks are overdue.')
    expect(figure('overdue')?.textContent).toBe('4')
    expect(figure('at-risk')?.textContent).toBe(', 4')
    expect(list('attention')?.dataset.ovListState).toBe('ok')
    expect(list('attention')?.dataset.ovListEnd).toBe('')
    expect(list('attention')?.dataset.ovBatches).toBe('1')
    expect(rows('attention').map((r) => r.dataset.risk)).toEqual([
      'overdue',
      'overdue',
      'overdue',
      'overdue',
    ])
    // in the server's order: earliest due date first
    expect(rows('attention')[0]?.textContent).toContain('12d overdue')
    expect(rows('paused')).toHaveLength(3)
    expect(list('paused')?.dataset.ovListEnd).toBe('')
    expect(document.querySelector('[data-ov-table]')).not.toBeNull()
  })

  it('shows loading with no figure until the summary answers, then the figures', async () => {
    const { board } = await overview(work(), { hold: true })
    expect(state()).toBe('loading')
    expect(rootOf()?.getAttribute('aria-busy')).toBe('true')
    expect(figure('completion', strip())?.dataset.ovFigureState).toBe('loading')
    expect(figure('completion', strip())?.textContent).toContain('…')
    expect(strip().textContent).not.toMatch(/\d+%|\d+ of \d+/)
    expect(sentence()).toBe('…')
    expect(list('paused')?.dataset.ovListState).toBe('loading')
    board.server.overview.hold = false
    await board.answer()
    expect(state()).toBe('ok')
  })

  it('never shows a digit for a figure the server is counting or could not count', async () => {
    for (const force of [{ counts: 'counting' }, { counts: 'budget' }] as ForcedOverview[]) {
      await overview(work(), { force })
      const states = ['completion', 'progress', 'paused'].map(
        (name) => figure(name, strip())?.dataset.ovFigureState,
      )
      expect(states).toEqual(
        force.counts === 'counting'
          ? ['counting', 'counting', 'counting']
          : ['unavailable', 'unavailable', 'unavailable'],
      )
      for (const name of ['completion', 'progress', 'paused']) {
        const cell = figure(name, strip())
        expect(cell?.querySelector('.font-mono')?.textContent).not.toMatch(/\d/)
      }
      expect(figure('review')).toBeNull()
      expect(document.querySelector('h2 [data-ov-figure="paused"]')?.textContent).toBe('')
      if (force.counts === 'counting') {
        expect(strip().textContent).toContain('Counting…')
        expect(document.querySelector('[data-ov-counting]')?.textContent).toBe(
          'Qivo is counting the tasks here. The figures show once it is done.',
        )
      } else {
        expect(document.querySelector('[data-ov-counts-note]')?.textContent).toBe(
          'Qivo could not count the tasks here in one request. Open a sub-project to see its figures.',
        )
        // the counts' budget takes Overdue with it
        expect(sentence()).toBe('Qivo could not check every deadline here.')
      }
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('explains an unavailable Overdue and never says there is no deadline warning', async () => {
    await overview(work(), { force: { overdue: 'budget' } })
    expect(sentence()).toBe('Qivo could not check every deadline here.')
    const note = figure('overdue')
    expect(note?.dataset.ovFigureState).toBe('unavailable')
    expect(note?.dataset.ovReason).toBe('budget')
    expect(note?.textContent).toBe(
      'Qivo could not count every overdue task here in one request. Done tasks count toward that until the nightly archive takes them, 30 days after they were done. Open a sub-project to see its figures.',
    )
    expect(figure('at-risk')?.dataset.ovFigureState).toBe('unavailable')
    expect(figure('at-risk')?.textContent).toBe('')
    expect(document.body.textContent).not.toContain('No deadline warnings')
  })

  it("says a guest's projections are not available, one person at a time", async () => {
    const { board } = await overview(
      (snap) => {
        work()(snap)
        snap.profiles[0].org_role = 'guest'
        snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'user' })
      },
      { force: { projected: 'loads' } },
    )
    expect(sentence()).toBe('4 tasks are overdue.')
    expect(figure('projected')?.textContent).toBe(
      'Your access shows other people’s work one person at a time, so projected delays are not available here.',
    )
    expect(figure('projected')?.dataset.ovReason).toBe('loads')
    expect(figure('at-risk')?.textContent).toBe('')
    // staff read the other sentence
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview(work(), { force: { projected: 'loads' } })
    expect(figure('projected')?.textContent).toBe(
      'Someone here has more open work than Qivo reads at once, so projected delays are not available.',
    )
    void board
  })

  it('walks the sentence ladder for a projection that does not fit', async () => {
    await overview(
      (snap) => {
        plan(snap)
        snap.issues.push({ ...taskRow(snap, 'p', 'todo', 1), paused: true })
      },
      { force: { projected: 'budget' } },
    )
    expect(sentence()).toBe('Qivo could not check every deadline here.')
    expect(figure('projected')?.textContent).toBe(
      'Qivo could not work out every projected delay here in one request.',
    )
  })

  it('shows unknown rows as unknown, not late, and says why', async () => {
    // a task whose projection needs its owner's load, which no batch reads
    const { board } = await overview((snap) => {
      plan(snap)
      snap.issues.push({
        ...taskRow(snap, 'later', 'todo', 1),
        due_date: day(14),
        end_week: day(7),
        remaining_hours: 400,
        remaining_set_at: new Date().toISOString(),
      })
    })
    await reanswer(board, { unknown: [board.snapshot.profiles[0].id] })
    const [row] = rows('attention')
    expect(row?.dataset.risk).toBe('unknown')
    expect(row?.textContent).toContain('risk unknown')
    expect(row?.querySelector('.text-danger')).toBeNull()
    expect(document.querySelector('[data-ov-unknown]')?.textContent).toBe(
      "Qivo could not read some owners' other work, so tasks marked risk unknown may not be late.",
    )
  })

  it('says a list is incomplete where its batch stopped, and goes on from there with Load more', async () => {
    const { board } = await overview(work(8), { force: { list: 'incomplete' } })
    expect(list('paused')?.dataset.ovListState).toBe('incomplete')
    expect(list('paused')?.querySelector('[data-ov-incomplete]')?.textContent).toBe(
      'Qivo checked part of the list. Load more continues.',
    )
    expect(list('paused')?.dataset.ovListEnd).toBeUndefined()
    board.server.overview.force = {}
    await click(list('paused')?.querySelector('[data-ov-more]'))
    expect(rows('paused')).toHaveLength(8)
    expect(list('paused')?.dataset.ovListEnd).toBe('')
  })

  it('loads more of a list to its end, never sorting or cutting a batch', async () => {
    await overview(work(25))
    expect(rows('paused')).toHaveLength(10)
    const order = () => rows('paused').map((r) => r.dataset.ovrow)
    const first = order()
    await click(list('paused')?.querySelector('[data-ov-more]'))
    expect(order().slice(0, 10)).toEqual(first)
    expect(rows('paused')).toHaveLength(20)
    await click(list('paused')?.querySelector('[data-ov-more]'))
    expect(rows('paused')).toHaveLength(25)
    expect(list('paused')?.dataset.ovListEnd).toBe('')
    expect(list('paused')?.querySelector('[data-ov-more]')).toBeNull()
    expect(list('paused')?.dataset.ovBatches).toBe(
      String(list('paused')?.querySelectorAll('[data-ov-batch]').length),
    )
  })

  it('shows a refusal, a list over budget and a failure in place, with Try again', async () => {
    const { board } = await overview(work(), { force: { list: 'over_budget' } })
    expect(list('paused')?.dataset.ovListState).toBe('over_budget')
    expect(list('paused')?.textContent).toContain('Qivo could not check this list.')
    expect(list('paused')?.dataset.ovListEnd).toBeUndefined()
    board.server.overview.force = {}
    await click(
      [...(list('paused')?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'Try again',
      ),
    )
    expect(list('paused')?.dataset.ovListState).toBe('ok')
    expect(rows('paused')).toHaveLength(3)
  })
})

describe('the root states', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('says why for an unavailable scope, access unchecked, over budget and a failed summary, the milestones staying under it', async () => {
    const withMilestone = (snap: Snapshot) => {
      work()(snap)
      snap.milestones.push({
        id: 'm1',
        project_id: 'plan',
        name: 'Ship',
        week: day(21),
        created_at: '2026-09-14T08:00:00.000Z',
      })
    }
    const cases: [ForcedOverview, string, string][] = [
      [{ scope: 'unavailable' }, 'unavailable', 'This Overview is not available'],
      [{ scope: 'access_unchecked' }, 'unavailable', 'This Overview is not available'],
      [
        { scope: 'over_budget' },
        'over_budget',
        "This view could not be loaded within the Overview's limits.",
      ],
    ]
    for (const [force, expected, title] of cases) {
      await overview(withMilestone, { force })
      expect(state()).toBe(expected)
      expect(message()).toBe(title)
      expect(document.querySelector('[data-overview-milestone]')).not.toBeNull()
      if (force.scope === 'access_unchecked') {
        expect(rootOf()?.dataset.ovReason).toBe('access_unchecked')
        expect(document.body.textContent).toContain(
          'Qivo could not check all of your access in time.',
        )
        expect(
          [...document.querySelectorAll('[data-empty-state] button')].map((b) => b.textContent),
        ).not.toContain('Try again')
      }
      // a top-level project past the budget offers its sub-projects
      if (force.scope === 'over_budget')
        expect(
          [...document.querySelectorAll('[data-ov-choice]')].map((b) =>
            b.getAttribute('data-ov-choice'),
          ),
        ).toHaveLength(2)
      await act(async () => root.unmount())
      root = createRoot(container)
    }
    const { board } = await overview(withMilestone)
    board.server.overview.fail = new Error('network')
    board.server.overview.failing = (query) => query === 'summary'
    await board.answer()
    expect(state()).toBe('error')
    expect(message()).toBe('The Overview could not be loaded')
    expect(figure('completion')).toBeNull()
    board.server.overview.fail = undefined
    await click(
      [...document.querySelectorAll('[data-empty-state] button')].find(
        (b) => b.textContent === 'Try again',
      ),
    )
    expect(state()).toBe('ok')
  })

  it("shows one sub-project's status distribution from the counts, and its own note past the budget", async () => {
    await overview(work(), { scope: '' })
    expect(figure('status')?.dataset.ovFigureState).toBe('ok')
    expect(figure('status')?.textContent).toContain('In Progress 3')
    await act(async () => root.unmount())
    root = createRoot(container)
    const { actions } = await overview(work(), { scope: '', force: { scope: 'over_budget' } })
    expect(document.body.textContent).toContain('Open its Board, or find its tasks with Search.')
    await click(
      [...document.querySelectorAll('[data-empty-state] button')].find(
        (b) => b.textContent === 'Search this sub-project',
      ),
    )
    expect(actions.openPalette).toHaveBeenCalled()
  })
})

describe('All projects and My view', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('asks to choose a project in All projects, with no read of its own', async () => {
    const { board, actions } = await overview(work(), { scope: 'all' })
    expect(state()).toBe('choose')
    expect(message()).toBe('Choose a project')
    expect(document.body.textContent).toContain(
      'The Overview shows one project at a time. Pick one to see its summary.',
    )
    expect(board.server.overview.asked).toEqual([])
    expect(document.querySelector('[data-board-choice]')).toBeNull()
    // with no milestone to show, the chooser is the whole page
    expect([...document.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain(
      'Milestones',
    )
    await click(document.querySelector('[data-ov-choice="plan"]'))
    expect(actions.setScope).toHaveBeenCalledWith('plan')
  })

  it("lets go of a project's reads and rows when the page moves to All projects", async () => {
    const { board, Overview, actions, render } = await overview(work())
    const { __layerProbe } = await import('../store/planner')
    if (!__layerProbe) throw new Error('the layer probe is test-only')
    const slots = () =>
      Object.keys(__layerProbe.rows()).filter((section) => section.startsWith('view:overview:'))
    expect(slots().length).toBeGreaterThan(0)
    // App mounts the page anew for All projects, which asks for no read
    const all = board.P.scopeInfo('all') as ScopeInfo
    await render(() => <Overview key="all" info={all} actions={actions} />)
    expect(state()).toBe('choose')
    expect(board.server.overview.open.size).toBe(0)
    expect(slots()).toEqual([])
  })

  it("shows My view's own tasks, with their projects, and its notes once the answer decides them", async () => {
    await overview(
      (snap) => {
        work()(snap)
        const me = snap.profiles[0].id
        for (const t of snap.issues) t.assignee_id = t.id.startsWith('late') ? me : undefined
      },
      { scope: 'mine' },
    )
    expect(state()).toBe('ok')
    expect(rows('attention')).toHaveLength(3)
    expect(rows('paused')).toHaveLength(0)
    expect(list('paused')?.textContent).toContain('Nothing is paused right now.')
    // My view names each row's project
    expect(rows('attention')[0]?.textContent).toContain('Plan')
    await act(async () => root.unmount())
    root = createRoot(container)
    const { board } = await overview(
      (snap) => {
        work()(snap)
        for (const t of snap.issues) t.assignee_id = undefined
      },
      { scope: 'mine', hold: true },
    )
    // no note before the answer that decides it
    expect(message()).toBeUndefined()
    board.server.overview.hold = false
    await board.answer()
    expect(message()).toBe('Nothing assigned to you')
  })

  it('lays the page out for the phone with the same reads, notes and Load more', async () => {
    phone = true
    await overview(work(12), { force: { counts: 'counting' } })
    expect(document.querySelector('.mobile-health-list')).not.toBeNull()
    expect(strip().textContent).toContain('Counting…')
    expect(rows('paused')).toHaveLength(10)
    await click(list('paused')?.querySelector('[data-ov-more]'))
    expect(rows('paused')).toHaveLength(12)
  })
})

describe('rows and the person’s own writes', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('opens a row of a task only the answer brings from the window’s own read', async () => {
    const { board, opened } = await overview(work())
    const far: OverviewRow = {
      ...(taskRow(board.snapshot, 'far', 'todo', 90) as unknown as OverviewRow),
      paused: true,
      has_subtasks: false,
      has_hidden_subtasks: false,
    }
    Reflect.deleteProperty(far, 'description')
    board.server.overview.edit = (query, answer) =>
      query === 'paused' && (answer as ListAnswer).state === 'ok'
        ? { ...(answer as object), rows: [...(answer as ListAnswer & { state: 'ok' }).rows, far] }
        : answer
    await board.answer()
    const row = rows('paused').at(-1)
    expect(board.P.handleOf('far')).toBeNull()
    await click(row)
    expect(opened.at(-1)).toBe(row?.dataset.ovrow)
    // the registry of the store's own module instance
    const { openedTaskList } = await import('../lib/openedTasks')
    expect(openedTaskList().some((task) => task.uuid === 'far')).toBe(true)
  })

  it('takes away at once the row of a task the person archives, and nothing else', async () => {
    const { board } = await overview(work())
    // the server accepts the archive; no delivery holds it yet
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'issues:archive' ? Promise.resolve(null) : new Promise(() => {}),
    )
    const [first] = rows('paused')
    await act(async () => {
      await board.P.archiveIssue(first?.dataset.ovrow ?? '')
    })
    expect(rows('paused').map((r) => r.dataset.ovrow)).not.toContain(first?.dataset.ovrow)
    expect(rows('paused')).toHaveLength(2)
    // the count is the summary's, which waits for the answer
    expect(figure('paused', strip())?.textContent).toContain('3')
  })
})

describe('hidden, kept and a new day', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('holds no read while the tab hides and shows its answers refreshing on return', async () => {
    const { board } = await overview(work())
    expect(board.server.overview.open.size).toBeGreaterThan(0)
    await setVisibility('hidden')
    expect(board.server.overview.open.size).toBe(0)
    expect(state()).toBe('refreshing')
    board.server.overview.hold = true
    await setVisibility('visible')
    expect(state()).toBe('refreshing')
    expect(figure('completion', strip())?.dataset.ovFigureState).toBe('refreshing')
    expect(rows('paused')).toHaveLength(3)
    board.server.overview.hold = false
    await board.answer()
    expect(state()).toBe('ok')
  })

  it('keeps an empty note while its answers refresh on return', async () => {
    const hideAndShow = async (board: Board, note: string) => {
      expect(message()).toBe(note)
      await setVisibility('hidden')
      board.server.overview.hold = true
      await setVisibility('visible')
      expect(state()).toBe('refreshing')
      expect(message()).toBe(note)
      board.server.overview.hold = false
      await board.answer()
      expect(state()).toBe('ok')
      expect(message()).toBe(note)
    }
    // a top-level project with sub-projects and no task
    let { board } = await overview(plan)
    await hideAndShow(board, 'No tasks yet')
    await act(async () => root.unmount())
    root = createRoot(container)
    ;({ board } = await overview(
      (snap) => {
        work()(snap)
        for (const t of snap.issues) t.assignee_id = undefined
      },
      { scope: 'mine' },
    ))
    await hideAndShow(board, 'Nothing assigned to you')
  })

  it('holds no read while its kept page hides', async () => {
    const { board, Overview, actions, render } = await overview(work())
    const { KeptView } = await import('../components/KeptView')
    const kept = (shown: boolean) =>
      render((info) => (
        <KeptView view="overview" shown={shown} className="view">
          <Overview info={info} actions={actions as never} />
        </KeptView>
      ))
    await kept(true)
    expect(board.server.overview.open.size).toBeGreaterThan(0)
    await kept(false)
    expect(board.server.overview.open.size).toBe(0)
    await kept(true)
    expect(board.server.overview.open.size).toBeGreaterThan(0)
  })

  it("asks the new day's figures after midnight in a hidden tab, never yesterday's", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at(0, 23, 50))
    const { board } = await overview(work())
    const days = () =>
      board.server.overview.asked.filter((a) => a.query === 'summary').map((a) => a.args.day)
    expect(days().at(-1)).toBe(day(0))
    await setVisibility('hidden')
    vi.setSystemTime(at(1, 0, 10))
    const asked = board.server.overview.asked.length
    await setVisibility('visible')
    expect(
      board.server.overview.asked
        .slice(asked)
        .every((a) => a.query === 'paused' || a.args.day === day(1)),
    ).toBe(true)
    expect(days().at(-1)).toBe(day(1))
    expect(state()).toBe('ok')
  })

  it('asks nothing for yesterday when a kept page shows again after midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at(0, 23, 50))
    const { board, Overview, actions, render } = await overview(work())
    const { KeptView } = await import('../components/KeptView')
    const kept = (shown: boolean) =>
      render((info) => (
        <KeptView view="overview" shown={shown} className="view">
          <Overview info={info} actions={actions as never} />
        </KeptView>
      ))
    await kept(true)
    await kept(false)
    vi.setSystemTime(at(1, 0, 10))
    const asked = board.server.overview.asked.length
    await kept(true)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const since = board.server.overview.asked.slice(asked)
    expect(since.some((a) => a.query === 'summary')).toBe(true)
    expect(since.every((a) => a.query === 'paused' || a.args.day === day(1))).toBe(true)
  })
})

describe('keyboard focus in the lists', { timeout: BOARD_TEST_TIMEOUT }, () => {
  /** The button of list `kind` that reads `text`. */
  const button = (kind: 'attention' | 'paused', text: string) =>
    [...(list(kind)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent === text,
    )

  it('keeps focus on Load more while its batch loads, and on the list after a Retry', async () => {
    const { board } = await overview(work(25))
    const more = list('paused')?.querySelector<HTMLButtonElement>('[data-ov-more]')
    if (!more) throw new Error('no Load more')
    more.focus()
    board.server.overview.hold = true
    await click(more)
    // it stays a button focus can stay on, with no action while it loads
    expect(list('paused')?.querySelector('[data-ov-more]')).toBe(more)
    expect(more.disabled).toBe(false)
    expect(more.getAttribute('aria-disabled')).toBe('true')
    expect(more.textContent).toBe('Loading…')
    expect(document.activeElement).toBe(more)
    const asked = board.server.overview.asked.length
    await click(more)
    expect(board.server.overview.asked).toHaveLength(asked)
    board.server.overview.hold = false
    await board.answer()
    expect(rows('paused')).toHaveLength(20)
    expect(more.getAttribute('aria-disabled')).toBeNull()
    expect(document.activeElement).toBe(more)
    // the next batch fails: Load more leaves and its focus goes to the
    // Retry in its place, which goes with its press, so focus stays in the
    // list
    board.server.overview.fail = new Error('network')
    board.server.overview.failing = (query, args) =>
      query === 'paused' && args.cursor !== undefined && args.end === undefined
    await click(more)
    expect(list('paused')?.querySelector('[data-ov-more]')).toBeNull()
    const retry = button('paused', 'Retry')
    if (!retry) throw new Error('no Retry')
    expect(document.activeElement).toBe(retry)
    board.server.overview.fail = undefined
    await click(retry)
    expect(rows('paused')).toHaveLength(25)
    expect(document.activeElement).toBe(list('paused'))
  })

  it('moves focus from Load more to the list where its batch ends the list, unless it moved on', async () => {
    const { board } = await overview(work(15))
    const more = list('paused')?.querySelector<HTMLButtonElement>('[data-ov-more]')
    if (!more) throw new Error('no Load more')
    more.focus()
    board.server.overview.hold = true
    await click(more)
    expect(document.activeElement).toBe(more)
    board.server.overview.hold = false
    await board.answer()
    // the last batch came: Load more leaves, and focus stays in the list
    expect(rows('paused')).toHaveLength(15)
    expect(list('paused')?.querySelector('[data-ov-more]')).toBeNull()
    expect(document.activeElement).toBe(list('paused'))
    // focus that moved on while the last batch loaded stays where it went
    const other = list('attention')?.querySelector<HTMLButtonElement>('[data-ov-more]')
    if (!other) throw new Error('no Load more')
    other.focus()
    board.server.overview.hold = true
    await click(other)
    const away = list('paused')
    away?.focus()
    board.server.overview.hold = false
    await board.answer()
    expect(rows('attention')).toHaveLength(16)
    expect(list('attention')?.querySelector('[data-ov-more]')).toBeNull()
    expect(document.activeElement).toBe(away)
  })

  it('moves focus to the list after Try again and Show from the start', async () => {
    const { board } = await overview(work(70), { force: { list: 'over_budget' } })
    const again = button('paused', 'Try again')
    if (!again) throw new Error('no Try again')
    again.focus()
    board.server.overview.force = {}
    await click(again)
    expect(rows('paused')).toHaveLength(10)
    expect(document.activeElement).toBe(list('paused'))
    // past the cap, Show from the start goes with its press too
    for (let i = 0; i < 5; i++) await click(list('paused')?.querySelector('[data-ov-more]'))
    const start = list('paused')?.querySelector<HTMLButtonElement>('[data-ov-from-start]')
    if (!start) throw new Error('no Show from the start')
    start.focus()
    await click(start)
    expect(list('paused')?.querySelector('[data-ov-from-start]')).toBeNull()
    expect(document.activeElement).toBe(list('paused'))
  })
})

describe('the reading position', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('keeps the first batch left on screen in its place when the cap drops earlier ones', async () => {
    // jsdom has no scroll anchoring, as Safari has none, so the list keeps
    // its place by hand
    await overview(work(70))
    const pane = rootOf() as HTMLElement
    let scrollTop = 0
    // the pane grows shorter when the first batch goes, and clamps its
    // scroll position to the new height until it scrolls again
    let clamped = false
    const dropped = () => !!list('paused')?.querySelector('[data-ov-dropped]')
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => (dropped() && !clamped ? Math.min(scrollTop, 1300) : scrollTop),
      set: (v: number) => {
        scrollTop = v
        clamped = dropped()
      },
    })
    // each batch stands 600px below the one before, in the pane's content
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const batches = [...document.querySelectorAll('[data-ov-list="paused"] [data-ov-batch]')]
      const i = batches.indexOf(this)
      const top = (i < 0 ? 0 : 100 + i * 600) - (this === pane ? 0 : pane.scrollTop)
      return new DOMRect(0, this === pane ? 0 : top, 100, 100)
    })
    const more = () => click(list('paused')?.querySelector('[data-ov-more]'))
    // 50 rows after four presses, in batches the list merged
    for (let i = 0; i < 4; i++) await more()
    expect(rows('paused')).toHaveLength(50)
    expect(list('paused')?.querySelector('[data-ov-dropped]')).toBeNull()
    // the person scrolls down, as the browser tells the pane
    scrollTop = 2000
    await act(async () => pane.dispatchEvent(new Event('scroll')))
    const keep = list('paused')
      ?.querySelectorAll('[data-ov-batch]')[1]
      ?.getAttribute('data-ov-batch')
    await more()
    expect(list('paused')?.querySelector('[data-ov-dropped]')?.textContent).toContain(
      'Earlier tasks are not shown.',
    )
    const now = [...(list('paused')?.querySelectorAll('[data-ov-batch]') ?? [])].map((b) =>
      b.getAttribute('data-ov-batch'),
    )
    expect(now[0]).toBe(keep)
    // the batch that is first now moved up by one batch: the pane follows,
    // from where it stood before the drop
    expect(pane.scrollTop).toBe(2000 - 600)
  })
})

// ------------------------------------------------------------- the health table

const table = () => document.querySelector<HTMLElement>('[data-ov-health]')
const healthState = () => table()?.dataset.ovHealthState
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-ovcard]')]
const cardIds = () => cards().map((c) => c.dataset.ovcard)
const cell = (card: Element | undefined, name: string) =>
  card?.querySelector<HTMLElement>(`[data-ovcell="${name}"]`)
const heading = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-ov-table] th')].find((th) =>
    th.textContent?.startsWith(label),
  )
const healthAsked = (board: Board) =>
  board.server.overview.asked.filter((a) => a.query === 'health').map((a) => a.args)

/** `n` sub-projects of Plan, One and Two first, then Part 03 to Part `n`,
    with the work of `work()` in One and Two. */
const parts =
  (n: number) =>
  (snap: Snapshot): void => {
    work()(snap)
    const base = snap.projects.find((p) => p.name === 'One') as Snapshot['projects'][number]
    for (let i = 3; i <= n; i++)
      snap.projects.push({
        ...base,
        id: `part${i}`,
        key: `P${i}`,
        num: 10 + i,
        name: `Part ${String(i).padStart(2, '0')}`,
      })
  }

/** Types `text` into the health table's search, as a person does, and
    waits for it to rest. */
async function typeSearch(text: string) {
  const input = document.querySelector<HTMLInputElement>('[data-ov-health-search]')
  if (!input) throw new Error('no search box')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
  await act(async () => {})
}

describe('the health table', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the server's rows in its order with their figures and markers, and opens a row's Board", async () => {
    const { board, actions } = await overview(work())
    expect(healthState()).toBe('ok')
    expect(table()?.getAttribute('aria-busy')).toBeNull()
    expect(table()?.dataset.ovHealthEnd).toBe('')
    // most Delayed first: One holds three overdue tasks, Two one
    const one = board.snapshot.projects.find((p) => p.name === 'One')?.id
    expect(cardIds()).toEqual([one, 'two'])
    expect(cell(cards()[0], 'late')?.textContent).toBe('3')
    expect(cell(cards()[0], 'paused')?.textContent).toBe('3')
    expect(cell(cards()[0], 'done')?.textContent).toBe('1/7')
    expect(cell(cards()[1], 'paused')?.textContent).toBe('—')
    expect(cell(cards()[1], 'late')?.dataset.ovFigureState).toBe('ok')
    expect(heading('Delayed')?.getAttribute('aria-sort')).toBe('descending')
    expect(heading('Progress')?.getAttribute('aria-sort')).toBeNull()
    // no search box for two rows, and no Load more
    expect(document.querySelector('[data-ov-health-search]')).toBeNull()
    expect(document.querySelector('[data-ov-health-more]')).toBeNull()
    await click(cards()[1]?.querySelector('button'))
    expect(actions.setScope).toHaveBeenCalledWith('two')
    expect(actions.setView).toHaveBeenCalledWith('kanban')
  })

  it('asks only the health read for a new order, keeping the rows shown, dimmed, until the answer', async () => {
    const { board } = await overview(work())
    const open = [...board.server.overview.open].filter((sub) => sub.query !== 'health')
    const asked = board.server.overview.asked.length
    board.server.overview.hold = (query) => query === 'health'
    await click(heading('Sub-project')?.querySelector('button'))
    expect(board.server.overview.asked.slice(asked).map((a) => a.query)).toEqual(['health'])
    expect(healthAsked(board).at(-1)).toMatchObject({ sort: 'name', dir: 'asc', limit: 10 })
    // the summary's, the delays' and the lists' subscriptions stay
    for (const sub of open) expect(board.server.overview.open.has(sub)).toBe(true)
    expect(table()?.dataset.ovHealthKept).toBe('')
    expect(healthState()).toBe('refreshing')
    expect(table()?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('[data-ov-table] tbody')?.className).toContain('opacity-60')
    expect(heading('Delayed')?.getAttribute('aria-sort')).toBe('descending')
    board.server.overview.hold = false
    await board.answer()
    expect(table()?.dataset.ovHealthKept).toBeUndefined()
    expect(healthState()).toBe('ok')
    expect(cards().map((c) => c.textContent?.slice(0, 3))).toEqual(['One', 'Two'])
    expect(heading('Sub-project')?.getAttribute('aria-sort')).toBe('ascending')
    // a second press flips the direction the rows are in
    await click(heading('Sub-project')?.querySelector('button'))
    expect(healthAsked(board).at(-1)).toMatchObject({ sort: 'name', dir: 'desc' })
  })

  it('never shows a digit in a cell whose figure is counting or unavailable', async () => {
    for (const health of [{ counts: 'counting' }, { counts: 'budget' }] as const) {
      await overview(work(), { force: { health } })
      for (const card of cards())
        for (const name of ['progress', 'done', 'left', 'paused']) {
          const c = cell(card, name)
          expect(c?.dataset.ovFigureState, `${health.counts} ${name}`).toBe(
            health.counts === 'counting' ? 'counting' : 'unavailable',
          )
          // a cell that showed a 0 or a count here would fail
          expect(c?.textContent, `${health.counts} ${name}`).not.toMatch(/\d/)
          expect(c?.dataset.ovReason).toBe(health.counts === 'counting' ? undefined : 'budget')
        }
      expect(cell(cards()[0], 'progress')?.textContent).toBe(
        health.counts === 'counting' ? 'Counting…' : 'unknown',
      )
      if (health.counts === 'counting') expect(cell(cards()[0], 'done')?.textContent).toBe('…')
      await act(async () => root.unmount())
      root = createRoot(container)
    }
    await overview(work(), { force: { health: { delays: 'loads' } } })
    for (const card of cards())
      for (const name of ['late', 'behind']) {
        expect(cell(card, name)?.textContent).toBe('unknown')
        expect(cell(card, name)?.dataset.ovReason).toBe('loads')
      }
  })

  it('says why it sorts by name, for staff, for a guest and while the counts are counting', async () => {
    const note = () => document.querySelector('[data-ov-health-by-name]')?.textContent
    const { board } = await overview(work(), { force: { health: { delays: 'budget' } } })
    expect(note()).toBe(
      'Sorted by name, because Qivo could not work out the delays of every sub-project here.',
    )
    expect(heading('Sub-project')?.getAttribute('aria-sort')).toBe('ascending')
    // a press on Delayed asks Delayed, which the server answers by name again
    await click(heading('Delayed')?.querySelector('button'))
    expect(healthAsked(board).at(-1)).toMatchObject({ sort: 'late', dir: 'desc' })
    await act(async () => root.unmount())
    root = createRoot(container)
    const guest = await overview(
      (snap) => {
        work()(snap)
        snap.profiles[0].org_role = 'guest'
        snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'user' })
      },
      { force: { health: { delays: 'loads' } } },
    )
    expect(note()).toBe(
      'Sorted by name, because your access shows other people’s work one person at a time.',
    )
    // the order says why, also where the rows without their delays are past
    // the rows shown
    guest.board.server.overview.edit = (query, answer) => {
      const health = answer as HealthAnswer
      return query === 'health' && health.state === 'ok'
        ? {
            ...health,
            rows: health.rows.map((r) => ({ ...r, delays: { state: 'ok', late: 0, behind: 0 } })),
          }
        : answer
    }
    await guest.board.answer()
    expect(cell(cards()[0], 'late')?.dataset.ovFigureState).toBe('ok')
    expect(note()).toBe(
      'Sorted by name, because your access shows other people’s work one person at a time.',
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    const counting = await overview(work(), { force: { health: { counts: 'counting' } } })
    await click(heading('Progress')?.querySelector('button'))
    await counting.board.answer()
    expect(note()).toBe('Sorted by name while Qivo counts the tasks here.')
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview(work(), { force: { health: { counts: 'budget' } } })
    await click(heading('Progress')?.querySelector('button'))
    expect(note()).toBe(
      'Sorted by name, because Qivo could not count the tasks here in one request.',
    )
  })

  it('searches the whole table once it holds more than one batch, rested, within its limit, saying when nothing matches', async () => {
    const { board } = await overview(parts(25))
    expect(cards()).toHaveLength(10)
    expect(document.querySelector('[data-ov-health-search]')?.getAttribute('aria-label')).toBe(
      'Search sub-projects',
    )
    await typeSearch('part 2')
    expect(healthAsked(board).at(-1)).toMatchObject({ search: 'part 2', limit: 10 })
    // every word anywhere: Part 12 and Part 20 to 25, past the first rows
    expect(cards().map((c) => c.textContent?.slice(0, 7))).toEqual([
      'Part 12',
      'Part 20',
      'Part 21',
      'Part 22',
      'Part 23',
      'Part 24',
      'Part 25',
    ])
    const before = healthAsked(board).length
    await typeSearch('x'.repeat(201))
    expect(document.querySelector('[data-ov-health-search-limit]')?.textContent).toBe(
      'A search must be at most 200 characters. Search for fewer words.',
    )
    expect(healthAsked(board).length).toBe(before)
    await typeSearch('nothing like it')
    expect(document.querySelector('[data-ov-health-none]')?.textContent).toBe(
      'No sub-project matches this search.',
    )
    expect(cards()).toHaveLength(0)
    await typeSearch('')
    expect(cards()).toHaveLength(10)
  })

  it('keeps the search box and its focus while a cleared search waits for its answer', async () => {
    const { board } = await overview(parts(25))
    const box = () => document.querySelector<HTMLInputElement>('[data-ov-health-search]')
    await typeSearch('part 2')
    expect(cards()).toHaveLength(7)
    const input = box()
    input?.focus()
    board.server.overview.hold = (query) => query === 'health'
    await typeSearch('')
    expect(healthAsked(board).at(-1)).not.toHaveProperty('search')
    expect(box()).toBe(input)
    expect(document.activeElement).toBe(input)
    board.server.overview.hold = false
    await board.answer()
    expect(cards()).toHaveLength(10)
    expect(box()).toBe(input)
    expect(document.activeElement).toBe(input)
  })

  it('starts the search again on a return to a scope typed in before, also on a page that stays mounted', async () => {
    const { board, Overview, actions, render } = await overview(parts(25))
    await typeSearch('part 2')
    const plan = board.P.scopeInfo('plan') as ScopeInfo
    const mine = board.P.scopeInfo('mine') as ScopeInfo
    await render(() => <Overview info={mine} actions={actions} />)
    await render(() => <Overview info={plan} actions={actions} />)
    expect(document.querySelector<HTMLInputElement>('[data-ov-health-search]')?.value).toBe('')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(healthAsked(board).at(-1)).toMatchObject({ sort: 'late', dir: 'desc', limit: 10 })
    expect(healthAsked(board).at(-1)).not.toHaveProperty('search')
    expect(cards()).toHaveLength(10)
  })

  it('loads 10 more rows on Load more to the end, keeping focus while they load and leaving it on the table at the end', async () => {
    const { board } = await overview(parts(25))
    const more = () => document.querySelector<HTMLButtonElement>('[data-ov-health-more]')
    more()?.focus()
    board.server.overview.hold = (query) => query === 'health'
    await click(more())
    expect(more()?.getAttribute('aria-disabled')).toBe('true')
    expect(more()?.textContent).toBe('Loading…')
    expect(document.activeElement).toBe(more())
    expect(cards()).toHaveLength(10)
    expect(table()?.dataset.ovHealthKept).toBe('')
    board.server.overview.hold = false
    await board.answer()
    expect(cards()).toHaveLength(20)
    expect(document.activeElement).toBe(more())
    await click(more())
    expect(cards()).toHaveLength(25)
    expect(more()).toBeNull()
    expect(table()?.dataset.ovHealthEnd).toBe('')
    expect(document.activeElement).toBe(table())
  })

  it('says it shows the first rows past the cap, and offers Retry where a Load more fails', async () => {
    await overview(parts(25), { force: { health: { most: 5 } } })
    expect(cards()).toHaveLength(5)
    expect(document.querySelector('[data-ov-health-more]')).toBeNull()
    expect(document.querySelector('[data-ov-health-cap]')?.textContent).toBe(
      'Qivo shows the first 5 sub-projects here. Search to find the others.',
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    const { board } = await overview(parts(25))
    board.server.overview.fail = new Error('down')
    board.server.overview.failing = (query, args) => query === 'health' && args.limit === 20
    const more = document.querySelector<HTMLButtonElement>('[data-ov-health-more]')
    more?.focus()
    await click(more)
    await board.answer()
    expect(document.querySelector('[data-ov-health] [role="alert"]')?.textContent).toContain(
      "Couldn't load more sub-projects.",
    )
    expect(cards()).toHaveLength(10)
    const retry = document.querySelector<HTMLButtonElement>('[data-ov-health-retry]')
    expect(document.activeElement).toBe(retry)
    board.server.overview.failing = () => false
    await click(retry)
    await board.answer()
    expect(cards()).toHaveLength(20)
  })

  it('shows each state with its sentence and Try again where it helps', async () => {
    const { board } = await overview(work(), { hold: true })
    expect(healthState()).toBe('loading')
    expect(table()?.getAttribute('aria-busy')).toBe('true')
    expect(table()?.textContent).toContain('Loading…')
    expect(cards()).toHaveLength(0)
    board.server.overview.hold = false
    await board.answer()
    expect(healthState()).toBe('ok')
    const cases = [
      [{ scope: 'unavailable' }, 'unavailable', 'Qivo cannot show this table here.', true],
      [
        { scope: 'access_unchecked' },
        'unavailable',
        'Qivo could not check all of your access in time. Try again in a moment.',
        false,
      ],
      [
        { scope: 'over_budget' },
        'over_budget',
        "This table could not be loaded within the Overview's limits. Open a sub-project to see its figures.",
        true,
      ],
    ] as const
    for (const [health, state, text, again] of cases) {
      await act(async () => root.unmount())
      root = createRoot(container)
      await overview(work(), { force: { health } })
      expect(healthState()).toBe(state)
      expect(document.querySelector('[data-ov-health-note]')?.textContent).toBe(
        again ? `${text}Try again` : text,
      )
      expect(!!document.querySelector('[data-ov-health-note] button')).toBe(again)
    }
    await act(async () => root.unmount())
    root = createRoot(container)
    const failing = await overview(work())
    failing.board.server.overview.fail = new Error('down')
    failing.board.server.overview.failing = (query) => query === 'health'
    await click(heading('Sub-project')?.querySelector('button'))
    expect(healthState()).toBe('error')
    expect(document.querySelector('[data-ov-health-note]')?.textContent).toBe(
      'The health table could not be loaded.Try again',
    )
    failing.board.server.overview.failing = () => false
    await click(document.querySelector('[data-ov-health-note] button'))
    await failing.board.answer()
    expect(healthState()).toBe('ok')
  })

  it("shows the phone's cards with their figures, unknown delays and counting", async () => {
    phone = true
    await overview(work(), { force: { health: { delays: 'loads', counts: 'counting' } } })
    expect(document.querySelector('.mobile-health-list')).not.toBeNull()
    expect(cards()).toHaveLength(2)
    expect(cell(cards()[0], 'late')?.textContent).toBe('delays unknown')
    expect(cell(cards()[0], 'progress')?.textContent).toBe('Counting…')
    expect(cell(cards()[0], 'done')?.textContent).toBe('… done')
    expect(document.querySelector<HTMLSelectElement>('#overview-health-sort')?.value).toBe('name')
  })

  it('shows Status distribution for one sub-project and asks no health read', async () => {
    const { board } = await overview(work(), { scope: 'two' })
    expect(document.querySelector('[data-ov-health]')).toBeNull()
    expect(figure('status')).not.toBeNull()
    expect(healthAsked(board)).toEqual([])
  })

  it('holds no health subscription while hidden and shows it refreshing on return', async () => {
    const { board } = await overview(work())
    await setVisibility('hidden')
    expect([...board.server.overview.open].some((sub) => sub.query === 'health')).toBe(false)
    board.server.overview.hold = true
    await setVisibility('visible')
    expect([...board.server.overview.open].some((sub) => sub.query === 'health')).toBe(true)
    expect(healthState()).toBe('refreshing')
    expect(cards()).toHaveLength(2)
    board.server.overview.hold = false
    await board.answer()
    expect(healthState()).toBe('ok')
  })

  it('asks the health read once a page that mounted in a hidden tab shows', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const { board } = await overview(work())
    expect(board.server.overview.open.size).toBe(0)
    expect(healthState()).toBe('loading')
    await setVisibility('visible')
    expect([...board.server.overview.open].some((sub) => sub.query === 'health')).toBe(true)
    expect(healthAsked(board).at(-1)).toMatchObject({ sort: 'late', dir: 'desc', limit: 10 })
    expect(healthState()).toBe('ok')
    expect(cards()).toHaveLength(2)
  })

  it('shows the table from the server while the workspace still loads', async () => {
    const { board, render } = await overview(work())
    vi.spyOn(board.P, 'stillLoading').mockReturnValue(0.4)
    const scoped = vi.spyOn(board.P, 'scopedIssues')
    await render()
    expect(document.querySelector('[data-ov-table]')).not.toBeNull()
    expect(cards()).toHaveLength(2)
    expect(document.body.textContent).not.toContain('opens once every task has loaded')
    expect(scoped).not.toHaveBeenCalled()
    expect(state()).toBe('ok')
  })
})
