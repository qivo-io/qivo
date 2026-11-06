// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* Team utilization under the Roadmap (views/Resources.tsx): its people are
   the owners of the Roadmap's shown tasks, and each person's hours come
   from the owner-load cache (planning.ownerLoads) reconciled with the rows
   on screen. A person whose load is on its way shows "…", one whose load
   could not be read or is past a guest's cap shows unknown, and neither
   ever shows a figure that reads as free time. The store boots without the
   workspace's tasks, as the app does. */

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

async function renderRoadmap(board: Board) {
  const { Roadmap } = await import('./Roadmap')
  await board.renderView(root, (info) => (
    <Roadmap
      info={info}
      filters={ROW}
      actions={new Proxy({}, { get: () => () => {} }) as never}
      filterControls={() => null}
      focusPlan={null}
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
})
