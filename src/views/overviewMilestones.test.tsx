// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* The Overview's milestones from the server (views/useScopeMilestones.ts,
   views/overview/OverviewMilestones.tsx): Upcoming 10 at a time with Load
   more and the move on at a lowered cap, a collapsed Past that reads
   nothing until it opens, 25 at a time with its search on the server, the
   Next milestone cell in each state, My view's `mine` read, All projects
   reading none, the note pages, another person's rename, move and delete
   arriving while the page shows, a hidden tab, a kept page, a scope switch,
   P.releaseOverview and a new week. The reads answer through the milestone
   stand-in over the fixture's workspace (store/milestoneStandIn.setup.ts).
   Every case asks for no task. */

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
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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
  vi.restoreAllMocks()
})

const AT = '2026-09-14T08:00:00.000Z'

/** The Monday `weeks` weeks after this week's, local time, as a stored day. */
function mondayIn(weeks: number) {
  const day = new Date()
  day.setDate(day.getDate() + 7 * weeks - ((day.getDay() + 6) % 7))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Plan, a top-level project over the fixture's sub-project One, with a
    task of mine in One, `up` weekly milestones from this week on (u1
    first, Step 1 on) and `past` weekly ones before it (p1 newest, Audit
    or Review by turns). Side, a top-level project of its own with a task
    of no one's, holds one upcoming milestone, s1. */
const plan =
  (o: { up?: number; past?: number } = {}) =>
  (snap: Snapshot) => {
    const base = snap.projects[0]
    snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
    Object.assign(base, { parent_id: 'plan', name: 'One' })
    snap.projects.push({
      ...base,
      id: 'side',
      type: 'meta',
      key: 'SIDE',
      num: 3,
      name: 'Side',
      parent_id: undefined,
    })
    snap.projects.push({
      ...base,
      id: 'sidework',
      key: 'SW',
      num: 4,
      name: 'Aside',
      parent_id: 'side',
    })
    snap.issues.push(taskRow(snap, 'mine', 'todo', 1))
    snap.issues.push({
      ...taskRow(snap, 'theirs', 'todo', 2),
      project_id: 'sidework',
      assignee_id: undefined,
    })
    for (let i = 0; i < (o.up ?? 0); i++)
      snap.milestones.push({
        id: `u${i + 1}`,
        project_id: 'plan',
        name: `Step ${i + 1}`,
        week: mondayIn(i),
        created_at: AT,
      })
    for (let i = 0; i < (o.past ?? 0); i++)
      snap.milestones.push({
        id: `p${i + 1}`,
        project_id: 'plan',
        name: `${i % 2 ? 'Review' : 'Audit'} ${i + 1}`,
        week: mondayIn(-1 - i),
        created_at: AT,
      })
    snap.milestones.push({
      id: 's1',
      project_id: 'side',
      name: 'Side gate',
      week: mondayIn(1),
      created_at: AT,
    })
  }

/** Loads the fixture with `prepare` over `scope` and renders the Overview. */
async function overview(prepare: (snap: Snapshot) => void, { scope = 'plan' } = {}) {
  const board = await loadBoard(network, prepare, { scope })
  const { Overview } = await import('./Overview')
  const store = await import('../store/planner')
  const section = await import('../lib/milestoneSection')
  const actions = {
    setScope: vi.fn(),
    setView: vi.fn(),
    openIssue: vi.fn(),
    newIssue: vi.fn(),
    newProject: vi.fn(),
    newMilestone: vi.fn(),
    editMilestone: vi.fn(),
    openPalette: vi.fn(),
  }
  const render = (view?: (info: ScopeInfo) => React.ReactNode) =>
    board.renderView(root, view ?? ((info) => <Overview info={info} actions={actions} />))
  await render()
  return { board, actions, Overview, render, store, section }
}
type Loaded = Awaited<ReturnType<typeof overview>>

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const sectionOf = (side: 'upcoming' | 'past') =>
  q(`[data-overview-milestones] [data-milestone-section="${side}"]`)
const stateOf = (side: 'upcoming' | 'past') => sectionOf(side)?.dataset.milestoneSectionState
/** The ids of the rows a section shows, in order. */
const rowsOf = (side: 'upcoming' | 'past') =>
  [...(sectionOf(side)?.querySelectorAll<HTMLElement>('[data-overview-milestone]') ?? [])].map(
    (e) => e.dataset.overviewMilestone,
  )
const noteOf = (side: 'upcoming' | 'past') =>
  [...(sectionOf(side)?.querySelectorAll<HTMLElement>('[data-milestone-note]') ?? [])].map(
    (e) => `${e.dataset.milestoneNote}: ${e.textContent}`,
  )
const cell = () => q('[data-ov-figure="next-milestone"]')
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null)?.click())
/** The section reads asked, in order. */
const sectionAsks = (b: Loaded['board']) =>
  b.server.milestones.asked
    .filter((a) => a.name === 'milestones:section')
    .map(
      (a) =>
        a.args as {
          side: string
          limit: number
          mine?: true
          projects: string[]
          search?: string
          after?: unknown
        },
    )
