// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* Opening the Board on the real store renders it once. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('opening the Board', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('renders it once', async () => {
    const board = await loadBoard(network, (snap) => {
      for (let n = 0; n < 50; n++)
        snap.issues.push(taskRow(snap, `t${n}`, n % 2 ? 'todo' : 'progress', n + 1))
    })
    // the Board asks for the scope's tasks once per render
    const scoped = vi.spyOn(board.P, 'scopedIssues')
    await board.render(root)
    expect(document.querySelectorAll('[data-card]')).toHaveLength(50)
    expect(scoped).toHaveBeenCalledTimes(1)
  })
})
