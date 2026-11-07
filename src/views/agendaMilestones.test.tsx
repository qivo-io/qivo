// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { IssueFilters } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* The phone Roadmap agenda's milestones (views/MobileRoadmap.tsx), the
   Overview's sections (views/useScopeMilestones.ts) on the Roadmap page's
   own slots, which the Roadmap reads so they outlive the agenda's
   remounts: Upcoming 10 at a time and a collapsed Past, a `mine` read in
   My view, the reads stopped while the task schedule or the landscape
   timeline shows and freed by P.releaseRoadmap, the reads under a note
   whatever section the person chose, and the Roadmap's own flag read
   stopped while the agenda shows. */

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
  // a phone
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
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
const AT = '2026-09-14T08:00:00.000Z'

/** The week `n` weeks from this one, as a stored day. */
const week = (n: number) => weekToISO(TODAY_WEEK + n)

/** Plan over the fixture's sub-project One with a task of mine, 12 weekly
    milestones from this week on (u1 first) and 3 before it (p1 newest),
    and Side, a top-level project of its own whose one task is no one's,
    with milestone s1. */
const plan = (snap: Snapshot) => {
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
  snap.projects.push({ ...base, id: 'aside', key: 'AS', num: 4, name: 'Aside', parent_id: 'side' })
  snap.issues.push({ ...taskRow(snap, 'one-1', 'todo', 1), start_week: week(0), end_week: week(1) })
  snap.issues.push({
    ...taskRow(snap, 'side-1', 'todo', 2),
    project_id: 'aside',
    assignee_id: undefined,
  })
  for (let i = 0; i < 12; i++)
    snap.milestones.push({
      id: `u${i + 1}`,
      project_id: 'plan',
      name: `Step ${i + 1}`,
      week: week(i),
      created_at: AT,
    })
  for (let i = 0; i < 3; i++)
    snap.milestones.push({
      id: `p${i + 1}`,
      project_id: 'plan',
      name: `Review ${i + 1}`,
      week: week(-1 - i),
      created_at: AT,
    })
  snap.milestones.push({
    id: 's1',
    project_id: 'side',
    name: 'Side gate',
    week: week(1),
    created_at: AT,
  })
}

/** Loads the fixture over `scope` and renders its Roadmap, the phone's
    agenda. */
async function agenda(scope = 'plan') {
  const board = await loadBoard(network, plan, { scope })
  const { Roadmap } = await import('./Roadmap')
  const { WorkspaceShell } = await import('../components/WorkspaceShell')
  const store = await import('../store/planner')
  const actions = new Proxy({} as Record<string, () => void>, {
    get: (target, name: string) => target[name] ?? (() => {}),
  }) as never
  await board.renderView(root, (info) => (
    <WorkspaceShell header={null}>
      <Roadmap
        info={info}
        filters={{ ...ROW, mine: scope === 'mine' }}
        actions={actions}
        filterControls={() => null}
        focusPlan={null}
        revealTask={null}
        onFocusConsumed={() => {}}
      />
    </WorkspaceShell>
  ))
  return { board, store }
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const sectionOf = (side: 'upcoming' | 'past') =>
  q(`[data-agenda-milestones] [data-milestone-section="${side}"]`)
const rowsOf = (side: 'upcoming' | 'past') =>
  [...(sectionOf(side)?.querySelectorAll<HTMLElement>('[data-agenda-milestone]') ?? [])].map(
    (e) => e.dataset.agendaMilestone,
  )
const press = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null)?.click())
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
type Board = Awaited<ReturnType<typeof agenda>>['board']
const asks = (board: Board, name: string) =>
  board.server.milestones.asked
    .filter((a) => a.name === name)
    .map((a) => a.args as Record<string, unknown>)
const live = (board: Board, name: string) =>
  [...board.server.milestones.open].filter((s) => s.name === name)

