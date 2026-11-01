// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* While a large workspace still loads its tasks (store/liveParts.ts), the
   Board shows every task its answer names, from the answer's rows where the
   workspace has not brought them yet (store/viewRows.ts), with its counts.
   Before the answer it shows the tasks that arrived, with no count and no
   empty state, which would present part of the selection as all of it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
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
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const count = (status: string) =>
  document.querySelector(`[data-status-count="${status}"]`)?.textContent

describe('the Board while tasks still load', () => {
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
      expect(board.P.stillLoading()).not.toBeNull()
      expect(board.card('01000000-a')).not.toBeNull()
      // b's task window has not arrived; its card is the answer's row
      expect(board.P.handleOf('fd000000-b')).toBeNull()
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(count('progress')).toBe('1')
      expect(count('todo')).toBe('1')
      // the workspace brings it, and the card stays, now the store's own
      await act(async () => double.live?.holdWindow(null))
      expect(board.P.handleOf('fd000000-b')).not.toBeNull()
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(count('todo')).toBe('1')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says nothing loads where its answer names a task no window brought yet',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(taskRow(snapshot, 'fd000000-b', 'todo', 1))
      })
      await board.render(root)
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(container.textContent).not.toContain('Loading tasks…')
      expect(container.textContent).not.toContain('No tasks yet')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says it still loads where the answer names no task for a filter yet',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(taskRow(snapshot, 'fd000000-b', 'todo', 1))
      })
      await board.render(root)
      // the server holds no urgent task, so its answer names none
      await board.filter({ priority: 'urgent' })
      expect(container.querySelector('[data-board-root]')?.getAttribute('data-board-state')).toBe(
        'ok',
      )
      expect(container.textContent).toContain('Loading tasks…')
      expect(container.textContent).not.toContain('No tasks yet')
      await act(async () => double.live?.holdWindow(null))
      expect(container.textContent).not.toContain('Loading tasks…')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'mounts its first screen at once and the rest in slices while the workspace loads',
    async () => {
      // more cards than the Board mounts at once (SYNC_LIMIT), all in the
      // first task window but one
      const ids = Array.from({ length: 320 }, (_, i) => `01${i.toString(16).padStart(6, '0')}-x`)
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(
          ...ids.map((id, i) => taskRow(snapshot, id, 'progress', i + 1)),
          taskRow(snapshot, 'fd000000-b', 'progress', 321),
        )
      })
      await board.render(root)
      const cards = () => container.querySelectorAll('[data-card]').length
      const first = cards()
      expect(first).toBeGreaterThan(0)
      expect(first).toBeLessThan(320)
      // the answer's cards are all there, so slices do not wait for the
      // workspace: every card mounts while its last window is held
      await vi.waitFor(() => expect(cards()).toBe(321), { timeout: 10_000 })
      expect(board.P.stillLoading()).not.toBeNull()
    },
    BOARD_TEST_TIMEOUT,
  )
})