/** The live section reads now. */
const liveSections = (b: Loaded['board']) =>
  [...b.server.milestones.open].filter((s) => s.name === 'milestones:section')

/** Sets the page's visibility, as the browser does when a tab hides. */
async function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}

describe("a project's Upcoming", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('asks 10 and shows them in the answer order, Load more asks 20, and Next milestone is the first row', async () => {
    const { board, store } = await overview(plan({ up: 14 }))
    expect(stateOf('upcoming')).toBe('ok')
    expect(rowsOf('upcoming')).toEqual(Array.from({ length: 10 }, (_, i) => `u${i + 1}`))
    const first = sectionAsks(board)[0]
    expect(first).toMatchObject({ projects: ['plan'], side: 'upcoming', limit: 10 })
    expect(first).not.toHaveProperty('mine')
    // the next milestone, from Upcoming's first row, with its emphasis
    expect(cell()?.dataset.ovFigureState).toBe('ok')
    expect(cell()?.textContent).toContain('Step 1')
    expect(q('[data-overview-milestone="u1"]')?.hasAttribute('data-next')).toBe(true)
    expect(q('[data-overview-milestone="u2"]')?.hasAttribute('data-next')).toBe(false)
    await click(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
    expect(sectionAsks(board).at(-1)).toMatchObject({ limit: 20 })
    expect(rowsOf('upcoming')).toHaveLength(14)
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-more]')).toBeNull()
    // the answer sits on the Overview's fixed slots
    const slots = store.OVERVIEW_MILESTONE_SLOTS.upcoming.map(
      (slot) => store.P.milestoneRead(slot).state,
    )
    expect(slots).toContain('ok')
    // no task is asked for
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it('moves on at a lowered cap with Show from the start, and takes Next milestone from a one-row read', async () => {
    const loaded = await overview(plan({ up: 7 }))
    const { board, section, store } = loaded
    Object.assign(section.OVERVIEW_MILESTONES.upcoming, { batch: 2, rows: 4 })
    try {
      // a new mount reads with the lowered sizes
      await act(async () => root.unmount())
      root = createRoot(container)
      await loaded.render()
      expect(rowsOf('upcoming')).toEqual(['u1', 'u2'])
      await click(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
      expect(rowsOf('upcoming')).toEqual(['u1', 'u2', 'u3', 'u4'])
      await click(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
      // at the cap the first batch leaves
      expect(rowsOf('upcoming')).toEqual(['u3', 'u4', 'u5', 'u6'])
      expect(
        sectionOf('upcoming')?.querySelector('[data-milestone-dropped]')?.textContent,
      ).toContain('Earlier milestones are not shown.')
      // Next milestone is still Step 1, from a read of one row on its own
      // slot, and no row shows the emphasis
      expect(cell()?.textContent).toContain('Step 1')
      expect(sectionAsks(board).some((a) => a.limit === 1 && a.after === undefined)).toBe(true)
      expect(store.P.milestoneRead(store.OVERVIEW_MILESTONE_SLOTS.next).state).toBe('ok')
      expect(q('[data-overview-milestones] [data-next]')).toBeNull()
      await click(sectionOf('upcoming')?.querySelector('[data-milestone-from-start]'))
      expect(rowsOf('upcoming')).toEqual(['u1', 'u2'])
      // the one-row read goes once Upcoming shows the first row again
      expect(store.P.milestoneRead(store.OVERVIEW_MILESTONE_SLOTS.next).state).toBe('loading')
      expect(q('[data-overview-milestone="u1"]')?.hasAttribute('data-next')).toBe(true)
    } finally {
      Object.assign(section.OVERVIEW_MILESTONES.upcoming, { batch: 10, rows: 100 })
    }
  })
})

describe("a project's Past", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('reads nothing until it opens, then 25 newest first, searches on the server and loads more; a collapse releases it', async () => {
    const { board } = await overview(plan({ up: 2, past: 30 }))
    const toggle = () => q('[data-overview-milestones] [data-milestone-past-toggle]')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    expect(sectionAsks(board).some((a) => a.side === 'past')).toBe(false)
    expect(rowsOf('past')).toEqual([])
    await click(toggle())
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(sectionAsks(board).filter((a) => a.side === 'past')).toEqual([
      expect.objectContaining({ projects: ['plan'], side: 'past', limit: 25 }),
    ])
    expect(rowsOf('past')).toEqual(Array.from({ length: 25 }, (_, i) => `p${i + 1}`))
    // Past's rows are dimmed
    expect(q('[data-overview-milestone="p1"]')?.hasAttribute('data-past')).toBe(true)
    await click(sectionOf('past')?.querySelector('[data-milestone-more]'))
    expect(rowsOf('past')).toHaveLength(30)
    // its search runs on the server, once there were more rows to load
    const box = sectionOf('past')?.querySelector<HTMLInputElement>('[data-milestone-search]')
    expect(box).not.toBeNull()
    // the server holds the search's answer back, so the section shows what
    // it has while the new search loads
    board.server.milestones.hold = true
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, 'review')
      box?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => await new Promise((r) => setTimeout(r, 350)))
    // a new search releases the shown slot at once and shows loading, never
    // the old rows; must fail for a new search that keeps the old answer
    // showing, as the Roadmap's flags keep theirs while a new window loads
    expect(stateOf('past')).toBe('loading')
    expect(rowsOf('past')).toEqual([])
    const pastReads = () =>
      liveSections(board)
        .map((s) => s.args as { side: string; search?: string })
        .filter((a) => a.side === 'past')
    expect(pastReads()).toEqual([expect.objectContaining({ search: 'review' })])
    board.server.milestones.hold = false
    await board.answer()
    expect(sectionAsks(board).at(-1)).toMatchObject({ side: 'past', search: 'review', limit: 25 })
    expect(stateOf('past')).toBe('ok')
    expect(rowsOf('past')).toEqual(Array.from({ length: 15 }, (_, i) => `p${2 * (i + 1)}`))
    // Upcoming has no search
    expect(sectionOf('upcoming')?.querySelector('[data-milestone-search]')).toBeNull()
    // a collapse releases Past's reads
    await click(toggle())
    expect(liveSections(board).some((s) => (s.args as { side: string }).side === 'past')).toBe(
      false,
    )
    expect(rowsOf('past')).toEqual([])
  })
})