describe("the phone agenda's milestones", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('lists Upcoming 10 at a time and a collapsed Past from the server, on its own slots', async () => {
    const { board, store } = await agenda()
    expect(sectionOf('upcoming')?.dataset.milestoneSectionState).toBe('ok')
    expect(rowsOf('upcoming')).toEqual(Array.from({ length: 10 }, (_, i) => `u${i + 1}`))
    expect(asks(board, 'milestones:section')[0]).toMatchObject({
      projects: ['plan'],
      side: 'upcoming',
      limit: 10,
    })
    // the Roadmap's flags do not read while the agenda shows
    expect(live(board, 'milestones:between')).toHaveLength(0)
    // Past reads nothing until it opens, and its toggle says no count
    const toggle = q('[data-agenda-milestones] [data-milestone-past-toggle]')
    expect(toggle?.textContent).toBe('Past milestones')
    expect(asks(board, 'milestones:section').some((a) => a.side === 'past')).toBe(false)
    await press(toggle)
    expect(rowsOf('past')).toEqual(['p1', 'p2', 'p3'])
    await press(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
    expect(rowsOf('upcoming')).toHaveLength(12)
    expect(
      store.AGENDA_MILESTONE_SLOTS.upcoming.some((s) => store.P.milestoneRead(s).state === 'ok'),
    ).toBe(true)
    expect(
      store.OVERVIEW_MILESTONE_SLOTS.upcoming.every(
        (s) => store.P.milestoneRead(s).state === 'loading',
      ),
    ).toBe(true)
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it('stops while the task schedule and the landscape timeline show, keeps its Load more and Past, and is freed by P.releaseRoadmap', async () => {
    const { board, store } = await agenda()
    await press(sectionOf('upcoming')?.querySelector('[data-milestone-more]'))
    await press(q('[data-agenda-milestones] [data-milestone-past-toggle]'))
    expect(live(board, 'milestones:section')).toHaveLength(2)
    await press(button('Task schedule'))
    expect(live(board, 'milestones:section')).toHaveLength(0)
    await press(button('Milestones'))
    expect(live(board, 'milestones:section')).toHaveLength(2)
    expect(rowsOf('upcoming')).toHaveLength(12)
    // the landscape timeline unmounts the agenda; the reads stop, and on
    // return the agenda shows its kept rows, Load more and open Past
    board.server.milestones.hold = true
    await press(q('.mobile-roadmap-open-timeline button'))
    expect(q('[data-agenda-milestones]')).toBeNull()
    expect(live(board, 'milestones:section')).toHaveLength(0)
    const landscape = q('[data-roadmap-landscape]')
    expect(landscape).not.toBeNull()
    // Escape closes the landscape timeline, back to the agenda
    await act(async () => {
      landscape?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(q('[data-agenda-milestones]')).not.toBeNull())
    expect(sectionOf('upcoming')?.dataset.milestoneSectionState).toBe('refreshing')
    expect(rowsOf('upcoming')).toHaveLength(12)
    expect(rowsOf('past')).toEqual(['p1', 'p2', 'p3'])
    board.server.milestones.hold = false
    await board.answer()
    await act(async () => store.P.releaseRoadmap())
    expect(
      [...store.AGENDA_MILESTONE_SLOTS.upcoming, ...store.AGENDA_MILESTONE_SLOTS.past].every(
        (s) => store.P.milestoneRead(s).state === 'loading',
      ),
    ).toBe(true)
  })

  it('reads under a note that comes while the task schedule shows, as the agenda then lists its milestones', async () => {
    const { board } = await agenda()
    await press(button('Task schedule'))
    expect(live(board, 'milestones:section')).toHaveLength(0)
    // the Roadmap's read fails while the person stays on Task schedule, so
    // its note takes the agenda's place, with the milestone section under
    // it whatever section the person chose
    board.server.roadmap.fail = new Error('down')
    await board.answer()
    expect(document.body.textContent).toContain('The Roadmap could not be loaded')
    // must fail for an agenda whose reads are active without !!emptyNote
    expect(live(board, 'milestones:section')).toHaveLength(1)
    await vi.waitFor(() => expect(sectionOf('upcoming')?.dataset.milestoneSectionState).toBe('ok'))
    expect(rowsOf('upcoming')).toEqual(Array.from({ length: 10 }, (_, i) => `u${i + 1}`))
    // the section, not New milestone alone, stands under the note
    expect(button('New milestone')).toBeUndefined()
  })

  it("reads My view with mine and lists only the projects that hold the person's own work", async () => {
    const { board } = await agenda('mine')
    const sections = asks(board, 'milestones:section')
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.every((a) => a.mine === true && (a.projects as string[]).length === 0)).toBe(
      true,
    )
    expect(rowsOf('upcoming')).toContain('u1')
    expect(rowsOf('upcoming')).not.toContain('s1')
    expect(document.body.textContent).toContain('Open a project to add a milestone to its roadmap.')
  })

  it('lists none in All projects', async () => {
    const { board } = await agenda('all')
    expect(asks(board, 'milestones:section')).toEqual([])
    expect(q('[data-agenda-milestones]')).toBeNull()
  })
})
