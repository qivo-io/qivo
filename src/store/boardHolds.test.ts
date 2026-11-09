// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { boardRequest, staleCutoff } from '../views/board/boardArgs'
import { BOARD_TEST_TIMEOUT, loadBoard, spread, taskRow } from '../views/boardFixture.setup'
import { roadmapRequest } from '../views/roadmap/roadmapArgs'
import type { IssueFilters } from './planner'
import type { Snapshot } from './plannerFixture.setup'

/* What the Board holds, as store/viewRows.ts states it: one answer per
   slot and nothing of the other variant's, the answer a narrowing keeps
   only until the new answer arrives, a kept page's own slot, and the
   owner-load cache's answers for the owners the cards need now, through a
   layout change, a filter, typing, a Roadmap visit and My view. The
   store's test probe counts them (P.__layerProbe holders). At everyday
   values: one sub-project of 30 open tasks of three owners. One case
   raises a project's open tasks to the design size and logs, as
   information, the rows and owners held, the answer's size in JSON and
   the heap. */

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
  window.showToast = vi.fn()
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const NO_FILTERS: IssueFilters = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}

/** The two people besides the fixture's who own its tasks. */
const PEOPLE = ['person-0001', 'person-0002']

/** Gives every task of `snap` a span this week, 4 hours left and a due
    date next week in projects that track delay, so each card's delay reads
    its owner's load. */
function planned(snap: Snapshot) {
  for (const p of snap.projects) p.track_delay = true
  for (const task of snap.issues)
    Object.assign(task, {
      start_week: weekToISO(TODAY_WEEK),
      end_week: weekToISO(TODAY_WEEK),
      due_date: weekToISO(TODAY_WEEK + 1),
      remaining_hours: 4,
    })
}

/** The fixture's sub-project with 30 open tasks, t1 to t30, owned in turn
    by the fixture's person and PEOPLE, the high-priority ones (every
    third) by the first of PEOPLE. */
function everyday(snap: Snapshot) {
  for (const [i, id] of PEOPLE.entries())
    snap.profiles.push({
      ...snap.profiles[0],
      id,
      auth_user_id: undefined,
      name: `Person ${i + 1}`,
      org_role: 'user',
    })
  const owners = [snap.profiles[0].id, ...PEOPLE]
  for (let n = 1; n <= 30; n++)
    snap.issues.push({
      ...taskRow(snap, `t${n}`, 'todo', n),
      assignee_id: owners[n % 3],
      priority: n % 3 === 1 ? 'high' : 'medium',
    })
  planned(snap)
}

type Board = Awaited<ReturnType<typeof loadBoard>>

/** What the store holds for the views: rows by slot, and the owners whose
    loads the cache keeps, by id. */
function holders(board: Board) {
  const probe = board.probe
  if (!probe) throw new Error('no test probe')
  const { rows, owners } = probe.holders()
  return {
    rows: Object.fromEntries(rows),
    owners: owners.map((key) => key.split('\u0000')[1]).sort(),
  }
}

/** The tasks the Board's current answer names, rows and parents, once. */
function answered(board: Board) {
  const value = board.P.boardRead('board:desktop').value
  if (value?.state !== 'ok') throw new Error(`the Board's answer is ${value?.state}`)
  return new Set([...value.rows, ...value.parents].map((row) => row.id))
}

/** The owners of the tasks of `ids`, sorted, once each. */
function ownersOf(board: Board, ids: Set<string>) {
  const owners = board.snapshot.issues
    .filter((task) => ids.has(task.id) && task.assignee_id)
    .map((task) => task.assignee_id as string)
  return [...new Set(owners)].sort()
}

/** The Board's request for its scope with no filter, as the Board makes it. */
function boardKey(board: Board) {
  const info = board.P.scopeInfo(board.snapshot.projects[0].id)
  if (!info) throw new Error('no scope')
  const request = boardRequest(info, NO_FILTERS, staleCutoff(Date.now()))
  if (request.kind !== 'ask') throw new Error('asks nothing')
  return request.key
}

