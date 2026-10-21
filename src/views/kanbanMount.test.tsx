// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_CARD_PITCH } from '../lib/boardGroups'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* Opening the Board on the real store renders it once, and a large Board
   mounts its first screen at once and the rest in slices. The slices are
   MessageChannel tasks, which the test runs one at a time. */

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
let slices: (() => void)[]

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
  slices = []
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1: { onmessage: (() => void) | null; close: () => void } = {
        onmessage: null,
        close: () => {},
      }
      port2 = { postMessage: () => slices.push(() => this.port1.onmessage?.()) }
    },
  )
  // the first screen: 400px and 500px more
  vi.stubGlobal('innerHeight', 400)
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

const cards = () => document.querySelectorAll('[data-card]')
const pane = () => document.querySelector('[data-scroll]')
/** Runs the next slice, or every slice left. */
const slice = () => act(async () => slices.shift()?.())
const finish = async () => {
  while (slices.length) await slice()
}
/** The most cards a first screen of 900px holds. */
const EAGER = Math.ceil(900 / MIN_CARD_PITCH)

/** `count` To Do tasks and `progress` In Progress ones. */
const tasks = (count: number, progress = 0) => (snap: Snapshot) => {
  for (let n = 0; n < count; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n + 1))
  for (let n = 0; n < progress; n++)
    snap.issues.push(taskRow(snap, `p${n}`, 'progress', count + n + 1))
}

describe('opening the Board', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it('renders it once', async () => {
    const board = await loadBoard(network, tasks(25, 25))
    // the Board asks for the scope's tasks once per render
    const scoped = vi.spyOn(board.P, 'scopedIssues')
    await board.render(root)
    expect(cards()).toHaveLength(50)
    expect(scoped).toHaveBeenCalledTimes(1)
    expect(pane()?.hasAttribute('data-board-mount')).toBe(false)
  })

  it('mounts the first screen of a large Board, then the rest in slices', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    expect(cards().length).toBeGreaterThan(0)
    expect(cards().length).toBeLessThanOrEqual(EAGER)
    expect(pane()?.getAttribute('data-board-mount')).toBe('pending')
    expect(pane()?.getAttribute('aria-busy')).toBe('true')
    await finish()
    expect(cards()).toHaveLength(500)
    expect(pane()?.getAttribute('data-board-mount')).toBe('complete')
    expect(pane()?.hasAttribute('aria-busy')).toBe(false)
  })

  it('keeps every mounted card node when a task arrives at the top of its cell', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    await slice()
    const before = new Map([...cards()].map((card) => [card.getAttribute('data-card'), card]))
    board.snapshot.issues.push({ ...taskRow(board.snapshot, 'top', 'todo', 900), priority: 'urgent' })
    await board.deliver()
    expect(cards()[0].textContent).toContain('Task top')
    for (const [id, node] of before)
      expect(document.querySelector(`[data-card="${id}"]`)).toBe(node)
  })

  it('moves Tab through the waiting space onto the next card, and Shift+Tab onto the last', async () => {
    const board = await loadBoard(network, tasks(500, 3))
    await board.render(root)
    const todo = () => document.querySelector('[data-board-cell][data-status="todo"]')
    const mounted = todo()?.querySelectorAll('[data-card]').length ?? 0
    const owners = todo()?.querySelectorAll<HTMLElement>('[data-focus-key="owner"]')
    await act(async () => owners?.[owners.length - 1].focus())
    await act(async () => todo()?.querySelector<HTMLElement>('[data-board-pending]')?.focus())
    const titles = todo()?.querySelectorAll('[data-focus-key="title"]')
    expect(titles).toHaveLength(500)
    expect(document.activeElement).toBe(titles?.[mounted])
  })

  it('moves Shift+Tab from below the waiting space onto the last card', async () => {
    const board = await loadBoard(network, tasks(500, 3))
    await board.render(root)
    const todo = () => document.querySelector('[data-board-cell][data-status="todo"]')
    // a card after the To Do cell
    await act(async () =>
      document
        .querySelector<HTMLElement>('[data-status="progress"] [data-focus-key="title"]')
        ?.focus(),
    )
    await act(async () => todo()?.querySelector<HTMLElement>('[data-board-pending]')?.focus())
    const all = todo()?.querySelectorAll('[data-card]')
    const last = all?.[all.length - 1]
    expect(all).toHaveLength(500)
    expect(document.activeElement).toBe(last?.querySelector('[data-focus-key="owner"]'))
  })

  it('mounts every card at once for Find', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
    })
    expect(cards()).toHaveLength(500)
  })

  it('brings cards back in slices when a filter that matched nothing is cleared', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    await finish()
    await board.search('no-such-task-zz')
    expect(cards()).toHaveLength(0)
    await board.search('')
    expect(cards().length).toBeLessThanOrEqual(EAGER + 64)
    await finish()
    expect(cards()).toHaveLength(500)
  })

  it('renders only the growing block of a long cell in a slice', async () => {
    const board = await loadBoard(network, tasks(2000))
    await board.render(root)
    // past two blocks, so a list that rendered all it holds would fail
    while (cards().length < 600) await slice()
    const stale = vi.spyOn(board.P, 'isStale')
    const before = cards().length
    await slice()
    const added = cards().length - before
    expect(added).toBeGreaterThan(0)
    // each card asks for its one task's staleness once as it renders
    expect(stale.mock.calls.length).toBeLessThanOrEqual(256 + added)
  })
})
