// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* The Board's first answer over a large selection: the loading frame
   holds no card, and the answer's render mounts the first screen at once
   and the rest in slices (views/Kanban.tsx SYNC_LIMIT). */

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
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("the Board's first answer", () => {
  it(
    'mounts its first screen at once and the rest in slices',
    async () => {
      // more cards than the Board mounts at once (SYNC_LIMIT), 107 in each
      // of three sub-projects of Plan, under the design size of one
      const ids = Array.from({ length: 320 }, (_, i) => `01${i.toString(16).padStart(6, '0')}-x`)
      const board = await loadBoard(
        network,
        (snapshot) => {
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
})
