// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoadmapAnswer } from '../../convex/lib/roadmap'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'
import type { RoadmapRequest } from './Roadmap'

/* The Roadmap from the server's answer (roadmap/useRoadmapView.ts): the
   answer decides which tasks show, each as the store's shaped model of its
   row, as the store boots without the workspace's tasks; each state names
   itself on the root and says why where it shows no tasks, with the toolbar
   usable beside it; a pan keeps the bars marked refreshing; the headings
   read the answer's counts; the arrows and Auto-move read the dependency
   answer; a plan request waits for an answer that holds its task. */

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
// frames, run only when a test says so
let frames: (() => void)[]

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
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    frames.push(() => callback(performance.now())),
  )
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Element.prototype.scrollTo = () => {}
  // each case opens on the default window, whatever an earlier one panned to
  localStorage.clear()
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
})

const ROW: IssueFilters = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}

const rootEl = () => document.querySelector<HTMLElement>('[data-roadmap-root]')
const state = () => rootEl()?.dataset.roadmapState
const busy = () => rootEl()?.getAttribute('aria-busy') === 'true'
const title = () => document.querySelector('[data-empty-state-title]')?.textContent
const rows = () =>
  [
    ...document.querySelectorAll<HTMLElement>('[data-roadmap-task-top] [data-roadmap-task-open]'),
  ].map((el) => el.dataset.roadmapTaskOpen)
const flush = async () => {
  while (frames.length) await act(async () => frames.shift()?.())
}

/** The week `n` weeks from this one, as a stored day. */
const week = (n: number) => weekToISO(TODAY_WEEK + n)

/** A top-level project, Plan, over two sub-projects, One (the fixture's)
    and Two, with a task in each: one-1 of 2 hours, two-1 of 3, both
    scheduled this week and next, two-1 of high priority. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One' })
  snap.projects.push({ ...base, id: 'two', key: 'TWO', num: 3, name: 'Two', parent_id: 'plan' })
  snap.issues.push({
    ...taskRow(snap, 'one-1', 'todo', 1),
    remaining_hours: 2,
    start_week: week(0),
    end_week: week(1),
  })
  snap.issues.push({
    ...taskRow(snap, 'two-1', 'todo', 2),
    project_id: 'two',
    priority: 'high',
    remaining_hours: 3,
    start_week: week(0),
    end_week: week(1),
  })
}

type Board = Awaited<ReturnType<typeof loadBoard>>

/** Renders the Roadmap of the board's scope with `filters` and the
    requests and actions given. */
async function renderRoadmap(
  board: Board,
  {
    filters = ROW,
    focusPlan = null,
    revealTask = null,
    actions = {},
  }: {
    filters?: IssueFilters
    focusPlan?: RoadmapRequest | null
    revealTask?: RoadmapRequest | null
    actions?: Record<string, (...args: unknown[]) => void>
  } = {},
) {
  const { Roadmap } = await import('./Roadmap')
  const { WorkspaceShell } = await import('../components/WorkspaceShell')
  const all = new Proxy(actions, {
    get: (target, name: string) => target[name] ?? (() => {}),
  }) as Parameters<typeof Roadmap>[0]['actions']
  // the shell holds the toolbar row the Roadmap's toolbar portals into
  await board.renderView(root, (info) => (
    <WorkspaceShell header={null}>
      <Roadmap
        info={info}
        filters={filters}
        actions={all}
        filterControls={() => null}
        focusPlan={focusPlan}
        revealTask={revealTask}
        onFocusConsumed={consumedPlans}
      />
    </WorkspaceShell>
  ))
}

/* The plan requests the Roadmap took, by nonce. */
let consumedPlans = vi.fn()

/** The arguments of each tasks:roadmap subscription, newest last. */
const roadmapAsks = (board: Board) =>
  board.server.roadmap.asked
    .filter((sub) => sub.name === 'tasks:roadmap')
    .map((sub) => sub.args as { window: { from: string }; planned_task?: { id: string } })

