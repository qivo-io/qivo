// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* While a large workspace still loads its tasks (store/liveParts.ts), the
   Board shows the tasks that arrived, but no count and no empty state, which
   would present part of the answer as all of it. */

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
    'shows the tasks that arrived with no count, and its counts once every task did',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(
          taskRow(snapshot, '01000000-a', 'progress', 1),
          taskRow(snapshot, 'fd000000-b', 'todo', 2),
        )
      })
      await board.render(root)
      expect(board.card('01000000-a')).not.toBeNull()
      expect(count('progress')).toBe('…')
      expect(count('todo')).toBe('…')
      await act(async () => double.live?.holdWindow(null))
      expect(board.card('fd000000-b')).not.toBeNull()
      expect(count('progress')).toBe('1')
      expect(count('todo')).toBe('1')
    },
    BOARD_TEST_TIMEOUT,
  )

  it(
    'says it still loads where no task arrived yet, not that there is none',
    async () => {
      const board = await loadBoard(network, (snapshot) => {
        snapshot.orgs[0].next_issue_num = 64 * 200
        snapshot.issues.push(taskRow(snapshot, 'fd000000-b', 'todo', 1))
      })
      await board.render(root)
      expect(container.textContent).toContain('Loading tasks…')
      expect(container.textContent).not.toContain('No tasks yet')
      await act(async () => double.live?.holdWindow(null))
      expect(board.card('fd000000-b')).not.toBeNull()
    },
    BOARD_TEST_TIMEOUT,
  )
})
