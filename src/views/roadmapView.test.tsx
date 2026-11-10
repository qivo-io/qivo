// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DependencyAnswer, RoadmapAnswer } from '../../convex/lib/roadmap'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { answerRoadmap } from '../store/roadmapStandIn.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'
import type { RoadmapRequest } from './Roadmap'

/* The Roadmap from the server's answer (roadmap/useRoadmapView.ts): the
   answer decides which tasks show, each as the store's shaped model of its
   row, as the store boots without the workspace's tasks; each state names
   itself on the root and says why where it shows no tasks, with the toolbar
   usable beside it; a pan keeps the bars marked refreshing; the headings
   read the answer's counts; the arrows and Auto-move read the dependency
   answer; a plan request waits for an answer that holds its task, and its
   planning panel reads the owner's load live; the phone's agenda and
   landscape timeline show the same answer. */

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
  // jsdom has no pointer capture, which a bar's drag takes
  Element.prototype.setPointerCapture = () => {}
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
/* The store paints an answer that arrives while a painted write waits in
   a task of its own (store/planner.ts owe), so a case lets it run. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

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

/** Drags the bar of task handle `id` by `weeks` weeks on the Roadmap's
    week width, and lets it go. */
async function dragBar(id: string, weeks: number) {
  const bar = document.querySelector<HTMLElement>(`[data-bar="${id}"]`)
  if (!bar) throw new Error(`no bar of ${id}`)
  // Team's strip shares the timeline's week width
  const weekW = Number.parseFloat(
    document
      .querySelector<HTMLElement>('[data-split-strip]')
      ?.style.getPropertyValue('--res-week') ?? '',
  )
  if (!(weekW > 0)) throw new Error('no week width')
  const pointer = (type: string, clientX: number) =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 })
  await act(async () => bar.dispatchEvent(pointer('pointerdown', 100)))
  await act(async () => bar.dispatchEvent(pointer('pointermove', 100 + weeks * weekW)))
  await act(async () => bar.dispatchEvent(pointer('pointerup', 100 + weeks * weekW)))
}

/** The dates of every Roadmap change of task `uuid` sent since the
    network's mocks were cleared, oldest first. */
const datesSent = (uuid: string) =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === 'roadmap:change')
    .flatMap(
      ([, args]) =>
        (args as { operations: { kind: string; id: string; patch: Record<string, unknown> }[] })
          .operations,
    )
    .filter((op) => op.kind === 'task' && op.id === uuid)
    .map((op) => op.patch)

/** The right edge of the bar of task `uuid` on the Roadmap, in pixels. */
function barEnd(board: Board, uuid: string): number {
  const id = board.P.viewTask('roadmap', uuid)?.id ?? uuid
  const bar = document.querySelector<HTMLElement>(`[data-bar="${id}"]`)
  if (!bar) throw new Error(`no bar of ${uuid}`)
  return Number.parseFloat(bar.style.left) + Number.parseFloat(bar.style.width)
}

/** A plan request for one-1 (QN-1), with nonce `n`, as App sends it. */
const planOne = (board: Board, n = 1): RoadmapRequest => ({
  id: 'QN-1',
  n,
  key: 'QN-1',
  uuid: 'one-1',
  project: board.snapshot.projects[0].id,
  start: TODAY_WEEK,
  end: TODAY_WEEK + 1,
})

const planCard = (id = 'QN-1') => document.querySelector<HTMLElement>(`[data-plan-card="${id}"]`)

/** plan, with one-1 unscheduled, 100 hours remaining and owned by Gina
    Ghost, a standard user of 25-hour weeks, whom the store does not hold
    as it holds nobody but the signed-in person, so her weekly hours
    arrive with her details (people.byIds). */
const ownedByGina = (snap: Snapshot) => {
  plan(snap)
  snap.profiles.push({
    ...snap.profiles[0],
    id: 'gina',
    auth_user_id: 'account-gina',
    name: 'Gina Ghost',
    initials: 'GG',
    org_role: 'user',
    plannable_hours: 25,
  })
  const one = snap.issues[0]
  Reflect.deleteProperty(one, 'start_week')
  Reflect.deleteProperty(one, 'end_week')
  one.remaining_hours = 100
  one.assignee_id = 'gina'
}

