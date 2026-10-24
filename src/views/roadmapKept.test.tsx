// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeptView } from '../components/KeptView'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A kept Roadmap (components/KeptView) shown again runs its effects again
   with the props it held: a request to plan or show a task that it took
   before it hid must not start again. */

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
// frames and posted tasks, run only when a test says so
let tasks: (() => void)[]

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
  tasks = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close: () => void } = {
        onmessage: null,
        close: () => {},
      }
      port2 = { postMessage: () => tasks.push(() => this.port1.onmessage?.()) }
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    tasks.push(() => callback(performance.now())),
  )
  vi.stubGlobal('cancelAnimationFrame', () => {})
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

const FILTERS = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}

describe('a kept Roadmap shown again', { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it('does not plan again a task it took to plan before it hid', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push({ ...taskRow(snap, 't1', 'todo', 1), assignee_id: null })
    })
    const { Roadmap } = await import('./Roadmap')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    const id = board.P.issues.find((it) => it.uuid === 't1')?.id ?? ''
    const consumed = vi.fn()
    const plan = { id, n: 1 }
    const render = (shown: boolean) =>
      board.renderView(root, (info) => (
        <KeptView view="roadmap" shown={shown} className="view">
          <Roadmap
            info={info}
            filters={FILTERS}
            actions={actions}
            filterControls={() => null}
            focusPlan={plan}
            onFocusConsumed={consumed}
          />
        </KeptView>
      ))
    // App's Roadmap context, which lets the Roadmap plan and undo
    board.P.roadmapContext(true, false)
    await render(true)
    // the planning card opens; the request is consumed two frames later
    expect(document.querySelector(`[data-plan-card="${id}"]`)).not.toBeNull()
    expect(consumed).not.toHaveBeenCalled()
    // the person leaves before those frames: the planning ends with the page
    await render(false)
    tasks.length = 0
    await render(true)
    while (tasks.length) await act(async () => tasks.shift()?.())
    expect(document.querySelector('[data-plan-card]')).toBeNull()
    expect(consumed).toHaveBeenCalledTimes(1)
  })
})