describe('the Next milestone cell and the section states', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('says loading, none scheduled and unavailable, never none for a failed, refused or stopped read', async () => {
    const loaded = await overview(plan({ up: 0 }))
    const { board } = loaded
    // a project whose whole Upcoming is empty and holds no past milestone
    expect(cell()?.textContent).toContain('None scheduled')
    expect(noteOf('upcoming')).toEqual(['empty: No milestones yet. Add one with the + button.'])
    // a new page each time, after App let the last one go, as it frees
    // a page it no longer keeps (P.releaseOverview)
    const again = async (force: Record<string, unknown>) => {
      board.server.milestones.force = force
      await act(async () => root.unmount())
      await act(async () => loaded.store.P.releaseOverview())
      root = createRoot(container)
      await loaded.render()
    }
    await again({ upcoming: 'loading' })
    expect(cell()?.dataset.ovFigureState).toBe('loading')
    expect(cell()?.textContent).not.toContain('None scheduled')
    expect(stateOf('upcoming')).toBe('loading')
    for (const [force, state, note] of [
      ['error', 'failed', "failed: Couldn't load milestones.Retry"],
      ['refused', 'refused', 'refused: '],
      ['stopped', 'ok', 'stopped: Qivo checked part of the list. Load more continues.'],
    ] as const) {
      await again({ upcoming: force })
      expect(cell()?.dataset.ovFigureState, force).toBe('unavailable')
      expect(cell()?.textContent, force).toContain('Unavailable')
      expect(cell()?.textContent, force).not.toContain('None scheduled')
      expect(stateOf('upcoming'), force).toBe(state)
      expect(
        noteOf('upcoming').some((n) => n.startsWith(note)),
        force,
      ).toBe(true)
      expect(
        noteOf('upcoming').some((n) => n.startsWith('empty')),
        force,
      ).toBe(false)
    }
    board.server.milestones.force = {}
  })

  it('keeps the next milestone and its emphasis while a failed Load more says so', async () => {
    const { board } = await overview(plan({ up: 12 }))
    board.server.milestones.force = { more: 'error' }
    await click(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
    expect(noteOf('upcoming').some((n) => n.startsWith('more-failed'))).toBe(true)
    expect(rowsOf('upcoming')).toHaveLength(10)
    // must fail for a cell that reads any failure as unavailable
    expect(cell()?.dataset.ovFigureState).toBe('ok')
    expect(cell()?.textContent).toContain('Step 1')
    expect(q('[data-overview-milestone="u1"]')?.hasAttribute('data-next')).toBe(true)
    board.server.milestones.force = {}
  })

  it('shows a past milestone project as having history, and Retry asks again', async () => {
    const { board, render, store } = await overview(plan({ past: 1 }))
    expect(noteOf('upcoming')).toEqual(['empty: No upcoming milestones.'])
    expect(cell()?.textContent).toContain('None scheduled')
    board.server.milestones.force = { upcoming: 'error' }
    await act(async () => root.unmount())
    await act(async () => store.P.releaseOverview())
    root = createRoot(container)
    await render()
    expect(cell()?.textContent).toContain('Unavailable')
    board.server.milestones.force = {}
    await click(
      [...(sectionOf('upcoming')?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'Retry',
      ),
    )
    expect(stateOf('upcoming')).toBe('ok')
  })
})

describe('My view and All projects', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("reads My view with mine and no projects, names each row's project, and leaves out a project without own work", async () => {
    const { board } = await overview(plan({ up: 2 }), { scope: 'mine' })
    const asks = sectionAsks(board)
    expect(asks.length).toBeGreaterThan(0)
    expect(asks.every((a) => a.mine === true && a.projects.length === 0)).toBe(true)
    expect(rowsOf('upcoming')).toEqual(['u1', 'u2'])
    // Side holds no task of mine
    expect(q('[data-overview-milestone="s1"]')).toBeNull()
    expect(q('[data-overview-milestone="u1"]')?.textContent).toContain('Plan')
  })

  it("adds My view's hint to the too-many and read-too-large notes", async () => {
    const loaded = await overview(plan({ up: 2 }), { scope: 'mine' })
    for (const [force, note] of [
      ['too_many', 'too-many'],
      ['refused', 'refused'],
    ] as const) {
      loaded.board.server.milestones.force = { mine: force }
      await act(async () => root.unmount())
      root = createRoot(container)
      await loaded.render()
      const text = sectionOf('upcoming')?.querySelector(
        `[data-milestone-note="${note}"]`,
      )?.textContent
      expect(text, force).toContain('Open a project to see its milestones.')
      expect(cell()?.textContent).toContain('Unavailable')
      // Past would be refused the same way, so it does not show
      expect(q('[data-overview-milestones] [data-milestone-past-toggle]')).toBeNull()
    }
  })

  it('asks nothing in All projects, whose chooser is the whole page', async () => {
    const { board } = await overview(plan({ up: 2 }), { scope: 'all' })
    expect(sectionAsks(board)).toEqual([])
    expect(q('[data-overview-milestones]')).toBeNull()
    expect(q('[data-overview-milestone]')).toBeNull()
  })
})

