// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from '../views/boardFixture.setup'
import { roadmapRequest } from '../views/roadmap/roadmapArgs'
import type { IssueFilters } from './planner'
import type { Snapshot } from './plannerFixture.setup'

/* The Roadmap's writes of tasks the workspace does not hold, as the app
   sends them before it asks for every task (store/planner.ts
   updateViewTask, moveDependencyTask, recordRoadmapChange): a shaped
   task's dates join the visit's journal with its row on screen as the
   expected values, painted on the Roadmap's rows until the answer holds
   them; a task only the dependency answer holds moves from its stored
   dates and paints nothing; a batch is one write and one layer, which a
   refusal takes away whole; with no visit to record them they go out as
   ordinary writes. */

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

/** One sub-project with a, a task this week, g, a group whose subtask g1
    is next week, and far, a task of another sub-project the Roadmap does
    not show, which a blocks link from a ties into a's part. */
const tasks = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'other', key: 'OTH', num: 2, name: 'Other' })
  snap.issues.push(
    { ...taskRow(snap, 'a', 'todo', 1), start_week: week(0), end_week: week(0) },
    { ...taskRow(snap, 'g', 'todo', 2) },
    { ...taskRow(snap, 'g1', 'todo', 3), parent_id: 'g', start_week: week(1), end_week: week(1) },
    {
      ...taskRow(snap, 'far', 'todo', 4),
      project_id: 'other',
      start_week: week(0),
      end_week: week(0),
    },
  )
}

type Board = Awaited<ReturnType<typeof loadBoard>>

/** The board's store with the Roadmap's read open on its scope and a visit
    recording, and the writes it sends, by name and arguments. */
async function roadmapOf(board: Board, visit = true) {
  const { P } = board
  const info = P.scopeInfo(board.snapshot.projects[0].id)
  if (!info) throw new Error('no scope')
  const request = roadmapRequest(info, ROW, { w0: TODAY_WEEK - 2, w1: TODAY_WEEK + 6 }, null)
  if (request.kind !== 'ask') throw new Error('asks nothing')
  P.roadmapContext(visit, false)
  await act(async () => P.watchRoadmap(request.key, 0, 1))
  return {
    sent: () =>
      network.mutation.mock.calls
        .map(([ref, args]) => ({ name: getFunctionName(ref), args }))
        .filter((w) => w.name !== 'identity:claimMySeats'),
    model: (uuid: string) => P.viewTask('roadmap', uuid),
  }
}

/** Answers the next write `name` with `answer`, or refuses it with `error`. */
function answerNext(name: string, answer: unknown, error?: unknown) {
  network.mutation.mockImplementationOnce((ref) =>
    getFunctionName(ref) === name
      ? error
        ? Promise.reject(error)
        : Promise.resolve(answer)
      : new Promise(() => {}),
  )
}

