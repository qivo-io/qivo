// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from '../views/boardFixture.setup'
import { keepsRoadmap, roadmapRequest } from '../views/roadmap/roadmapArgs'
import type { IssueFilters } from './planner'
import { type Snapshot, underProgram } from './plannerFixture.setup'

/* The store's Roadmap reads (P.watchRoadmap, P.watchRoadmapDependencies)
   and the owners the Roadmap registers with the owner-load cache
   (P.watchRoadmapTeam, P.watchPlanLoad): what each read holds as its
   arguments change, what a release forgets, that the answer's rows enter
   the views' rows and never the workspace's, and that a hidden page holds
   no subscription. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

beforeEach(() => {
  window.showToast = vi.fn()
})
afterEach(() => {
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
const week = (n: number) => weekToISO(TODAY_WEEK + n)

/** Two sub-projects, One (the fixture's) with a task a this week, and
    Two with a task b. */
const two = (snap: Snapshot) => {
  underProgram(snap)
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'two', key: 'TWO', num: 2, name: 'Two' })
  snap.issues.push(
    { ...taskRow(snap, 'a', 'todo', 1), start_week: week(0), end_week: week(0) },
    { ...taskRow(snap, 'b', 'todo', 2), project_id: 'two' },
  )
}

type Board = Awaited<ReturnType<typeof loadBoard>>

/** The Roadmap read's key for sub-project `id` in the window from `w0`. */
function keyOf(
  board: Board,
  id: string,
  w0 = TODAY_WEEK - 2,
  planned = null as null | { id: string; project_id: string },
) {
  const info = board.P.scopeInfo(id)
  if (!info) throw new Error(`no scope ${id}`)
  const request = roadmapRequest(info, ROW, { w0, w1: w0 + 8 }, planned)
  if (request.kind !== 'ask') throw new Error('asks nothing')
  return request
}

/** Registers the Roadmap's read for `key` as its view does, keeping the
    held answer where the view would. */
const watch = (board: Board, key: string | null, attempt = 0) =>
  act(async () => {
    const held = board.P.roadmapRead()
    const keep =
      key !== null && held.key !== null && held.value?.state === 'ok' && keepsRoadmap(held.key, key)
    board.P.watchRoadmap(key, attempt, 1, keep)
  })

describe("the store's Roadmap reads", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("brings the answer's rows into the views' rows, never the workspace's", async () => {
    const board = await loadBoard(network, two)
    const one = board.snapshot.projects[0].id
    await watch(board, keyOf(board, one).key)
    const read = board.P.roadmapRead()
    expect(read.current).toBe(true)
    expect(read.value?.state).toBe('ok')
    expect(board.P.viewTask('roadmap', 'a')?.key).toBe('QN-1')
    expect(board.P.handleOf('a')).toBeNull()
    expect(board.P.tasksHeld()).toBe(false)
  })

  it('keeps the held answer for a new window or planned task until its own answer, and drops it for another scope', async () => {
    const board = await loadBoard(network, two)
    const one = board.snapshot.projects[0].id
    const first = keyOf(board, one).key
    await watch(board, first)
    board.server.roadmap.hold = true
    // a pan: the last answer and its rows stay, not current
    const panned = keyOf(board, one, TODAY_WEEK + 1).key
    await watch(board, panned)
    let read = board.P.roadmapRead()
    expect(read.key).toBe(first)
    expect(read.current).toBe(false)
    expect(board.P.viewTask('roadmap', 'a')).toBeDefined()
    // a planned task the same way
    const planned = keyOf(board, one, TODAY_WEEK + 1, { id: 'a', project_id: one }).key
    await watch(board, planned)
    expect(board.P.roadmapRead().key).toBe(first)
    await act(async () => board.answer())
    read = board.P.roadmapRead()
    expect(read.key).toBe(planned)
    expect(read.current).toBe(true)
    // another scope: what the read held goes, so the other project's rows
    // never show as this one's. App names the new scope with the project
    // cache and mounts the Roadmap once it answers, so the read has its
    // organization
    board.P.nameProjects('the scope', ['two'])
    await vi.waitFor(() => expect(board.P.projectState('two')).toBe('ok'))
    await watch(board, keyOf(board, 'two').key)
    read = board.P.roadmapRead()
    expect(read.key).toBeNull()
    expect(board.P.viewTask('roadmap', 'a')).toBeUndefined()
    await act(async () => board.answer())
    expect(board.P.viewTask('roadmap', 'b')).toBeDefined()
    expect(board.P.viewTask('roadmap', 'a')).toBeUndefined()
  })

  it('asks the dependency read once for a scope, whatever the window, and forgets both reads and their owners on release', async () => {
    const board = await loadBoard(network, two)
    const one = board.snapshot.projects[0].id
    const first = keyOf(board, one)
    await act(async () => board.P.watchRoadmapDependencies(first.deps, 0, 1))
    await watch(board, first.key)
    await watch(board, keyOf(board, one, TODAY_WEEK + 3).key)
    const asked = board.server.roadmap.asked.filter((s) => s.name === 'tasks:roadmapDependencies')
    expect(asked).toHaveLength(1)
    expect(board.P.roadmapDependenciesRead().value?.state).toBe('ok')
    const me = board.snapshot.profiles[0]
    await act(async () => {
      board.P.watchRoadmapTeam([{ org: me.org_id, owner: me.id, cards: 1 }])
      board.P.watchPlanLoad({ org: me.org_id, owner: me.id })
    })
    expect(board.server.loads.size).toBeGreaterThan(0)
    expect(board.P.ownerLoad(me.org_id, me.id).state).toBe('ok')
    await act(async () => board.P.releaseRoadmap())
    expect(board.P.roadmapRead().key).toBeNull()
    expect(board.P.roadmapDependenciesRead().key).toBeNull()
    expect(board.P.viewTask('roadmap', 'a')).toBeUndefined()
    expect(board.server.roadmap.open.size).toBe(0)
    expect(board.server.loads.size).toBe(0)
  })

  it("holds no subscription while the page is hidden, Team's and the panel's owners included", async () => {
    const board = await loadBoard(network, two)
    const one = board.snapshot.projects[0].id
    const me = board.snapshot.profiles[0]
    await watch(board, keyOf(board, one).key)
    await act(async () => {
      board.P.watchRoadmapTeam([{ org: me.org_id, owner: me.id, cards: 1 }])
      board.P.watchPlanLoad({ org: me.org_id, owner: me.id })
    })
    expect(board.server.loads.size).toBeGreaterThan(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    // the view's effect passes null while hidden
    await watch(board, null)
    expect(board.server.roadmap.open.size).toBe(0)
    expect(board.server.loads.size).toBe(0)
    // their last answers stay
    expect(board.P.ownerLoad(me.org_id, me.id).state).toBe('ok')
    expect(board.P.roadmapRead().value?.state).toBe('ok')
  })

  it('asks afresh on Try again, dropping what it held', async () => {
    const board = await loadBoard(network, two)
    const key = keyOf(board, board.snapshot.projects[0].id).key
    await watch(board, key)
    board.server.roadmap.hold = true
    await watch(board, key, 1)
    expect(board.P.roadmapRead().key).toBeNull()
    expect(board.P.viewTask('roadmap', 'a')).toBeUndefined()
    await act(async () => board.answer())
    expect(board.P.roadmapRead().current).toBe(true)
  })
})