describe("the Board's holders", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('holds one answer per slot through a layout change, a filter, typing, a Roadmap visit and My view, and only the owners its cards need', async () => {
    const board = await loadBoard(network, everyday)
    const { P } = board
    // the phone's list held the Board's tasks before the layout crossed
    // to the desktop
    await act(async () => P.watchBoard('board:phone', boardKey(board), 0, 0, false))
    await board.answer()
    expect(holders(board).rows).toEqual({ 'board:phone': 30 })
    // the desktop Board mounts and releases the phone's slot
    await board.render(root)
    await board.answer()
    await vi.waitFor(() => expect(holders(board).owners).toHaveLength(3))
    expect(holders(board)).toEqual({
      rows: { 'board:desktop': answered(board).size },
      owners: ownersOf(board, answered(board)),
    })
    expect(answered(board).size).toBe(30)
    // a filter: the slot holds the new answer alone, and the cache only
    // the owners its cards need
    await board.filter({ priority: 'high' })
    await board.answer()
    expect(answered(board).size).toBe(10)
    await vi.waitFor(() => expect(holders(board).owners).toEqual([PEOPLE[0]]))
    expect(holders(board).rows).toEqual({ 'board:desktop': 10 })
    // typing that only narrows keeps the answer it narrows until the
    // answer for the new text arrives
    await board.filter({ priority: null })
    await board.answer()
    expect(holders(board).rows).toEqual({ 'board:desktop': 30 })
    board.server.hold = true
    await board.search('t1')
    // once typing rests the Board asks for the new text, and its answer
    // waits
    await vi.waitFor(() => expect(board.server.asked.at(-1)?.filters.search).toBe('t1'))
    expect(holders(board).rows).toEqual({ 'board:desktop': 30 })
    board.server.hold = false
    await board.answer()
    // t1 and t10 to t19
    expect(answered(board).size).toBe(11)
    expect(holders(board).rows).toEqual({ 'board:desktop': 11 })
    // a visit to the Roadmap, a kept page, holds its own slot beside the
    // Board's, which keeps what it held
    const info = P.scopeInfo(board.snapshot.projects[0].id)
    if (!info) throw new Error('no scope')
    const win = { w0: TODAY_WEEK - 2, w1: TODAY_WEEK + 6 }
    const roadmap = roadmapRequest(info, NO_FILTERS, win, null)
    if (roadmap.kind !== 'ask') throw new Error('asks nothing')
    await act(async () => P.watchRoadmap(roadmap.key, 0, 1))
    await board.answer()
    expect(holders(board).rows).toEqual({ 'board:desktop': 11, roadmap: 30 })
    // the Roadmap's page goes: its slot goes with it
    await act(async () => P.releaseView('roadmap'))
    expect(holders(board).rows).toEqual({ 'board:desktop': 11 })
    // My view in the desktop Board's place: the slot holds My view's
    // answer alone, the signed-in person's tasks, and the cache only their
    // owner
    const { Kanban } = await import('../views/Kanban')
    const me = board.snapshot.profiles[0].id
    await board.renderView(root, () =>
      createElement(Kanban, {
        info: P.scopeInfo(P.MINE_SCOPE),
        filters: NO_FILTERS,
        tweaks: { metaViz: 'swimlanes' },
        actions: { openIssue: vi.fn() },
      }),
    )
    await board.answer()
    await vi.waitFor(() => expect(answered(board).size).toBe(10))
    await vi.waitFor(() => expect(holders(board).owners).toEqual([me]))
    expect(holders(board)).toEqual({ rows: { 'board:desktop': 10 }, owners: [me] })
    expect(ownersOf(board, answered(board))).toEqual([me])
  })

  it('holds a design-size project’s answer, its rows and parents, and only its cards’ owners', async () => {
    // 807 tasks over three sub-projects, 8 of them Done
    const board = await loadBoard(
      network,
      (snap) => {
        spread(269, (n) => (n % 90 === 0 ? 'done' : 'todo'))(snap)
        planned(snap)
      },
      { scope: 'plan' },
    )
    await board.render(root)
    await board.answer()
    const ids = answered(board)
    expect(ids.size).toBeGreaterThan(799)
    await vi.waitFor(() => expect(holders(board).owners).toHaveLength(1))
    const held = holders(board)
    expect(held).toEqual({
      rows: { 'board:desktop': ids.size },
      owners: ownersOf(board, ids),
    })
    // as information for the closing review's measurement, not a bound
    const value = board.P.boardRead('board:desktop').value
    console.log(
      "The Board's holders at a project's design size:",
      JSON.stringify({
        rows: held.rows['board:desktop'],
        owners: held.owners.length,
        answerBytes: JSON.stringify(value).length,
        heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
      }),
    )
  })
})
