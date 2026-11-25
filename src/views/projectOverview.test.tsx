// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForcedOverview } from '../store/overviewStandIn.setup'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A project or sub-project's Overview (views/overview/ProjectOverview.tsx)
   from the server's answers, through the Overview's stand-in
   (store/overviewStandIn.setup.ts), whose Needs attention list holds the
   stored facts' kinds: the sentence and Tasks left, a count Qivo could not
   work out, a tab's read, and the row actions a reader may not use. The
   list's own rule is the server's, which convex/tests/overviewNeeds.test.ts
   tests. */

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Today's date `offset` days on, YYYY-MM-DD, local time. */
const day = (offset: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Plan over the fixture's sub-project One, with two tasks 3 and 10 days
    overdue and a paused one, and a task with nothing wrong, all One's. */
const plan = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  Object.assign(base, { parent_id: 'plan', name: 'One', track_delay: true })
  snap.issues.push({ ...taskRow(snap, 'late', 'progress', 1), due_date: day(-3) })
  snap.issues.push({ ...taskRow(snap, 'later', 'todo', 2), due_date: day(-10) })
  snap.issues.push({ ...taskRow(snap, 'held', 'todo', 3), paused: true })
  snap.issues.push(taskRow(snap, 'fine', 'todo', 4))
}

async function overview(
  prepare: (snap: Snapshot) => void,
  { scope = 'plan', force = {} as ForcedOverview } = {},
) {
  const board = await loadBoard(network, prepare, { scope })
  board.server.overview.force = force
  const { Overview } = await import('./Overview')
  const actions = new Proxy({}, { get: () => () => {} }) as never
  await board.renderView(root, (info: ScopeInfo) => <Overview info={info} actions={actions} />)
  return { board }
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const text = (selector: string) => q(selector)?.textContent ?? ''
const tab = (kind: string) => q(`[data-ov-tab="${kind}"]`)
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-need]')]
const needsAsked = (board: Awaited<ReturnType<typeof overview>>['board']) =>
  board.server.overview.asked.filter((a) => a.query === 'needs').map((a) => a.args)

describe("a project's Overview", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('states the overdue tasks, then says nothing needs attention and what is left once none does', async () => {
    await overview(plan)
    expect(text('[data-ov-sentence]')).toBe('2 tasks are overdue.')
    expect(text('[data-ov-figure="tasks-left"]')).toBe('Tasks left4')
    // the most days overdue first, then the paused task
    expect(rows().map((r) => r.dataset.kind)).toEqual(['overdue', 'overdue', 'paused'])
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      plan(snap)
      snap.issues = snap.issues.filter((t) => t.id === 'fine')
    })
    expect(text('[data-ov-sentence]')).toBe('Nothing needs attention. 1 task is left.')
    expect(text('[data-ov-needs]')).toBe('Nothing needs attention.')
  })

  it('reads a count it could not work out as unknown, never 0, and says the list may leave tasks out', async () => {
    await overview(plan, { force: { needs: 'unknown' } })
    for (const kind of ['all', 'projected', 'behind'])
      expect(tab(kind)?.getAttribute('aria-label'), kind).toMatch(/count unknown$/)
    expect(tab('overdue')?.getAttribute('aria-label')).toBe('Overdue, 2 tasks')
    expect(text('[data-ov-unknown]')).toContain('may leave tasks out')
    // the rows of the stored facts still show
    expect(rows()).toHaveLength(3)
  })

  it("asks the server for a tab's kind and shows its rows", async () => {
    const { board } = await overview(plan)
    expect(needsAsked(board).at(-1)).toMatchObject({ kind: 'all', limit: 20 })
    await act(async () => tab('paused')?.click())
    await board.answer()
    expect(needsAsked(board).at(-1)).toMatchObject({ kind: 'paused', limit: 20 })
    expect(tab('paused')?.getAttribute('aria-selected')).toBe('true')
    expect(rows().map((r) => r.dataset.kind)).toEqual(['paused'])
  })

  it('offers Reassign and Move due date on a row only to a reader who may edit its task', async () => {
    await overview(plan)
    expect(rows()[0]?.querySelector('[aria-label^="Reassign"]')).not.toBeNull()
    expect(rows()[0]?.querySelector('[aria-label^="Move due date"]')).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await overview((snap) => {
      plan(snap)
      snap.profiles[0].org_role = 'viewer'
      snap.access.push({ project_id: 'plan', profile_id: snap.profiles[0].id, level: 'viewer' })
    })
    expect(rows()).toHaveLength(3)
    expect(document.querySelector('[data-need] [aria-label^="Reassign"]')).toBeNull()
    expect(document.querySelector('[data-need] [aria-label^="Move due date"]')).toBeNull()
  })
})
