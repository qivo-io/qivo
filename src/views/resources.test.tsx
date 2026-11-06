// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'
import type { RoadmapRequest } from './Roadmap'

/* Team utilization under the Roadmap (views/Resources.tsx): its people are
   the owners of the Roadmap's shown tasks, and each person's hours come
   from the owner-load cache (planning.ownerLoads) reconciled with the rows
   on screen, never with a stopped read's kept rows. A person whose load is
   on its way shows "…", one whose load could not be read or is past a
   guest's cap shows unknown, and neither ever shows a figure that reads as
   free time. The store boots without the workspace's tasks, as the app
   does. */

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
  vi.stubGlobal('requestAnimationFrame', () => 0)
  // jsdom has no pointer capture, which a bar's drag takes
  Element.prototype.setPointerCapture = () => {}
  localStorage.clear()
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
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
const week = (n: number) => weekToISO(TODAY_WEEK + n)

/** A top-level project, Plan, over One (the fixture's) and Two. The
    fixture's person has 2 hours in One and 3 in Two, each over this week and
    next, and a paused task in Two next week with no hours. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One' })
  snap.projects.push({ ...base, id: 'two', key: 'TWO', num: 3, name: 'Two', parent_id: 'plan' })
  const dated = { start_week: week(0), end_week: week(1) }
  snap.issues.push({ ...taskRow(snap, 'one-1', 'todo', 1), remaining_hours: 2, ...dated })
  snap.issues.push({
    ...taskRow(snap, 'two-1', 'todo', 2),
    project_id: 'two',
    remaining_hours: 3,
    ...dated,
  })
  snap.issues.push({
    ...taskRow(snap, 'two-2', 'todo', 3),
    project_id: 'two',
    paused: true,
    start_week: week(1),
    end_week: week(1),
  })
}

type Board = Awaited<ReturnType<typeof loadBoard>>

/** A second person of the organization, `kind` a person or an agent. */
const OTHER = 'other-person'
const other = (snap: Snapshot, kind: 'person' | 'agent' = 'person') =>
  snap.profiles.push({
    ...snap.profiles[0],
    id: OTHER,
    auth_user_id: undefined,
    name: kind === 'agent' ? 'Agent' : 'Other',
    initials: 'OT',
    org_role: 'user',
    kind,
  })

/** One task each for the fixture's person (mine, QN-1) and OTHER
    (theirs, QN-2), 4 hours this week alone. */
const twoPeople =
  (kind: 'person' | 'agent' = 'person') =>
  (snap: Snapshot) => {
    other(snap, kind)
    const dated = { remaining_hours: 4, start_week: week(0), end_week: week(0) }
    snap.issues.push({ ...taskRow(snap, 'mine', 'todo', 1), ...dated })
    snap.issues.push({ ...taskRow(snap, 'theirs', 'todo', 2), assignee_id: OTHER, ...dated })
  }

/** Renders the Roadmap of the board's scope with `filters`, planning the
    task `focusPlan` names. */
async function renderRoadmap(
  board: Board,
  {
    filters = ROW,
    focusPlan = null,
  }: { filters?: IssueFilters; focusPlan?: RoadmapRequest | null } = {},
) {
  const { Roadmap } = await import('./Roadmap')
  await board.renderView(root, (info) => (
    <Roadmap
      info={info}
      filters={filters}
      actions={new Proxy({}, { get: () => () => {} }) as never}
      filterControls={() => null}
      focusPlan={focusPlan}
    />
  ))
}

