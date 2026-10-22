// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_MS } from '../lib/reveal'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A jump to the Board (Team sync, the Inbox, the task crumb, search)
   scrolls the task's card into the middle of the Board and rings it for a
   moment, mounting the card first when its cell still waits to mount it. */

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
// frames and slices, which the tests run themselves
let queue: (() => void)[]
let scrolled: ReturnType<typeof vi.fn>
// the task whose card the layout puts far down the Board
let far = ''

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
  queue = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close: () => void } = {
        onmessage: null,
        close: () => {},
      }
      port2 = { postMessage: () => queue.push(() => this.port1.onmessage?.()) }
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    queue.push(() => callback(performance.now())),
  )
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('innerHeight', 400)
  // jsdom lays nothing out: the far card sits 5,000px down an 800px pane
  scrolled = vi.fn()
  // jsdom has no element scrollTo
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrolled })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20_000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const holds =
      !!far && (this.dataset.card === far || !!this.querySelector(`[data-card="${far}"]`))
    // the panes that scroll, the Board's and the phone list's, stay put
    const top = holds && !this.matches('[data-scroll], .mobile-task-list') ? 5000 : 0
    return { top, bottom: top + 100, left: 0, right: 200, height: 100, width: 200 } as DOMRect
  })
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  far = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  vi.unstubAllGlobals()
})

/** Runs the queued frames and slices, until `done` or none are left. */
const run = async (done = () => false) => {
  while (queue.length && !done()) await act(async () => queue.shift()?.())
}
const card = (id: string) => document.querySelector<HTMLElement>(`[data-card="${id}"]`)

/* Plan, a parent project, over ten sub-projects of 100 To Do tasks each:
   one swimlane per sub-project, and more cards than the Board mounts at
   once. Task 900 is the last card of lane 9. */
const lanes = (snap: Snapshot) => {
  const base = snap.projects[0]
  snap.projects.push({ ...base, id: 'plan', type: 'meta', key: 'PLAN', num: 2, name: 'Plan' })
  for (let lane = 1; lane <= 10; lane++) {
    const id = lane === 1 ? base.id : `sub${lane}`
    if (lane === 1) Object.assign(base, { parent_id: 'plan', name: 'Lane 01' })
    else
      snap.projects.push({
        ...base,
        id,
        key: `L${lane}`,
        num: lane + 2,
        name: `Lane ${String(lane).padStart(2, '0')}`,
        parent_id: 'plan',
      })
    for (let n = 1; n <= 100; n++) {
      const num = (lane - 1) * 100 + n
      snap.issues.push({ ...taskRow(snap, `t${num}`, 'todo', num), project_id: id })
    }
  }
}

describe('a jump to the Board', { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it('scrolls a Team sync jump to task 900 in lane 9 into view and rings its card', async () => {
    const board = await loadBoard(network, lanes, { scope: 'plan' })
    await board.render(root)
    const id = board.P.issues.find((it) => it.uuid === 't900')?.id ?? ''
    expect(card(id)).toBeNull()
    far = id
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await board.reveal(id)
    // the reveal's two frames, before the rest of the Board mounts
    await run(() => scrolled.mock.calls.length > 0)
    const target = card(id)?.closest('.board-card')
    expect(target?.hasAttribute('data-board-revealed')).toBe(true)
    // 5,000px down, put in the middle of the 800px pane, at once as it is far
    expect(scrolled).toHaveBeenCalledWith({ top: 5000 + 50 - 400, left: 0, behavior: 'instant' })
    expect(document.querySelector('[data-scroll]')?.getAttribute('data-board-mount')).toBe(
      'pending',
    )
    await act(async () => vi.advanceTimersByTime(REVEAL_MS))
    expect(target?.hasAttribute('data-board-revealed')).toBe(false)
  })

  it('rings the row on the phone task list', async () => {
    const board = await loadBoard(network, lanes, { scope: 'plan', phone: true })
    await board.render(root)
    const id = board.P.issues.find((it) => it.uuid === 't900')?.id ?? ''
    far = id
    await board.reveal(id)
    await run(() => scrolled.mock.calls.length > 0)
    expect(card(id)?.hasAttribute('data-board-revealed')).toBe(true)
    expect(scrolled).toHaveBeenCalledWith({ top: 5000 + 50 - 400, left: 0, behavior: 'instant' })
  })

  it('scrolls a near card smoothly and rings only its row in a shared card', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(
        taskRow(snap, 'parent', 'todo', 1),
        { ...taskRow(snap, 'a', 'todo', 2), parent_id: 'parent' },
        { ...taskRow(snap, 'b', 'todo', 3), parent_id: 'parent' },
      )
    })
    await board.render(root)
    const id = board.P.issues.find((it) => it.uuid === 'b')?.id ?? ''
    await board.reveal(id)
    await run(() => scrolled.mock.calls.length > 0)
    expect(card(id)?.hasAttribute('data-board-revealed')).toBe(true)
    expect(card(id)?.closest('.board-card')?.hasAttribute('data-board-revealed')).toBe(false)
    expect(scrolled).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'smooth' })
  })

  it('shows nothing for a task a filter hides', async () => {
    const board = await loadBoard(network, lanes, { scope: 'plan' })
    await board.render(root)
    const id = board.P.issues.find((it) => it.uuid === 't900')?.id ?? ''
    await board.search('Task t1')
    await board.reveal(id)
    await run()
    expect(card(id)).toBeNull()
    expect(scrolled).not.toHaveBeenCalled()
    expect(document.querySelector('[data-board-revealed]')).toBeNull()
  })
})
