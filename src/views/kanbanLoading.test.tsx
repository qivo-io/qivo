// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* While every task loads for a page that asked for them (store/liveParts.ts,
   store/planner.ts P.askTasks), the Board shows every task its answer
   names, from the answer's rows where the workspace does not hold them
   (store/viewRows.ts), with its counts, as it does before any ask. A new
   subtask the workspace holds whose parent only the answer brings keeps
   the desktop Board loading until the load ends, and never before an ask
   or after a load that stopped. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('../store/guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('../store/guard/liveDouble.setup')
  double.live ??= liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
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
  await import('../lib/convex')
  double.live?.holdWindow(LAST_WINDOW)
})

afterEach(async () => {
  double.live?.holdWindow(null)
  double.live?.failWindow(null)
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const count = (status: string) =>
  document.querySelector(`[data-status-count="${status}"]`)?.textContent
const state = () => container.querySelector('[data-board-root]')?.getAttribute('data-board-state')
const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

/** Asks for every task, as a page that needs them does, with the last task
    window held, so they are still on their way. */
async function askHeld(P: { askTasks(reason: 'script'): void; tasksArriving(): boolean }) {
  await act(async () => P.askTasks('script'))
  await tick()
  expect(P.tasksArriving()).toBe(true)
}

describe('the Board while every task loads', () => {
  it(
    'shows every task its answer names, with its counts, before the workspace brings them',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(
          taskRow(snapshot, '01000000-a', 'progress', 1),
          taskRow(snapshot, 'fd000000-b', 'todo', 2),
        )
      })
      await board.render(root)
      await askHeld(board.P)
      // no task is held while the windows arrive; the cards are the rows
      expect(board.P.handleOf('01000000-a')).toBeNull()
      expect(board.card('01000000-a')).not.toBeNull()
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(count('progress')).toBe('1')
      expect(count('todo')).toBe('1')
      // every task arrives, and the cards stay, now the store's own
      await act(async () => double.live?.holdWindow(null))
      await tick()
      expect(board.P.tasksHeld()).toBe(true)
      expect(board.P.handleOf('fd000000-b')).not.toBeNull()
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(count('todo')).toBe('1')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says nothing loads where its answer names a task the workspace does not hold',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(taskRow(snapshot, 'fd000000-b', 'todo', 1))
      })
      await board.render(root)
      await askHeld(board.P)
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(container.textContent).not.toContain('Loading tasks…')
      expect(container.textContent).not.toContain('No tasks yet')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says nothing matches once the answer for a filter names no task, also while every task loads',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(taskRow(snapshot, 'fd000000-b', 'todo', 1))
      })
      await board.render(root)
      await askHeld(board.P)
      // the server holds no urgent task, so its answer names none
      await board.filter({ priority: 'urgent' })
      expect(state()).toBe('ok')
      expect(container.textContent).toContain('Nothing matches your filters')
      expect(container.textContent).not.toContain('Loading tasks…')
      expect(container.textContent).not.toContain('No tasks yet')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'mounts its first screen at once and the rest in slices',
    async () => {
      // more cards than the Board mounts at once (SYNC_LIMIT), 107 in each
      // of three sub-projects of Plan, under the design size of one
      const ids = Array.from({ length: 320 }, (_, i) => `01${i.toString(16).padStart(6, '0')}-x`)
      const board = await loadBoard(
        network,
        (snapshot) => {
          snapshot.orgs[0].next_issue_num = 64 * 200
          const base = snapshot.projects[0]
          snapshot.projects.push({
            ...base,
            id: 'plan',
            type: 'meta',
            key: 'PLAN',
            num: 2,
            name: 'Plan',
          })
          Object.assign(base, { parent_id: 'plan', name: 'One' })
          snapshot.projects.push(
            { ...base, id: 'two', key: 'TWO', num: 3, name: 'Two' },
            { ...base, id: 'three', key: 'THR', num: 4, name: 'Three' },
          )
          const projects = [base.id, 'two', 'three']
          snapshot.issues.push(
            ...ids.map((id, i) => ({
              ...taskRow(snapshot, id, 'progress', i + 1),
              project_id: projects[i % 3],
            })),
            { ...taskRow(snapshot, 'fd000000-b', 'progress', 321), project_id: 'three' },
          )
        },
        { scope: 'plan' },
      )
      board.server.hold = true
      await board.render(root)
      // the frame holds no card, and the first answer's render mounts the
      // first screen, not the frame's none
      expect(container.querySelectorAll('[data-card]').length).toBe(0)
      await board.answer()
      const cards = () => container.querySelectorAll('[data-card]').length
      const first = cards()
      expect(first).toBeGreaterThan(0)
      expect(first).toBeLessThan(321)
      await vi.waitFor(() => expect(cards()).toBe(321), { timeout: 10_000 })
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'keeps the desktop Board loading for a new subtask whose parent only the answer brings, only while every task arrives',
    async () => {
      const { STALL } = await import('../store/liveParts')
      const stall = STALL.ms
      STALL.ms = 40
      try {
        const board = await loadBoard(network, (snapshot) => {
          snapshot.orgs[0].next_issue_num = 64 * 200
          // a parent in the last task window, which is held
          snapshot.issues.push(taskRow(snapshot, 'fd000000-p', 'progress', 1))
        })
        // the person's new subtask of it, which the workspace holds, and
        // the server's row of it, which the Board's answer brings
        const kid = {
          ...taskRow(board.snapshot, '01ffffff-k', 'progress', 2),
          parent_id: 'fd000000-p',
        }
        board.snapshot.issues.push(kid)
        await act(async () => board.probe?.plantTasks([kid]))
        await board.render(root)
        await board.answer()
        // before an ask no Board waits for it, and it stays ok past the bound
        expect(board.P.handleOf('01ffffff-k')).not.toBeNull()
        await tick()
        expect(state()).toBe('ok')
        await act(async () => new Promise((resolve) => setTimeout(resolve, 80)))
        expect(state()).toBe('ok')
        // while every task arrives the Board waits for the parent's heading
        await askHeld(board.P)
        await board.answer()
        expect(state()).toBe('loading')
        await act(async () => new Promise((resolve) => setTimeout(resolve, 80)))
        expect(state()).toBe('loading')
        // a load that stops ends the wait, with no incomplete over it
        await act(async () => double.live?.failWindow(LAST_WINDOW, new Error('boom')))
        await act(async () => double.live?.holdWindow(null))
        await tick()
        expect(board.P.taskLoad().state).toBe('failed')
        await board.answer()
        await act(async () => new Promise((resolve) => setTimeout(resolve, 80)))
        expect(state()).toBe('ok')
        expect(container.querySelector('[data-board-incomplete]')).toBeNull()
      } finally {
        STALL.ms = stall
      }
    },
    BOARD_TEST_TIMEOUT,
  )
})