describe('the note pages', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('stands the section under a note once Upcoming holds a row, and leaves the note alone for a scope with no milestone', async () => {
    // a top-level project without a task: its note is "No tasks yet"
    const empty = (o: { up?: number }) => (snap: Snapshot) => {
      plan(o)(snap)
      snap.issues = []
    }
    const loaded = await overview(empty({ up: 1 }))
    expect(q('[data-overview-milestones]')).not.toBeNull()
    expect(rowsOf('upcoming')).toEqual(['u1'])
    await act(async () => root.unmount())
    root = createRoot(container)
    const none = await overview(empty({ up: 0 }))
    expect(q('[data-overview-milestones]')).toBeNull()
    // until Upcoming answers, the note is the page; a milestone that comes
    // after the summary brings the section under it
    await act(async () => root.unmount())
    root = createRoot(container)
    none.board.server.milestones.hold = true
    await none.render()
    expect(q('[data-overview-milestones]')).toBeNull()
    none.board.snapshot.milestones.push({
      id: 'late',
      project_id: 'plan',
      name: 'Late gate',
      week: mondayIn(2),
      created_at: AT,
    })
    none.board.server.milestones.hold = false
    await none.board.answer()
    expect(rowsOf('upcoming')).toEqual(['late'])
    expect(loaded.board.snapshot.milestones).toHaveLength(2)
  })
})