/** A second person of the organization. */
const OTHER = 'other-person'
const addOther = (snap: Snapshot) =>
  snap.profiles.push({
    ...snap.profiles[0],
    id: OTHER,
    auth_user_id: undefined,
    name: 'Other',
    initials: 'OT',
    org_role: 'user',
  })

/** The arguments of each tasks:roadmap subscription, newest last. */
const roadmapAsks = (board: Board) =>
  board.server.roadmap.asked
    .filter((sub) => sub.name === 'tasks:roadmap')
    .map((sub) => sub.args as { window: { from: string }; planned_task?: { id: string } })

describe('the Roadmap from its answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows the answer's tasks as the shaped models of its rows", async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    await renderRoadmap(board)
    expect(state()).toBe('ok')
    expect(busy()).toBe(false)
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    // a task the answer leaves out does not show, though the server has it
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

  it("lists the ceiling note's sub-projects in the sidebar's order, by name and then id", async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        // One takes Two's name, so the id decides between them, and Apple's
        // name sorts first while its id sorts last
        snap.projects[0].name = 'Two'
        snap.projects.push({
          ...snap.projects[0],
          id: 'zz-apple',
          key: 'APL',
          num: 4,
          name: 'Apple',
        })
      },
      { scope: 'plan' },
    )
    const one = board.snapshot.projects[0].id
    // the tracks in neither the name order nor the id order
    board.server.roadmap.edit = (name, answer) =>
      name === 'tasks:roadmap' && (answer as RoadmapAnswer).state === 'over_ceiling'
        ? { ...(answer as RoadmapAnswer), projects: ['two', one, 'zz-apple'] }
        : answer
    board.server.roadmap.force = ['over_ceiling']
    await renderRoadmap(board)
    await board.answer()
    const choices = [...document.querySelectorAll<HTMLElement>('[data-roadmap-choice]')].map(
      (el) => el.dataset.roadmapChoice,
    )
    // must fail for the track order, the id order and localeCompare, which
    // keeps the two Twos in the track order
    expect(choices).toEqual(['zz-apple', one, 'two'])
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

  it('asks a text filter past its limit to shorten', async () => {
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
    // a recording visit, as App opens one on the Roadmap
    board.P.roadmapContext(true, false)
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

  it('says Auto-move moved its tasks only once the save answers, and is off while undo history is cleared', async () => {
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
    const saves: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
    const sent: string[] = []
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      // the task writes, not the view's preference saves
      if (name !== 'prefs:save') sent.push(name)
      return name === 'roadmap:change'
        ? new Promise((resolve, reject) => saves.push({ resolve, reject }))
        : new Promise(() => {})
    })
    board.P.roadmapContext(true, false)
    await renderRoadmap(board)
    const move = () => document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    const toasts = () => vi.mocked(window.showToast).mock.calls.map(([text]) => String(text))
    const moved = () => toasts().filter((text) => text.startsWith('Moved'))
    // the visit's 24 hours end before the press: nothing is sent, the
    // store says so, and the button then says why and how to get it back
    const now = Date.now()
    const later = vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1)
    await act(async () => move()?.click())
    // must fail for a fallback that sends each move as its own write
    expect(sent).toEqual([])
    expect(moved()).toEqual([])
    expect(toasts()).toEqual([
      'Roadmap undo history expired. Leave Roadmap and return to start a new history.',
    ])
    expect(move()?.disabled).toBe(true)
    expect(move()?.dataset.autoMove).toBe('no_history')
    later.mockRestore()
    // a new visit takes it again; a refused save claims no move
    await act(async () => {
      board.P.roadmapContext(false, false)
      board.P.roadmapContext(true, false)
    })
    expect(move()?.disabled).toBe(false)
    await act(async () => move()?.click())
    expect(sent).toEqual(['roadmap:change'])
    // must fail for a toast sent with the write
    expect(moved()).toEqual([])
    await act(async () => saves[0].reject(new ConvexError({ code: 'rule', message: 'too many' })))
    await vi.waitFor(() => expect(move()?.disabled).toBe(false))
    expect(moved()).toEqual([])
    // the store's toast says what refused it
    expect(toasts().at(-1)).toMatch(/too many/i)
    await act(async () => move()?.click())
    expect(saves).toHaveLength(2)
    expect(moved()).toEqual([])
    await act(async () => saves[1].resolve({ count: 1 }))
    expect(moved()).toEqual(['Moved 1 task after their blockers'])
  })

  it('says Auto-move waits, by name, while a write is on its way', async () => {
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
    // a recording visit, as App opens one on the Roadmap
    board.P.roadmapContext(true, false)
    await renderRoadmap(board)
    const move = () => document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    expect(move()?.disabled).toBe(false)
    expect(move()?.dataset.autoMove).toBeUndefined()
    // another write, which never answers here, holds Auto-move's one move
    await act(async () => {
      void board.P.updateIssue('QN-1', { status: 'progress' })
    })
    expect(move()?.disabled).toBe(true)
    expect(move()?.dataset.autoMove).toBe('waiting')
  })

  it('solves again when a linked task moves to a project the reader may or may not edit, its dates unchanged', async () => {
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
    // the reader may edit One, where one-1 stays, and not Two
    const one = board.snapshot.projects[0].id
    board.server.roadmap.edit = (name, answer) => {
      const a = answer as DependencyAnswer
      return name === 'tasks:roadmapDependencies' && a.state === 'ok' && a.auto_move.state === 'ok'
        ? { ...a, auto_move: { ...a.auto_move, editable_projects: [one] } }
        : answer
    }
    // a recording visit, as App opens one on the Roadmap
    board.P.roadmapContext(true, false)
    await renderRoadmap(board)
    const move = () => document.querySelector<HTMLButtonElement>('[data-auto-correct]')
    // two-1 starts before its blocker ends, in Two, so nothing moves
    expect(move()?.disabled).toBe(true)
    // someone moves two-1 to One, its dates, status and links as they were
    const two = board.snapshot.issues[1]
    two.project_id = one
    await board.answer()
    expect(move()?.disabled).toBe(false)
    expect(move()?.textContent).toContain('1')
    // and back to Two
    two.project_id = 'two'
    await board.answer()
    expect(move()?.disabled).toBe(true)
  })

  it("draws a group's bar over its subtask's saved move before the answer runs again", async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        snap.issues.push({ ...taskRow(snap, 'group', 'todo', 3) })
        snap.issues.push({
          ...taskRow(snap, 'sub-1', 'todo', 4),
          parent_id: 'group',
          start_week: week(0),
          end_week: week(1),
        })
        snap.issues.push({
          ...taskRow(snap, 'sub-2', 'todo', 5),
          parent_id: 'group',
          start_week: week(0),
          end_week: week(0),
        })
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    await renderRoadmap(board)
    // the group's bar ends with its later subtask
    const before = barEnd(board, 'group')
    expect(before).toBe(barEnd(board, 'sub-1'))
    // the Roadmap's read answers nothing more while the move is saved
    board.server.roadmap.hold = true
    network.mutation.mockClear()
    await dragBar(board.P.viewTask('roadmap', 'sub-1')?.id ?? 'sub-1', 3)
    expect(datesSent('sub-1')).toEqual([{ start_week: week(3), end_week: week(4) }])
    // the subtask and its group end three weeks later, at once
    expect(barEnd(board, 'sub-1')).toBeGreaterThan(before)
    expect(barEnd(board, 'group')).toBe(barEnd(board, 'sub-1'))
  })

  it("marks a bar Delay unknown, in the neutral hue, where its owner's load cannot be read", async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        // One and its top-level project track delays
        snap.projects[0].track_delay = true
        plan(snap)
        Object.assign(snap.issues[0], {
          status: 'progress',
          remaining_hours: 10,
          due_date: week(2),
        })
      },
      { scope: 'plan' },
    )
    await renderRoadmap(board)
    const bar = () => document.querySelector<HTMLElement>('[data-bar="QN-1"]')
    const tooltip = async () => {
      await act(async () => bar()?.focus())
      const text = document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? ''
      await act(async () => bar()?.blur())
      return text
    }
    // the owner's load reads: the bar is judged, never unknown
    expect(bar()?.getAttribute('style')).not.toContain('--roadmap-bar-unknown')
    expect(await tooltip()).not.toContain('Delay unknown')
    board.server.unavailable = [board.snapshot.profiles[0].id]
    await board.answer()
    expect(bar()?.getAttribute('style')).toContain('--roadmap-bar-unknown')
    expect(await tooltip()).toContain('Delay unknown')
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

  it('says the workload is unavailable and pauses auto-fit, a drag sending its own dates', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    board.P.roadmapContext(true, false)
    board.server.unavailable = [board.snapshot.profiles[0].id]
    await renderRoadmap(board, { focusPlan: planOne(board) })
    await flush()
    expect(planCard()?.textContent).toContain('Workload is unavailable. Auto-fit is paused.')
    // a move keeps the dragged dates: no fitted end without the load
    network.mutation.mockClear()
    await dragBar('QN-1', 1)
    expect(datesSent('one-1')).toEqual([{ start_week: week(1), end_week: week(2) }])
    // once the load reads, a move fits the end to the free time instead,
    // 2 hours in the first week
    board.server.unavailable = []
    await board.answer()
    await settle()
    expect(planCard()?.textContent).not.toContain('Workload is unavailable')
    await dragBar('QN-1', 2)
    expect(datesSent('one-1').at(-1)).toEqual({ start_week: week(3), end_week: week(3) })
  })

  it("places an unscheduled task's end once its owner's load first answers, and never again", async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        const one = snap.issues[0]
        Reflect.deleteProperty(one, 'start_week')
        Reflect.deleteProperty(one, 'end_week')
        one.remaining_hours = 100
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    board.server.holdLoads = true
    network.mutation.mockClear()
    const { start: _start, end: _end, ...unscheduled } = planOne(board)
    await renderRoadmap(board, { focusPlan: unscheduled })
    await flush()
    expect(planCard()).not.toBeNull()
    expect(planCard()?.textContent).toContain('Loading…')
    // the starter bar, this week and next, while the load is on its way
    const starter = { start_week: week(0), end_week: week(1) }
    expect(datesSent('one-1')).toEqual([starter])
    board.server.holdLoads = false
    await board.answer()
    await settle()
    await flush()
    // the first load fits the end once: 100 hours over 32-hour weeks, less
    // two-1's 1.5 hours a week, end in the fourth week
    expect(datesSent('one-1')).toEqual([starter, { end_week: week(3) }])
    // a later answer leaves the dates alone, though a fit to it would end
    // later: two-1 now takes 30 hours a week
    const two = board.snapshot.issues.find((t) => t.id === 'two-1')
    if (!two) throw new Error('no two-1')
    two.remaining_hours = 60
    await board.answer()
    await settle()
    await flush()
    expect(planCard()?.textContent).toMatch(/Two\s*60h/)
    expect(datesSent('one-1')).toHaveLength(2)
  })

  it.each(['load', 'hours'] as const)(
    "places an unscheduled task's end once its owner's load and weekly hours are both in, the %s last",
    async (last) => {
      // Gina, whom the store does not hold, owns one-1
      const board = await loadBoard(network, ownedByGina, { scope: 'plan' })
      board.server.people.hold = last === 'hours'
      board.server.holdLoads = last === 'load'
      await board.deliver()
      board.P.roadmapContext(true, false)
      network.mutation.mockClear()
      const { start: _start, end: _end, ...unscheduled } = planOne(board)
      await renderRoadmap(board, { focusPlan: unscheduled })
      await flush()
      await settle()
      await flush()
      // only the starter bar while one of the two is on its way
      const starter = { start_week: week(0), end_week: week(1) }
      expect(datesSent('one-1')).toEqual([starter])
      if (last === 'hours') {
        expect(board.P.person('gina')?.state).toBe('loading')
        expect(planCard()?.textContent).toContain('Loading the owner’s hours…')
        expect(planCard()?.textContent).not.toContain('Capacity unknown')
      }
      board.server.people.hold = false
      board.server.holdLoads = false
      await board.answer()
      await settle()
      await flush()
      // 100 hours over Gina's 25-hour weeks end in the fourth week
      expect(datesSent('one-1')).toEqual([starter, { end_week: week(3) }])
    },
  )

  it.each(['error', 'gone'] as const)(
    "spends an unscheduled task's first fit once its owner's read answers %s, so their hours arriving later leave the dropped dates",
    async (answer) => {
      // Gina, whom the store does not hold, owns one-1, and her read
      // fails or leaves her out, so the panel says auto-fit is off
      const board = await loadBoard(network, ownedByGina, { scope: 'plan' })
      board.server.people.force = answer
      await board.deliver()
      board.P.roadmapContext(true, false)
      network.mutation.mockClear()
      const { start: _start, end: _end, ...unscheduled } = planOne(board)
      await renderRoadmap(board, { focusPlan: unscheduled })
      await flush()
      await settle()
      await flush()
      const starter = { start_week: week(0), end_week: week(1) }
      expect(board.P.person('gina')?.state).toBe(answer === 'error' ? 'failed' : 'gone')
      expect(planCard()?.textContent).toContain('Capacity unknown, so auto-fit is off')
      // the drop keeps the dates the person chose, with no hours to fit
      await dragBar('QN-1', 1)
      const dropped = { start_week: week(1), end_week: week(2) }
      expect(datesSent('one-1')).toEqual([starter, dropped])
      // her details arrive with her 25-hour weeks, and the dates stay
      board.server.people.force = null
      await board.answer()
      await settle()
      await flush()
      expect(board.P.person('gina')?.state).toBe('ok')
      expect(planCard()?.textContent).not.toContain('Capacity unknown')
      expect(datesSent('one-1')).toEqual([starter, dropped])
    },
  )

  it.each(['answers', 'fails'] as const)(
    'waits for the details of an owner a picker named while they load, and fits the end or spends the first fit as their read %s',
    async (outcome) => {
      // a picker named Gina before the plan, so she shows by name while her
      // details load
      const board = await loadBoard(network, ownedByGina, { scope: 'plan' })
      board.server.people.hold = true
      await board.deliver()
      const org = board.snapshot.issues[0].org_id
      await act(async () =>
        board.P.takePeople(org, [
          {
            id: 'gina',
            name: 'Gina Ghost',
            org_role: 'user',
            kind: 'person',
            active: true,
            pending: false,
          },
        ]),
      )
      board.P.roadmapContext(true, false)
      network.mutation.mockClear()
      const { start: _start, end: _end, ...unscheduled } = planOne(board)
      await renderRoadmap(board, { focusPlan: unscheduled })
      await flush()
      await settle()
      await flush()
      // her read is on its way, so the panel says her hours are loading and
      // the first fit waits with the starter bar
      const starter = { start_week: week(0), end_week: week(1) }
      expect(board.P.person('gina')).toMatchObject({ state: 'ok', nameOnly: true, reading: true })
      expect(planCard()?.textContent).toContain('Loading the owner’s hours…')
      expect(datesSent('one-1')).toEqual([starter])
      board.server.people.hold = false
      if (outcome === 'answers') {
        // her details arrive with her 25-hour weeks, and the first fit ends
        // 100 hours in the fourth week
        await board.answer()
        await settle()
        await flush()
        expect(board.P.person('gina')).toMatchObject({ state: 'ok', nameOnly: false })
        expect(datesSent('one-1')).toEqual([starter, { end_week: week(3) }])
        return
      }
      // it fails, so her name stays, the panel says auto-fit is off and the
      // drop keeps the dates the person chose
      board.server.people.force = 'error'
      await board.answer()
      await settle()
      await flush()
      expect(board.P.person('gina')).toMatchObject({ state: 'ok', nameOnly: true, reading: false })
      expect(planCard()?.textContent).toContain('Capacity unknown, so auto-fit is off')
      await dragBar('QN-1', 1)
      const dropped = { start_week: week(1), end_week: week(2) }
      expect(datesSent('one-1')).toEqual([starter, dropped])
      // her details arrive with her 25-hour weeks, and the dates stay
      board.server.people.force = null
      await board.answer()
      await settle()
      await flush()
      expect(board.P.person('gina')).toMatchObject({ state: 'ok', nameOnly: false })
      expect(planCard()?.textContent).not.toContain('Capacity unknown')
      expect(datesSent('one-1')).toEqual([starter, dropped])
    },
  )

  it("spends the first fit once its owner's read fails while their load is on its way, so neither their details nor the load move the dropped dates", async () => {
    const board = await loadBoard(network, ownedByGina, { scope: 'plan' })
    board.server.people.force = 'error'
    board.server.holdLoads = true
    await board.deliver()
    board.P.roadmapContext(true, false)
    network.mutation.mockClear()
    const { start: _start, end: _end, ...unscheduled } = planOne(board)
    await renderRoadmap(board, { focusPlan: unscheduled })
    await flush()
    await settle()
    await flush()
    const starter = { start_week: week(0), end_week: week(1) }
    expect(board.P.person('gina')?.state).toBe('failed')
    expect(planCard()?.textContent).toContain('Capacity unknown, so auto-fit is off')
    await dragBar('QN-1', 1)
    const dropped = { start_week: week(1), end_week: week(2) }
    expect(datesSent('one-1')).toEqual([starter, dropped])
    // her details arrive with her 25-hour weeks while the load is held
    board.server.people.force = null
    await board.answerPeople()
    await settle()
    await flush()
    expect(board.P.person('gina')?.state).toBe('ok')
    expect(planCard()?.textContent).toContain('Loading…')
    // then the load, and the dates stay
    board.server.holdLoads = false
    await board.answer()
    await settle()
    await flush()
    expect(planCard()?.textContent).not.toContain('Loading…')
    expect(datesSent('one-1')).toEqual([starter, dropped])
  })

  it('places no task that left the roadmap as its first load arrives, and ends the session', async () => {
    // One's Roadmap
    const board = await loadBoard(network, (snap) => {
      plan(snap)
      const one = snap.issues[0]
      Reflect.deleteProperty(one, 'start_week')
      Reflect.deleteProperty(one, 'end_week')
      one.remaining_hours = 100
    })
    board.P.roadmapContext(true, false)
    board.server.holdLoads = true
    network.mutation.mockClear()
    const { start: _start, end: _end, ...unscheduled } = planOne(board)
    await renderRoadmap(board, { focusPlan: unscheduled })
    await flush()
    expect(planCard()?.textContent).toContain('Loading…')
    const starter = { start_week: week(0), end_week: week(1) }
    expect(datesSent('one-1')).toEqual([starter])
    // another person moves one-1 to Two, out of One's Roadmap, and the
    // answer that drops it arrives with the first load
    const one = board.snapshot.issues.find((t) => t.id === 'one-1')
    if (!one) throw new Error('no one-1')
    one.project_id = 'two'
    board.server.holdLoads = false
    await board.deliver()
    // the session's read then names one-1 in Two, whose answer leaves it out
    // as well, so a few of the store's tasks run
    for (let turn = 0; turn < 3; turn++) await settle()
    await flush()
    // no fitted end went to the task that left
    expect(datesSent('one-1')).toEqual([starter])
    expect(
      network.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'issues:update'),
    ).toEqual([])
    expect(planCard()).toBeNull()
    expect(window.showToast).toHaveBeenCalledWith(
      'QN-1 left this roadmap. Its dates stay as they were saved.',
      'info',
    )
  })

  it("follows the owner's work elsewhere while the session stays", async () => {
    // One's Roadmap, which does not show two-1 in Two
    const board = await loadBoard(network, plan)
    board.P.roadmapContext(true, false)
    consumedPlans = vi.fn()
    const consumed = consumedPlans
    await renderRoadmap(board, { focusPlan: planOne(board) })
    await flush()
    expect(rows()).toEqual(['QN-1'])
    expect(planCard()?.textContent).toMatch(/Two\s*3h/)
    // two-1 gains hours elsewhere, and its owner's load answers again
    const two = board.snapshot.issues.find((t) => t.id === 'two-1')
    if (!two) throw new Error('no two-1')
    two.remaining_hours = 7
    await board.answer()
    expect(planCard()?.textContent).toMatch(/Two\s*7h/)
    expect(planCard()?.textContent).not.toMatch(/Two\s*3h/)
    // the same session: one request taken
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it("says a guest's panel counts only the projects they can see, for another person's task", async () => {
    const board = await loadBoard(network, (snap) => {
      plan(snap)
      addOther(snap)
      const me = snap.profiles[0]
      me.org_role = 'guest'
      snap.access.push({ project_id: snap.projects[0].id, profile_id: me.id, level: 'user' })
      snap.issues.push({
        ...taskRow(snap, 'theirs', 'todo', 3),
        assignee_id: OTHER,
        remaining_hours: 4,
        start_week: week(0),
        end_week: week(1),
      })
    })
    // the guest's store names the tasks by uuid
    const handle = (uuid: string) => board.P.viewTask('roadmap', uuid)?.id ?? uuid
    await renderRoadmap(board, {
      focusPlan: { ...planOne(board), id: 'QN-3', key: 'QN-3', uuid: 'theirs' },
    })
    await flush()
    expect(planCard(handle('theirs'))).not.toBeNull()
    expect(planCard(handle('theirs'))?.querySelector('[data-plan-own-only]')?.textContent).toBe(
      'Counts only projects you can see.',
    )
    // the guest's own task: their own load is whole
    await renderRoadmap(board, { focusPlan: planOne(board, 2) })
    await flush()
    expect(planCard(handle('one-1'))).not.toBeNull()
    expect(planCard(handle('one-1'))?.querySelector('[data-plan-own-only]')).toBeNull()
  })

  it('takes a plan request that arrives as an earlier one resolves, and drops neither', async () => {
    // one-1 and one-3 pass no filter: only a request sends them with the read
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        snap.issues.push({
          ...taskRow(snap, 'one-3', 'todo', 3),
          start_week: week(0),
          end_week: week(0),
        })
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    consumedPlans = vi.fn()
    const consumed = consumedPlans
    const { Roadmap } = await import('./Roadmap')
    const { WorkspaceShell } = await import('../components/WorkspaceShell')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    let ask: (request: RoadmapRequest) => void = () => {}
    function Host({ info }: { info: Parameters<typeof Roadmap>[0]['info'] }) {
      const [request, setRequest] = useState<RoadmapRequest | null>(null)
      useLayoutEffect(() => {
        ask = setRequest
      }, [])
      return (
        <WorkspaceShell header={null}>
          <Roadmap
            info={info}
            filters={{ ...ROW, priority: 'high' }}
            actions={actions}
            filterControls={() => null}
            focusPlan={request}
            onFocusConsumed={consumed}
          />
        </WorkspaceShell>
      )
    }
    await board.renderView(root, (info) => <Host info={info} />)
    expect(rows()).toEqual(['QN-2'])
    // the first request waits for the read that carries its task
    board.server.roadmap.hold = (name) => name === 'tasks:roadmap'
    await act(async () => ask(planOne(board)))
    expect(planCard()).toBeNull()
    // that read answers in the same render as a second request arrives
    const second = {
      ...planOne(board, 2),
      id: 'QN-3',
      key: 'QN-3',
      uuid: 'one-3',
      end: TODAY_WEEK,
    }
    await act(async () => {
      flushSync(() => {
        ask(second)
        for (const sub of board.server.roadmap.open)
          sub.next(
            structuredClone(
              answerRoadmap(board.snapshot, sub.name, sub.args, {
                sees: (id) => board.P.canSee(id),
                canEdit: (id) => board.P.canWrite(id),
              }),
            ),
          )
      })
    })
    // the second request is the one that plans, once its read answers
    board.server.roadmap.hold = false
    await board.answer()
    await flush()
    expect(planCard('QN-3')).not.toBeNull()
    expect(planCard('QN-1')).toBeNull()
    expect(consumed).toHaveBeenCalledWith(2)
  })

  it("switches an open session to a task the filters hide, which the read then names, and keeps the first one's saved dates", async () => {
    // one-1 and one-3 pass no filter, so only a session or a request
    // sends them with the read
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        snap.issues.push({
          ...taskRow(snap, 'one-3', 'todo', 3),
          remaining_hours: 2,
          start_week: week(0),
          end_week: week(0),
        })
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    consumedPlans = vi.fn()
    const filters = { ...ROW, priority: 'high' }
    await renderRoadmap(board, { filters, focusPlan: planOne(board) })
    await flush()
    expect(planCard('QN-1')).not.toBeNull()
    expect(rows().sort()).toEqual(['QN-1', 'QN-2'])
    // the session moves one-1 a week later, its end fitted to its 2 hours
    network.mutation.mockClear()
    await dragBar('QN-1', 1)
    const saved = datesSent('one-1')
    expect(saved).toEqual([{ start_week: week(1) }])
    // Plan on roadmap for one-3 while the session is open
    await renderRoadmap(board, {
      filters,
      focusPlan: { ...planOne(board, 2), id: 'QN-3', key: 'QN-3', uuid: 'one-3', end: TODAY_WEEK },
    })
    await board.answer()
    await settle()
    await flush()
    // the read names one-3, and the session is one-3's
    expect(roadmapAsks(board).at(-1)?.planned_task).toEqual({
      id: 'one-3',
      project_id: board.snapshot.projects[0].id,
    })
    expect(planCard('QN-3')).not.toBeNull()
    expect(planCard('QN-1')).toBeNull()
    expect(rows().sort()).toEqual(['QN-2', 'QN-3'])
    // one-1 keeps the dates its session saved, as nothing restores them,
    // and no sentence says a task left or is not on the roadmap
    expect(datesSent('one-1')).toEqual(saved)
    expect(window.showToast).not.toHaveBeenCalled()
    expect(consumedPlans).toHaveBeenCalledWith(2)
  })

  it('says a Done task without dates has nothing to plan, starting no session and keeping the open one', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        snap.issues.push(taskRow(snap, 'one-3', 'done', 3))
      },
      { scope: 'plan' },
    )
    board.P.roadmapContext(true, false)
    consumedPlans = vi.fn()
    const one = board.snapshot.projects[0].id
    await renderRoadmap(board, { focusPlan: planOne(board) })
    await flush()
    expect(planCard('QN-1')).not.toBeNull()
    // Plan on roadmap from a window that showed one-3 Done without dates,
    // which the Roadmap's read never holds
    await renderRoadmap(board, {
      focusPlan: {
        id: 'QN-3',
        n: 2,
        key: 'QN-3',
        uuid: 'one-3',
        project: one,
        start: null,
        end: null,
        status: 'done',
      },
    })
    await board.answer()
    await settle()
    await flush()
    expect(window.showToast).toHaveBeenCalledWith(
      "QN-3 can't be planned. A Done task without dates has nothing to plan on the Roadmap.",
      'error',
    )
    expect(window.showToast).toHaveBeenCalledTimes(1)
    expect(planCard('QN-3')).toBeNull()
    expect(consumedPlans).toHaveBeenCalledWith(2)
    // the open session stays, and the read names its task again
    expect(planCard('QN-1')).not.toBeNull()
    expect(roadmapAsks(board).at(-1)?.planned_task).toEqual({ id: 'one-1', project_id: one })
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

describe('the phone over the answer', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("lists the answer's tasks with Planned and Unplanned, says why past the ceiling, and turns to the same timeline", async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 760px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        // an unplanned task of the person's
        snap.issues.push(taskRow(snap, 'one-2', 'todo', 3))
      },
      { scope: 'mine' },
    )
    await renderRoadmap(board, { filters: { ...ROW, mine: true } })
    const schedule = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Task schedule',
    )
    await act(async () => schedule?.click())
    const agenda = () =>
      [...document.querySelectorAll<HTMLElement>('.mobile-roadmap-task-list [data-roadmap-row]')]
        .map((el) => el.dataset.roadmapRow)
        .sort()
    expect(agenda()).toEqual(['QN-1', 'QN-2', 'QN-3'])
    const show = async (value: string) => {
      const select = document.querySelector<HTMLSelectElement>('#mobile-roadmap-task-state')
      if (!select) throw new Error('no task choice')
      select.value = value
      await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })))
    }
    await show('planned')
    expect(agenda()).toEqual(['QN-1', 'QN-2'])
    await show('unplanned')
    expect(agenda()).toEqual(['QN-3'])
    await show('all')
    // the answer decides: a task it leaves out is not on the agenda
    board.server.roadmap.edit = (name, answer) => {
      const a = answer as RoadmapAnswer
      return name === 'tasks:roadmap' && a.state === 'ok'
        ? { ...a, rows: a.rows.filter((r) => r.id !== 'two-1') }
        : a
    }
    await board.answer()
    expect(agenda()).toEqual(['QN-1', 'QN-3'])
    // past the ceiling: the note in place of the schedule, with the phone's hint
    board.server.roadmap.force = ['over_ceiling']
    await board.answer()
    expect(agenda()).toEqual([])
    expect(document.querySelector('[data-empty-state]')?.textContent).toContain(
      'Narrow your filters, such as Priority, or open a project.',
    )
    // the landscape timeline over the same answer
    board.server.roadmap.force = []
    await board.answer()
    expect(agenda()).toEqual(['QN-1', 'QN-3'])
    const open = document.querySelector<HTMLButtonElement>('.mobile-roadmap-open-timeline button')
    await act(async () => open?.click())
    const landscape = document.querySelector('[data-roadmap-landscape]')
    expect(landscape).not.toBeNull()
    expect(
      [
        ...(landscape?.querySelectorAll<HTMLElement>(
          '[data-roadmap-task-top] [data-roadmap-task-open]',
        ) ?? []),
      ]
        .map((el) => el.dataset.roadmapTaskOpen)
        .sort(),
    ).toEqual(['QN-1', 'QN-3'])
  })
})