describe('the Roadmap from its answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the answer's tasks as the shaped models of its rows, asking for no task of the workspace", async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.probe?.asks()
    await renderRoadmap(board)
    expect(state()).toBe('ok')
    expect(busy()).toBe(false)
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    expect(board.P.tasksHeld()).toBe(false)
    expect(board.probe?.asks()).toEqual([])
    // a task the answer leaves out does not show, though the workspace has it
    board.server.roadmap.edit = (name, answer) =>
      name === 'tasks:roadmap' && (answer as RoadmapAnswer).state === 'ok'
        ? {
            ...(answer as RoadmapAnswer & { state: 'ok' }),
            rows: (answer as RoadmapAnswer & { state: 'ok' }).rows.filter((r) => r.id !== 'two-1'),
          }
        : answer
    await board.answer()
    expect(rows()).toEqual(['QN-1'])
    // it asked once for this selection, filter row and window
    expect(roadmapAsks(board)).toHaveLength(1)
  })

  it('names each state on its root and says why, the toolbar usable beside each, no note naming the window', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    const cases: [force: string, state: string, title: string, hint: string][] = [
      [
        'over_ceiling',
        'over_ceiling',
        "This selection exceeds the Roadmap's 1,000-task limit.",
        'Choose a sub-project or narrow your filters.',
      ],
      [
        'over_budget',
        'over_budget',
        "This selection could not be loaded within the Roadmap's limits.",
        'Choose a sub-project or narrow your filters.',
      ],
      [
        'unavailable',
        'unavailable',
        'This Roadmap is not available',
        'Qivo cannot show this project here. Choose another project.',
      ],
      [
        'access_unchecked',
        'unavailable',
        'This Roadmap is not available',
        'Qivo could not check all of your access in time. Try again in a moment.',
      ],
    ]
    for (const [force, want, sentence, hint] of cases) {
      board.server.roadmap.force = [force as never]
      await renderRoadmap(board)
      await board.answer()
      expect(state(), force).toBe(want)
      expect(title(), force).toBe(sentence)
      expect(document.querySelector('[data-empty-state]')?.textContent, force).toContain(hint)
      // never part of a Roadmap, and never a shorter window as the way out
      expect(rows(), force).toEqual([])
      expect(document.querySelector('[data-empty-state]')?.textContent, force).not.toMatch(
        /window/i,
      )
      // the toolbar stays, its Auto-move with nothing to move
      expect(document.querySelector('[data-roadmap-toolbar]'), force).not.toBeNull()
      expect(
        document.querySelector<HTMLButtonElement>('[data-auto-correct]')?.disabled,
        force,
      ).toBe(true)
      await act(async () => root.render(null))
    }
    // the sub-projects to choose among come from the answer
    board.server.roadmap.force = ['over_ceiling']
    await renderRoadmap(board)
    await board.answer()
    const choices = [...document.querySelectorAll<HTMLElement>('[data-roadmap-choice]')].map(
      (el) => el.dataset.roadmapChoice,
    )
    expect(choices.sort()).toEqual([board.snapshot.projects[0].id, 'two'].sort())
  })

  it('narrows one sub-project by filters or Search, and says the read failed with Try again', async () => {
    const board = await loadBoard(network, plan, { scope: 'two' })
    const palette = vi.fn()
    board.server.roadmap.force = ['over_ceiling']
    await renderRoadmap(board)
    expect(document.querySelector('[data-empty-state]')?.textContent).toContain(
      'Narrow your filters.',
    )
    expect(document.querySelector('[data-roadmap-choice]')).toBeNull()
    board.server.roadmap.force = ['over_budget']
    await renderRoadmap(board, { actions: { openPalette: palette } })
    await board.answer()
    const search = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Search this sub-project',
    )
    await act(async () => search?.click())
    expect(palette).toHaveBeenCalledWith('two')
    // a failed read, and its Try again, which asks again
    board.server.roadmap.force = []
    board.server.roadmap.fail = new Error('down')
    await act(async () => root.render(null))
    await renderRoadmap(board)
    expect(state()).toBe('error')
    expect(title()).toBe('The Roadmap could not be loaded')
    const asked = roadmapAsks(board).length
    board.server.roadmap.fail = undefined
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    await act(async () => retry?.click())
    expect(roadmapAsks(board).length).toBeGreaterThan(asked)
    expect(state()).toBe('ok')
    expect(rows()).toEqual(['QN-2'])
  })

  it('asks All projects to choose a project, and a text filter past its limit to shorten', async () => {
    const board = await loadBoard(network, plan, { scope: 'all' })
    await renderRoadmap(board)
    expect(state()).toBe('choose')
    expect(title()).toBe('Choose a project')
    expect(document.querySelector('[data-roadmap-choice="plan"]')).not.toBeNull()
    expect(roadmapAsks(board)).toEqual([])
    await act(async () => root.render(null))
    const project = await loadBoard(network, plan, { scope: 'plan' })
    await renderRoadmap(project, { filters: { ...ROW, search: 'x'.repeat(201) } })
    expect(state()).toBe('search_limit')
    expect(rows()).toEqual([])
  })

  it('says nothing is assigned only for a current answer of My view, and its narrowing hint', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        for (const t of snap.issues) t.assignee_id = undefined
      },
      { scope: 'mine' },
    )
    board.server.roadmap.hold = true
    await renderRoadmap(board, { filters: { ...ROW, mine: true } })
    expect(state()).toBe('loading')
    expect(document.body.textContent).not.toContain('Nothing assigned to you')
    expect(title()).toBe('Loading tasks…')
    await act(async () => {
      board.server.roadmap.hold = false
    })
    await board.answer()
    expect(state()).toBe('ok')
    expect(document.body.textContent).toContain('Nothing assigned to you')
    board.server.roadmap.force = ['over_ceiling']
    await board.answer()
    expect(document.body.textContent).not.toContain('Nothing assigned to you')
    expect(document.querySelector('[data-empty-state]')?.textContent).toContain(
      'Narrow your filters, such as Priority or the text filter, or open a project.',
    )
  })

  it('keeps the bars on a pan, marked refreshing, and shows loading for a new filter', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    await renderRoadmap(board)
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    board.server.roadmap.hold = (name) => name === 'tasks:roadmap'
    const forward = document.querySelector<HTMLElement>('[data-win="fwd"]')
    await act(async () => forward?.click())
    // the last window's answer, until the pan's answer arrives
    expect(state()).toBe('refreshing')
    expect(busy()).toBe(true)
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    const asks = roadmapAsks(board)
    expect(asks.at(-1)?.window.from).not.toBe(asks[0]?.window.from)
    await board.answer()
    expect(state()).toBe('ok')
    // another filter is another question: its frame, no bar of the last one
    await renderRoadmap(board, { filters: { ...ROW, priority: 'high' } })
    expect(state()).toBe('loading')
    expect(rows()).toEqual([])
    expect(document.querySelector('[data-no-match]')).toBeNull()
    await board.answer()
    expect(rows()).toEqual(['QN-2'])
  })

  it("reads the headings' Remaining from the answer's tenths, and says counting or unknown, never zero", async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    await renderRoadmap(board)
    const headings = () =>
      [...document.querySelectorAll<HTMLElement>('[data-track]')].map((el) => el.textContent ?? '')
    // the two sub-projects, as Plan's tracks, from the counts
    expect(headings().join(' ')).toContain('2h')
    expect(headings().join(' ')).toContain('3h')
    board.server.roadmap.force = ['counting']
    await board.answer()
    expect(document.querySelectorAll('[data-remaining="counting"]').length).toBe(2)
    expect(headings().join(' ')).not.toMatch(/\dh/)
    board.server.roadmap.force = ['remaining-budget']
    await board.answer()
    expect(document.querySelectorAll('[data-remaining="unknown"]').length).toBe(2)
    expect(headings().join(' ')).not.toMatch(/0h/)
    // a selected sub-project the counts do not name reads unknown, not 0
    board.server.roadmap.force = []
    board.server.roadmap.edit = (name, answer) => {
      const a = answer as RoadmapAnswer
      if (name !== 'tasks:roadmap' || a.state !== 'ok' || a.remaining.state !== 'ok') return a
      return { ...a, remaining: { state: 'ok', tenths: { two: 30 } } }
    }
    await board.answer()
    expect(document.querySelectorAll('[data-remaining="unknown"]').length).toBe(1)
    expect(headings().join(' ')).toContain('3h')
  })

  it('draws an arrow only from the answer’s pairs and says why none shows while the links are not there', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        Object.assign(snap.issues[1], { start_week: week(0), end_week: week(0) })
        snap.links.push({
          id: 'link-1',
          source_id: 'one-1',
          target_id: 'two-1',
          type: 'blocks',
          pair_key: 'one-1:two-1',
          created_at: '2026-09-01T08:00:00.000Z',
        })
      },
      { scope: 'plan' },
    )
    await renderRoadmap(board)
    const arrows = () => document.querySelectorAll('svg[aria-hidden="true"] g').length
    expect(arrows()).toBe(1)
    expect(document.querySelector('[data-roadmap-deps]')).toBeNull()
    // Auto-move sees two-1 start before its blocker ends
    const move = document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    expect(move?.disabled).toBe(false)
    expect(move?.textContent).toContain('1')
    // the dependency read past its budget: no arrow, a line that says so,
    // and Auto-move unavailable with its reason
    board.server.roadmap.force = ['deps-budget']
    await board.answer()
    expect(arrows()).toBe(0)
    expect(document.querySelector('[data-roadmap-deps]')?.getAttribute('data-roadmap-deps')).toBe(
      'over_budget',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-auto-correct]')?.disabled).toBe(true)
    // Auto-move's inputs past their size: the arrows stay, Auto-move says why
    board.server.roadmap.force = ['automove-budget']
    await board.answer()
    expect(arrows()).toBe(1)
    const unavailable = document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    expect(unavailable?.disabled).toBe(true)
    expect(unavailable?.dataset.autoMove).toBe('over_budget')
    // its tooltip says why
    const { autoMoveUnavailable } = await import('./roadmap/useRoadmapView')
    expect(
      autoMoveUnavailable({ state: 'ok', pairs: [], autoMove: { state: 'over_budget' } }),
    ).toBe(
      "Auto-move is unavailable because this selection's dependency chains are too long to read at once.",
    )
    expect(
      autoMoveUnavailable({
        state: 'ok',
        pairs: [],
        autoMove: {
          state: 'ok',
          inputs: { state: 'ok', tasks: [], pairs: [], editable_projects: [] },
        },
      }),
    ).toBeNull()
  })

  it("moves the answer's parts in one write with each task's shown dates as expected values", async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        Object.assign(snap.issues[1], { start_week: week(0), end_week: week(0) })
        snap.links.push({
          id: 'link-1',
          source_id: 'one-1',
          target_id: 'two-1',
          type: 'blocks',
          pair_key: 'one-1:two-1',
          created_at: '2026-09-01T08:00:00.000Z',
        })
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    await renderRoadmap(board)
    const move = document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    network.mutation.mockClear()
    await act(async () => move?.click())
    const writes = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'roadmap:change',
    )
    expect(writes).toHaveLength(1)
    const [, args] = writes[0] as [unknown, { operations: Record<string, unknown>[] }]
    expect(args.operations).toEqual([
      {
        kind: 'task',
        id: 'two-1',
        patch: { start_week: week(2), end_week: week(2) },
        expected: { start_week: week(0), end_week: week(0) },
      },
    ])
    // the bar shows its new dates at once, and the next press waits for the
    // write
    const bar = document.querySelector<HTMLElement>('[data-bar="QN-2"]')
    expect(bar).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-auto-correct]')?.disabled).toBe(true)
  })

  it('opens a task only its answer brings by a reference the window reads from the server', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    const opened = vi.fn()
    await renderRoadmap(board, { actions: { openIssue: opened } })
    const row = document.querySelector<HTMLElement>('[data-roadmap-task-open="QN-1"]')
    await act(async () => row?.click())
    expect(opened).toHaveBeenCalledTimes(1)
    const [target] = opened.mock.calls[0] as [string]
    expect(target).not.toBe('QN-1')
    expect(target).toBe(board.P.openTarget('QN-1'))
  })

  it('asks for nothing while the page is hidden, and shows its last answer as refreshing on return', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    await renderRoadmap(board)
    expect(board.server.roadmap.open.size).toBe(2)
    board.server.roadmap.hold = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(board.server.roadmap.open.size).toBe(0)
    expect(board.server.loads.size).toBe(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(state()).toBe('refreshing')
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    board.server.roadmap.hold = false
    await board.answer()
    expect(state()).toBe('ok')
  })
})

