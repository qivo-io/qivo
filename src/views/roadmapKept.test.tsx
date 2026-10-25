// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeptView } from '../components/KeptView'
import { withoutTaken } from '../lib/reveal'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* A kept Roadmap (components/KeptView) shown again runs its effects again
   with the props it held: a request to plan or show a task that it took
   before it hid must not start again, nor take a newer request with it.
   And it does not hold the phone's layers for its return. */

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
  // jsdom has no element scrolling
  Element.prototype.scrollTo = () => {}
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

/** A phone breakpoint that matches while `phone.on`, and tells its
    listeners when `phone.set` changes it. */
function phoneScreen() {
  const listeners = new Set<() => void>()
  const phone = {
    on: true,
    set: (on: boolean) => {
      phone.on = on
      for (const listener of listeners) listener()
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return phone.on
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })),
  )
  return phone
}

describe('a kept Roadmap shown again', { timeout: BOARD_TEST_TIMEOUT * 2 }, () => {
  it.each([
    ['on the phone, on its agenda', true],
    ['on a desktop-wide screen, as the desktop timeline', false],
  ])('shows itself %s after it hid with the landscape timeline open', async (_, phoneAgain) => {
    const phone = phoneScreen()
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 't1', 'todo', 1))
    })
    const { Roadmap } = await import('./Roadmap')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    const render = (shown: boolean) =>
      board.renderView(root, (info) => (
        <KeptView view="roadmap" shown={shown} className="view">
          <Roadmap
            info={info}
            filters={FILTERS}
            actions={actions}
            filterControls={() => null}
            focusPlan={null}
          />
        </KeptView>
      ))
    const agenda = () => document.querySelector('.mobile-roadmap-open-timeline button')
    const landscape = () => document.querySelector('[data-landscape-back]')
    await render(true)
    await act(async () => agenda()?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(landscape()).not.toBeNull()
    await render(false)
    await act(async () => phone.set(phoneAgain))
    await render(true)
    while (tasks.length) await act(async () => tasks.shift()?.())
    expect(landscape()).toBeNull()
    expect(agenda() !== null).toBe(phoneAgain)
  })

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
  it('leaves the request made while it hid, as it lets go of the one it held', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push({ ...taskRow(snap, 't1', 'todo', 1), assignee_id: null })
      snap.issues.push({ ...taskRow(snap, 't2', 'todo', 2), assignee_id: null })
    })
    const { Roadmap } = await import('./Roadmap')
    const actions = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof Roadmap
    >[0]['actions']
    const idOf = (uuid: string) => board.P.issues.find((it) => it.uuid === uuid)?.id ?? ''
    type Plan = { id: string; n: number } | null
    // App's request, and its Plan on roadmap
    let pending: Plan = null
    let ask = (_: Plan) => {}
    function Page({
      shown,
      info,
    }: {
      shown: boolean
      info: Parameters<typeof Roadmap>[0]['info']
    }) {
      const [plan, setPlan] = useState<Plan>({ id: idOf('t1'), n: 1 })
      useEffect(() => {
        pending = plan
        ask = setPlan
      })
      return (
        <KeptView view="roadmap" shown={shown} className="view">
          <Roadmap
            info={info}
            filters={FILTERS}
            actions={actions}
            filterControls={() => null}
            focusPlan={plan}
            onFocusConsumed={(n) => setPlan(withoutTaken(n))}
          />
        </KeptView>
      )
    }
    const render = (shown: boolean) =>
      board.renderView(root, (info) => <Page shown={shown} info={info} />)
    board.P.roadmapContext(true, false)
    await render(true)
    expect(document.querySelector(`[data-plan-card="${idOf('t1')}"]`)).not.toBeNull()
    // the person leaves before the request is consumed, and asks to plan
    // another task while the Roadmap is hidden
    await render(false)
    tasks.length = 0
    await act(async () => ask({ id: idOf('t2'), n: 2 }))
    await render(true)
    while (tasks.length) await act(async () => tasks.shift()?.())
    expect(document.querySelector(`[data-plan-card="${idOf('t2')}"]`)).not.toBeNull()
    expect(pending).toBeNull()
  })
})