describe("the Roadmap's writes of tasks it does not hold", { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("joins a shaped task's dates to the journal with its row as expected values, and holds the paint until the answer does", async () => {
    const board = await loadBoard(network, tasks)
    const r = await roadmapOf(board)
    const a = r.model('a')
    if (!a) throw new Error('no model of a')
    answerNext('roadmap:change', { count: 1 })
    let saved: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      saved = board.P.updateIssue(a.id, { start: TODAY_WEEK + 2, end: TODAY_WEEK + 3 })
    })
    expect(r.sent()).toEqual([
      {
        name: 'roadmap:change',
        args: {
          session_id: expect.any(String),
          operations: [
            {
              kind: 'task',
              id: 'a',
              patch: { start_week: week(2), end_week: week(3) },
              expected: { start_week: week(0), end_week: week(0) },
            },
          ],
        },
      },
    ])
    expect(r.model('a')?.start).toBe(TODAY_WEEK + 2)
    expect(await saved).toBe(true)
    // accepted: the paint stays until a delivery of the Roadmap's read holds it
    expect(board.probe?.layerCount()).toBe(1)
    expect(board.P.roadmapUndo.count).toBe(1)
    Object.assign(board.snapshot.issues.find((t) => t.id === 'a') ?? {}, {
      start_week: week(2),
      end_week: week(3),
    })
    await board.deliver()
    expect(board.probe?.layerCount()).toBe(0)
    expect(r.model('a')?.start).toBe(TODAY_WEEK + 2)
  })

  it("takes a refused write's paint away, drops a group's dates, and sends an ordinary write with no visit", async () => {
    const board = await loadBoard(network, tasks)
    const r = await roadmapOf(board)
    const a = r.model('a')
    const g = r.model('g')
    if (!a || !g) throw new Error('no models')
    answerNext('roadmap:change', null, new ConvexError({ code: 'conflict', message: 'Changed.' }))
    await act(async () => {
      await board.P.updateIssue(a.id, { start: TODAY_WEEK + 2, end: TODAY_WEEK + 2 })
    })
    expect(r.model('a')?.start).toBe(TODAY_WEEK)
    expect(board.probe?.layerCount()).toBe(0)
    // a group's dates come from its subtasks: nothing goes out
    network.mutation.mockClear()
    expect(await board.P.updateIssue(g.id, { start: TODAY_WEEK + 4, end: TODAY_WEEK + 5 })).toBe(
      true,
    )
    expect(r.sent()).toEqual([])
    // with no visit recording, the dates go as an ordinary write, still
    // with the row's dates as expected values
    board.P.roadmapContext(false, false)
    await act(async () => {
      void board.P.updateIssue(a.id, { start: TODAY_WEEK + 1, end: TODAY_WEEK + 1 })
    })
    expect(r.sent()).toEqual([
      {
        name: 'issues:update',
        args: {
          org_id: board.snapshot.orgs[0].id,
          id: 'a',
          patch: { start_week: week(1), end_week: week(1) },
          expected: { start_week: week(0), end_week: week(0) },
        },
      },
    ])
  })

  it('sends one batch with a shaped task and a task only the dependency answer holds, one layer that stays painted and goes whole on a refusal', async () => {
    const board = await loadBoard(network, tasks)
    const r = await roadmapOf(board)
    const a = r.model('a')
    if (!a) throw new Error('no model of a')
    const farRow = {
      id: 'far',
      org_id: board.snapshot.orgs[0].id,
      project_id: 'other',
      num: 4,
      status: 'todo' as const,
      start_week: week(0),
      end_week: week(0),
      has_subtasks: false,
    }
    network.mutation.mockClear()
    // the write waits
    await act(async () => {
      void board.P.batchRoadmapChanges(() => {
        void board.P.updateIssue(a.id, { start: TODAY_WEEK + 1, end: TODAY_WEEK + 1 })
        void board.P.moveDependencyTask(farRow, TODAY_WEEK + 2, TODAY_WEEK + 2)
      })
    })
    const sent = r.sent()
    expect(sent).toHaveLength(1)
    const [write] = sent
    if (!write) throw new Error('no write')
    expect(write.name).toBe('roadmap:change')
    expect((write.args as { operations: unknown[] }).operations).toEqual([
      {
        kind: 'task',
        id: 'a',
        patch: { start_week: week(1), end_week: week(1) },
        expected: { start_week: week(0), end_week: week(0) },
      },
      {
        kind: 'task',
        id: 'far',
        patch: { start_week: week(2), end_week: week(2) },
        expected: { start_week: week(0), end_week: week(0) },
      },
    ])
    // one layer for the batch, its view paint kept, which a batch that
    // folded only workspace paints would drop
    expect(board.probe?.layerCount()).toBe(1)
    expect(r.model('a')?.start).toBe(TODAY_WEEK + 1)
    expect(board.P.roadmapUndo.busy).toBe(true)
  })

  it('takes a refused batch away whole, and settles an accepted one while a stopped Board keeps its rows', async () => {
    const board = await loadBoard(network, tasks)
    // a Board that read the same task and stopped, its rows kept
    const { boardRequest } = await import('../views/board/boardArgs')
    const info = board.P.scopeInfo(board.snapshot.projects[0].id)
    if (!info) throw new Error('no scope')
    const boardKey = boardRequest(info, ROW, '2020-01-01T00:00:00.000Z')
    if (boardKey.kind !== 'ask') throw new Error('asks nothing')
    await act(async () => board.P.watchBoard('board:desktop', boardKey.key, 0, 9))
    await act(async () => board.P.watchBoard('board:desktop', null, 0, 9))
    const r = await roadmapOf(board)
    const a = r.model('a')
    const g1 = r.model('g1')
    if (!a || !g1) throw new Error('no models')
    // two shaped tasks, so the batch's one layer folds two view paints
    const move = (to: number) =>
      act(async () =>
        board.P.batchRoadmapChanges(() => {
          void board.P.updateIssue(a.id, { start: TODAY_WEEK + to, end: TODAY_WEEK + to })
          void board.P.updateIssue(g1.id, { start: TODAY_WEEK + to, end: TODAY_WEEK + to })
        }),
      )
    answerNext('roadmap:change', null, new ConvexError({ code: 'conflict', message: 'Changed.' }))
    await move(3)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(r.model('a')?.start).toBe(TODAY_WEEK)
    expect(board.probe?.layerCount()).toBe(0)
    // accepted, then the Roadmap's read delivers it: no layer is left, though
    // the stopped Board's kept rows never hold it
    answerNext('roadmap:change', { count: 1 })
    await move(2)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    for (const id of ['a', 'g1'])
      Object.assign(board.snapshot.issues.find((t) => t.id === id) ?? {}, {
        start_week: week(2),
        end_week: week(2),
      })
    await board.deliver()
    // a folded paint that named no task would wait for the stopped Board
    expect(board.probe?.layerCount()).toBe(0)
    expect(board.P.roadmapUndo.busy).toBe(false)
  })
})