describe('Plan on roadmap from the answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('keeps the planned task past the filter row, sent with its sub-project, and ends the session when it leaves', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.P.roadmapContext(true, false)
    const filters = { ...ROW, priority: 'high' }
    const request = {
      id: 'QN-1',
      n: 1,
      key: 'QN-1',
      uuid: 'one-1',
      project: board.snapshot.projects[0].id,
      start: TODAY_WEEK,
      end: TODAY_WEEK + 1,
    }
    await renderRoadmap(board, { filters, focusPlan: request })
    await flush()
    expect(roadmapAsks(board).at(-1)?.planned_task).toEqual({
      id: 'one-1',
      project_id: board.snapshot.projects[0].id,
    })
    expect(document.querySelector('[data-plan-card="QN-1"]')).not.toBeNull()
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    // an answer for the session's arguments that no longer holds it
    board.server.roadmap.edit = (name, answer) => {
      const a = answer as RoadmapAnswer
      return name === 'tasks:roadmap' && a.state === 'ok'
        ? { ...a, rows: a.rows.filter((r) => r.id !== 'one-1') }
        : a
    }
    await board.answer()
    expect(document.querySelector('[data-plan-card]')).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(
      'QN-1 left this roadmap. Its dates stay as they were saved.',
      'info',
    )
  })

  it('says not on the roadmap any more only once a current answer lacks the task, and why it cannot plan past a limit', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.server.roadmap.hold = (name) => name === 'tasks:roadmap'
    consumedPlans = vi.fn()
    const consumed = consumedPlans
    const request = { id: 'QN-9', n: 1, key: 'QN-9', uuid: 'gone', project: 'two' }
    await renderRoadmap(board, { focusPlan: request })
    await flush()
    // the answer is on its way: no word yet
    expect(window.showToast).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    await board.answer()
    await flush()
    expect(window.showToast).toHaveBeenCalledWith('QN-9 is not on the roadmap any more.', 'error')
    expect(consumed).toHaveBeenCalledWith(1)
    // a selection past the ceiling once the planned task joins it says why
    // it cannot plan there: a task the filters hide, which the answer on
    // screen does not hold
    const high = { ...ROW, priority: 'high' }
    await renderRoadmap(board, { filters: high })
    await board.answer()
    vi.mocked(window.showToast).mockClear()
    board.server.roadmap.force = ['over_ceiling']
    await renderRoadmap(board, {
      filters: high,
      focusPlan: {
        ...request,
        id: 'QN-1',
        n: 2,
        key: 'QN-1',
        uuid: 'one-1',
        project: board.snapshot.projects[0].id,
      },
    })
    await board.answer()
    await flush()
    expect(window.showToast).toHaveBeenCalledWith(
      "QN-1 can't be planned here. This selection exceeds the Roadmap's 1,000-task limit.",
      'error',
    )
    expect(document.querySelector('[data-plan-card]')).toBeNull()
  })

  it('pans to a Done task outside the window, then shows it', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        Object.assign(snap.issues[0], { status: 'done', start_week: week(30), end_week: week(31) })
      },
      { scope: 'plan' },
    )
    await renderRoadmap(board)
    expect(rows()).toEqual(['QN-2'])
    await renderRoadmap(board, {
      revealTask: {
        id: 'QN-1',
        n: 1,
        key: 'QN-1',
        uuid: 'one-1',
        start: TODAY_WEEK + 30,
        end: TODAY_WEEK + 31,
      },
    })
    await board.answer()
    await flush()
    expect(rows()).toContain('QN-1')
    expect(document.querySelector('[data-roadmap-revealed="QN-1"]')).not.toBeNull()
    expect(window.showToast).not.toHaveBeenCalled()
  })
})