/** The cells of person `id`'s row, by week. */
const cells = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-res-row="${id}"] [data-load-box]`)].map(
    (el) => ({
      week: Number(el.dataset.loadBox),
      hours: el.dataset.loadHours,
      pct: el.dataset.loadPct,
      paused: el.dataset.loadPaused !== undefined,
      unknown: el.dataset.loadUnknown !== undefined,
      waiting: el.dataset.loadWaiting !== undefined,
      text: el.textContent ?? '',
      label: el.closest('button')?.getAttribute('aria-label') ?? '',
    }),
  )

describe('Team utilization from the owner loads', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("spreads each person's hours from their load, with the paused weeks, and This project by project", async () => {
    const board = await loadBoard(network, plan, { scope: 'two' })
    const me = board.snapshot.profiles[0].id
    await renderRoadmap(board)
    const now = cells(me)
    const thisWeek = now.find((c) => c.week === TODAY_WEEK)
    const nextWeek = now.find((c) => c.week === TODAY_WEEK + 1)
    // All projects: One's 1 h a week from the cache's span, which the
    // Roadmap of Two does not show, and Two's 1.5 h from its row
    expect(thisWeek?.hours).toBe('2.5')
    const capacity = Number(
      document
        .querySelector(`[data-res-row="${me}"] [data-res-plannable]`)
        ?.getAttribute('data-res-plannable'),
    )
    const pct = String(Math.round((2.5 / capacity) * 100))
    expect(thisWeek?.pct).toBe(pct)
    expect(thisWeek?.text).toBe(`${pct}%`)
    // the paused task's week wears the mark and says so, with no hours
    expect(nextWeek?.paused).toBe(true)
    expect(nextWeek?.label).toContain('includes paused work')
    expect(thisWeek?.paused).toBe(false)
    // This project keeps Two's work alone, by each span's project
    const scope = document.querySelector<HTMLElement>('[data-strip-scope] button:nth-child(2)')
    await act(async () => scope?.click())
    expect(cells(me).find((c) => c.week === TODAY_WEEK)?.hours).toBe('1.5')
    expect(cells(me).find((c) => c.week === TODAY_WEEK + 1)?.paused).toBe(true)
  })

  it('shows "…" while a load is on its way and unknown where it cannot be read, never a figure', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    const me = board.snapshot.profiles[0].id
    board.server.holdLoads = true
    await renderRoadmap(board)
    const waiting = cells(me)
    expect(waiting.length).toBeGreaterThan(0)
    for (const cell of waiting) {
      expect(cell.waiting).toBe(true)
      expect(cell.text).toBe('…')
      expect(cell.label).toContain('Loading workload')
      expect(cell.pct).toBeUndefined()
    }
    // past the reader's bounds: unknown, with no percentage, hours, heat
    // or paused mark; a version that showed 0% fails here
    board.server.holdLoads = false
    board.server.unavailable = [me]
    await board.answer()
    const unknown = cells(me)
    for (const cell of unknown) {
      expect(cell.unknown).toBe(true)
      expect(cell.text).toBe('unknown')
      expect(cell.text).not.toMatch(/\d/)
      expect(cell.hours).toBeUndefined()
      expect(cell.pct).toBeUndefined()
      expect(cell.paused).toBe(false)
      expect(cell.label).toContain('workload unknown')
    }
    // and a readable load shows its figures again
    board.server.unavailable = []
    await board.answer()
    expect(cells(me).find((c) => c.week === TODAY_WEEK)?.text).toMatch(/^\d+%$/)
  })

  it('reads unknown, never a figure, where the owner-load call failed', async () => {
    const board = await loadBoard(network, plan, { scope: 'plan' })
    const me = board.snapshot.profiles[0].id
    board.server.failLoads = new Error('down')
    await renderRoadmap(board)
    const failed = cells(me)
    expect(failed.length).toBeGreaterThan(0)
    for (const cell of failed) {
      expect(cell.unknown).toBe(true)
      expect(cell.waiting).toBe(false)
      expect(cell.text).toBe('unknown')
      expect(cell.hours).toBeUndefined()
      expect(cell.pct).toBeUndefined()
      expect(cell.label).toContain('workload unknown')
    }
  })

  it("moves only the dragged task's weeks while its bar is dragged", async () => {
    const board = await loadBoard(network, twoPeople())
    const me = board.snapshot.profiles[0].id
    await renderRoadmap(board)
    const hoursOf = (id: string) =>
      Object.fromEntries(cells(id).map((c) => [c.week, Number(c.hours)]))
    const mine = hoursOf(me)
    const theirs = hoursOf(OTHER)
    expect(mine[TODAY_WEEK]).toBe(4)
    expect(mine[TODAY_WEEK + 1]).toBe(0)
    expect(theirs[TODAY_WEEK]).toBe(4)
    // drag the person's own bar one week later, and hold it there
    const handle = board.P.viewTask('roadmap', 'mine')?.id
    const bar = document.querySelector<HTMLElement>(`[data-bar="${handle}"]`)
    if (!bar) throw new Error('no bar')
    const weekW = Number.parseFloat(
      document
        .querySelector<HTMLElement>('[data-split-strip]')
        ?.style.getPropertyValue('--res-week') ?? '',
    )
    expect(weekW).toBeGreaterThan(0)
    const pointer = (type: string, clientX: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, pointerId: 1 })
    await act(async () => bar.dispatchEvent(pointer('pointerdown', 100)))
    await act(async () => bar.dispatchEvent(pointer('pointermove', 100 + weekW)))
    // the dragged task's two weeks change, and nothing else of anyone's
    const dragged = hoursOf(me)
    expect(dragged[TODAY_WEEK]).toBe(0)
    expect(dragged[TODAY_WEEK + 1]).toBe(4)
    for (const week of Object.keys(mine).map(Number))
      if (week !== TODAY_WEEK && week !== TODAY_WEEK + 1) expect(dragged[week]).toBe(mine[week])
    expect(hoursOf(OTHER)).toEqual(theirs)
  })

  it("shows an agent's hours, not a percentage", async () => {
    const board = await loadBoard(network, twoPeople('agent'))
    await renderRoadmap(board)
    const agent = cells(OTHER)
    const thisWeek = agent.find((c) => c.week === TODAY_WEEK)
    expect(thisWeek?.text).toBe('4 h')
    expect(thisWeek?.hours).toBe('4')
    expect(thisWeek?.pct).toBeUndefined()
    for (const cell of agent) expect(cell.text).not.toContain('%')
    // the person beside it reads a percentage of their week
    expect(cells(board.snapshot.profiles[0].id).find((c) => c.week === TODAY_WEEK)?.text).toMatch(
      /^\d+%$/,
    )
  })

  it("reads a guest's people one call each, the 50 with the most rows, and the rest as unknown", async () => {
    // 51 people with work on the Roadmap; the last owns one row, every
    // other two
    const board = await loadBoard(network, (snap) => {
      snap.profiles[0].org_role = 'guest'
      const base = snap.profiles[0]
      // a guest sees the project they hold a grant on
      snap.access.push({ project_id: snap.projects[0].id, profile_id: base.id, level: 'user' })
      let num = 0
      for (let i = 1; i <= 51; i++) {
        const id = `person-${String(i).padStart(2, '0')}`
        snap.profiles.push({
          ...base,
          id,
          auth_user_id: undefined,
          name: `Person ${i}`,
          org_role: 'user',
        })
        for (let n = 0; n < (i === 51 ? 1 : 2); n++)
          snap.issues.push({
            ...taskRow(snap, `${id}-${n}`, 'todo', ++num),
            assignee_id: id,
            remaining_hours: 4,
            start_week: week(0),
            end_week: week(0),
          })
      }
    })
    await renderRoadmap(board)
    const calls = [...board.server.loads].map((call) => call.args.owner_ids)
    // one owner a call, at most GUEST_CALLS of them
    expect(calls.every((owners) => owners.length === 1)).toBe(true)
    expect(calls.length).toBe(50)
    const last = cells('person-51')
    expect(last.length).toBeGreaterThan(0)
    for (const cell of last) {
      expect(cell.unknown).toBe(true)
      expect(cell.text).not.toMatch(/\d/)
    }
    expect(cells('person-01').find((c) => c.week === TODAY_WEEK)?.unknown).toBe(false)
  })

  it("counts a task only a stopped Board holds at its owner's load now, and not once it is Done", async () => {
    // two-1, of high priority, this week alone, which the Roadmap's filter
    // leaves out
    const board = await loadBoard(
      network,
      (snap) => {
        plan(snap)
        Object.assign(snap.issues[1], { priority: 'high', start_week: week(0), end_week: week(0) })
      },
      { scope: 'plan' },
    )
    const me = board.snapshot.profiles[0].id
    // the Board's answer holds two-1 at 3 hours; the Roadmap takes its
    // place, which stops the Board's read and keeps its rows
    await board.render(root)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(board.card('two-1')).not.toBeNull()
    board.P.roadmapContext(true, false)
    await renderRoadmap(board, {
      filters: { ...ROW, priority: 'medium' },
      focusPlan: {
        id: 'QN-1',
        n: 1,
        key: 'QN-1',
        uuid: 'one-1',
        project: board.snapshot.projects[0].id,
        start: TODAY_WEEK,
        end: TODAY_WEEK + 1,
      },
    })
    await act(async () => {})
    expect(board.P.viewTask('board:desktop', 'two-1')?.remaining).toBe(3)
    expect(board.P.viewTask('roadmap', 'two-1')).toBeUndefined()
    const thisWeek = () => cells(me).find((c) => c.week === TODAY_WEEK)?.hours
    const panel = () => document.querySelector('[data-plan-card]')?.textContent ?? ''
    expect(thisWeek()).toBe('4')
    expect(panel()).toMatch(/Two\s*3h/)
    // someone gives two-1 28 hours, and its owner's load answers so: the
    // stopped Board's row still says 3
    const two = board.snapshot.issues[1]
    two.remaining_hours = 28
    await board.answer()
    expect(board.P.viewTask('board:desktop', 'two-1')?.remaining).toBe(3)
    expect(thisWeek()).toBe('29')
    expect(panel()).toMatch(/Two\s*28h/)
    // and once it is Done its load has no span of it, so it counts no more
    two.status = 'done'
    await board.answer()
    expect(thisWeek()).toBe('1')
    expect(panel()).not.toMatch(/Two\s*\d/)
  })
})