describe("another person's changes", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('arrive in Upcoming, Next milestone and an open Past while the page shows, and wait while the tab hides', async () => {
    const { board } = await overview(plan({ up: 4, past: 2 }))
    await click(q('[data-overview-milestones] [data-milestone-past-toggle]'))
    expect(rowsOf('upcoming')).toEqual(['u1', 'u2', 'u3', 'u4'])
    expect(rowsOf('past')).toEqual(['p1', 'p2'])
    expect(cell()?.textContent).toContain('Step 1')
    const named = (id: string) => q(`[data-overview-milestone="${id}"]`)?.textContent
    const stored = (id: string) => {
      const row = board.snapshot.milestones.find((m) => m.id === id)
      if (!row) throw new Error(`no milestone ${id}`)
      return row
    }
    // someone else renames u1, moves u2 to a past week and deletes u3; the
    // server pushes the new answers of both live reads, and the workspace's
    // copy stays as it was; must fail for a section that keeps the first
    // answer of its arguments
    stored('u1').name = 'Kickoff'
    stored('u2').week = mondayIn(-3)
    board.snapshot.milestones = board.snapshot.milestones.filter((m) => m.id !== 'u3')
    await board.answer()
    expect(rowsOf('upcoming')).toEqual(['u1', 'u4'])
    expect(named('u1')).toContain('Kickoff')
    expect(cell()?.textContent).toContain('Kickoff')
    expect(q('[data-overview-milestone="u1"]')?.hasAttribute('data-next')).toBe(true)
    expect(rowsOf('past')).toEqual(['p1', 'p2', 'u2'])
    expect(q('[data-overview-milestone="u3"]')).toBeNull()
    // while the tab hides neither section reads, so a change waits; must
    // fail for an open Past that keeps reading while the tab hides
    await setVisibility('hidden')
    expect(liveSections(board)).toHaveLength(0)
    const asked = sectionAsks(board).length
    stored('u4').name = 'Launch'
    board.snapshot.milestones = board.snapshot.milestones.filter((m) => m.id !== 'p1')
    await board.answer()
    expect(sectionAsks(board)).toHaveLength(asked)
    expect(liveSections(board)).toHaveLength(0)
    expect(named('u4')).toContain('Step 4')
    expect(rowsOf('past')).toEqual(['p1', 'p2', 'u2'])
    // the return reads both sections again, and the changes arrive
    await setVisibility('visible')
    await board.answer()
    expect(named('u4')).toContain('Launch')
    expect(rowsOf('past')).toEqual(['p2', 'u2'])
  })
})

describe('hidden, kept, another scope and a new week', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('reads nothing while the tab hides, and shows its rows refreshing on return', async () => {
    const { board } = await overview(plan({ up: 3 }))
    expect(liveSections(board).length).toBe(1)
    await setVisibility('hidden')
    expect(liveSections(board)).toHaveLength(0)
    expect(rowsOf('upcoming')).toEqual(['u1', 'u2', 'u3'])
    board.server.milestones.hold = true
    const asked = sectionAsks(board).length
    await setVisibility('visible')
    expect(stateOf('upcoming')).toBe('refreshing')
    expect(rowsOf('upcoming')).toEqual(['u1', 'u2', 'u3'])
    // the same arguments, asked again on the same slot
    expect(sectionAsks(board).slice(asked)).toEqual([sectionAsks(board)[0]])
    board.server.milestones.hold = false
    await board.answer()
    expect(stateOf('upcoming')).toBe('ok')
  })

  it('stops while its kept page hides and shows the kept rows refreshing on the same slots, which App frees', async () => {
    const { board, Overview, render, store } = await overview(plan({ up: 3 }))
    const { KeptView } = await import('../components/KeptView')
    const kept = (shown: boolean) =>
      render((info) => (
        <KeptView view="overview" shown={shown} className="view">
          <Overview info={info} actions={{} as never} />
        </KeptView>
      ))
    await kept(true)
    expect(liveSections(board)).toHaveLength(1)
    await kept(false)
    expect(liveSections(board)).toHaveLength(0)
    // the answer stays on its slot, not released
    const slot = store.OVERVIEW_MILESTONE_SLOTS.upcoming.find(
      (s) => store.P.milestoneRead(s).state === 'ok',
    )
    expect(slot).toBeDefined()
    board.server.milestones.hold = true
    await kept(true)
    expect(stateOf('upcoming')).toBe('refreshing')
    expect(rowsOf('upcoming')).toEqual(['u1', 'u2', 'u3'])
    board.server.milestones.hold = false
    await board.answer()
    expect(stateOf('upcoming')).toBe('ok')
    // App lets the page go
    await act(async () => store.P.releaseOverview())
    expect(
      store.OVERVIEW_MILESTONE_SLOTS.upcoming.every(
        (s) => store.P.milestoneRead(s).state === 'loading',
      ),
    ).toBe(true)
  })

  it('takes the fixed slots over on a scope switch, so at most two a section hold answers', async () => {
    const { board, Overview, store } = await overview(plan({ up: 3, past: 2 }))
    await click(q('[data-overview-milestones] [data-milestone-past-toggle]'))
    // another scope mounts a new page, as App does with a new scope
    for (const scope of ['side', 'plan', 'side']) {
      await act(async () => root.unmount())
      root = createRoot(container)
      await board.renderView(root, () => (
        <Overview info={store.P.scopeInfo(scope) as ScopeInfo} actions={{} as never} />
      ))
      await board.answer()
    }
    expect(rowsOf('upcoming')).toEqual(['s1'])
    // the last page holds Upcoming's first fixed slot, and nothing else is
    // left of the pages before it
    const held = [
      ...store.OVERVIEW_MILESTONE_SLOTS.upcoming,
      ...store.OVERVIEW_MILESTONE_SLOTS.past,
    ].filter((s) => store.P.milestoneRead(s).state !== 'loading')
    expect(held).toEqual([store.OVERVIEW_MILESTONE_SLOTS.upcoming[0]])
    // a new mount opens Past collapsed
    expect(q('[data-milestone-past-toggle]')?.getAttribute('aria-expanded') ?? 'false').toBe(
      'false',
    )
  })

  it('starts both sections again in a new week and keeps an open Past open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Sunday evening of this week, then Monday morning
    const sunday = new Date()
    sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7))
    sunday.setHours(23, 50, 0, 0)
    vi.setSystemTime(sunday)
    const { board } = await overview(plan({ up: 3, past: 2 }))
    await click(q('[data-overview-milestones] [data-milestone-past-toggle]'))
    const before = sectionAsks(board).at(-1)
    await setVisibility('hidden')
    vi.setSystemTime(new Date(sunday.getTime() + 20 * 60_000))
    await setVisibility('visible')
    await board.answer()
    const froms = new Set(sectionAsks(board).map((a) => (a as { from?: string }).from))
    expect(froms.size).toBe(2)
    const after = sectionAsks(board).filter(
      (a) => (a as { from?: string }).from !== (before as { from?: string }).from,
    )
    expect(after.some((a) => a.side === 'upcoming' && a.limit === 10)).toBe(true)
    expect(after.some((a) => a.side === 'past' && a.limit === 25)).toBe(true)
    expect(q('[data-milestone-past-toggle]')?.getAttribute('aria-expanded')).toBe('true')
  })
})
