// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_CARD_PITCH } from '../lib/boardGroups'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, loadBoard, taskRow } from './boardFixture.setup'

/* Opening the Board on the real store renders it once, and a large Board
   mounts its first screen at once and the rest in slices. The slices are
   MessageChannel tasks, which the test runs one at a time. */

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
  // the slices wait for frames, which the same queue runs
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    slices.push(() => callback(performance.now())),
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
const tasks =
  (count: number, progress = 0) =>
  (snap: Snapshot) => {
    for (let n = 0; n < count; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n + 1))
    for (let n = 0; n < progress; n++)
      snap.issues.push(taskRow(snap, `p${n}`, 'progress', count + n + 1))
  }

// Slices size themselves by the real clock, so a busy machine makes them small.
describe('opening the Board', { timeout: BOARD_TEST_TIMEOUT * 3 }, () => {
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
    // blocks of 16 cards, which the browser lays out as each comes into view
    const blocks = [...document.querySelectorAll('[data-deferred-block]')]
    expect(blocks.length).toBeGreaterThan(20)
    for (const block of blocks) expect(block.children.length).toBeLessThanOrEqual(16)
    expect(pane()?.getAttribute('data-board-mount')).toBe('complete')
    expect(pane()?.hasAttribute('aria-busy')).toBe(false)
  })

  it('keeps every mounted card node when a task arrives at the top of its cell', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    await slice()
    const before = new Map([...cards()].map((card) => [card.getAttribute('data-card'), card]))
    board.snapshot.issues.push({
      ...taskRow(board.snapshot, 'top', 'todo', 900),
      priority: 'urgent',
    })
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

  it('mounts every card at once for Find on a layout whose F is another letter', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    await act(async () => {
      // Ctrl+F on a Russian layout: the key reads а, the physical key is F
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'а', code: 'KeyF', ctrlKey: true }))
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
    // the most cards one Board shows (BOARD_TASKS)
    const board = await loadBoard(network, tasks(1000))
    await board.render(root)
    // past two blocks, so a list that rendered all it holds would fail
    while (cards().length < 600) await slice()
    const stale = vi.spyOn(board.P, 'isStale')
    const before = cards().length
    // the next slice, after any frame it waits for
    while (cards().length === before) await slice()
    const added = cards().length - before
    expect(added).toBeGreaterThan(0)
    // each card asks for its one task's staleness once as it renders
    expect(stale.mock.calls.length).toBeLessThanOrEqual(64 + added)
  })

  it('works out the height of only the cards a delivery changed', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    // a card's estimate asks for its delay; rendering a card asks again
    const delay = vi.spyOn(board.P, 'delayColor')
    board.snapshot.issues[200].title = 'Renamed elsewhere'
    await board.deliver()
    expect(delay.mock.calls.length).toBeLessThan(20)
  })

  it('sizes the waiting cards again when their project starts tracking delay', async () => {
    // late tasks: a week's work with 400 hours left
    const week = weekToISO(TODAY_WEEK)
    const board = await loadBoard(network, (snap) => {
      for (let n = 0; n < 500; n++)
        snap.issues.push({
          ...taskRow(snap, `t${n}`, 'todo', n + 1),
          start_week: week,
          end_week: week,
          due_date: week,
          remaining_hours: 400,
          remaining_set_at: new Date().toISOString(),
        })
    })
    await board.render(root)
    const waiting = () =>
      Number.parseFloat(
        document.querySelector<HTMLElement>('[data-board-pending]')?.style.height ?? '0',
      )
    const before = waiting()
    expect(before).toBeGreaterThan(0)
    // the tasks keep their objects, and each card gains its delay banner
    for (const project of board.snapshot.projects) project.track_delay = true
    await board.deliver()
    expect(waiting()).toBeGreaterThan(before)
  })

  it('sizes the waiting cards again when the date format changes', async () => {
    const board = await loadBoard(network, (snap) => {
      for (let n = 0; n < 500; n++)
        snap.issues.push({ ...taskRow(snap, `t${n}`, 'todo', n + 1), due_date: '2026-10-22' })
    })
    await board.render(root)
    const waiting = 500 - cards().length
    const dates = vi.spyOn(board.P, 'fmtISO')
    // the organization's new date format, as App sets it on its next render
    board.P.setDateFormat('MMM D, YYYY')
    board.snapshot.issues[0].title = 'Renamed elsewhere'
    await board.deliver()
    // each waiting card's due date is measured again in the new format
    expect(dates.mock.calls.length).toBeGreaterThanOrEqual(waiting)
  })

  it('keeps the cards it sized when a change moves only the store context', async () => {
    const board = await loadBoard(network, tasks(500))
    await board.render(root)
    const delay = vi.spyOn(board.P, 'delayColor')
    // a person's new name renders every mounted card again, and sizes none
    board.snapshot.profiles[0].name = 'Planner Renamed'
    await board.deliver()
    expect(document.querySelector('[aria-label$=": Planner Renamed"]')).not.toBeNull()
    expect(delay.mock.calls.length).toBeLessThan(cards().length * 4)
    expect(delay.mock.calls.length).toBeLessThan(100)
  })

  // a lane of 500 cards fills the first screen; the Unassigned lane is
  // below it, with 20 cards to do and 5 in progress
  const twoLanes = (snap: Snapshot) => {
    tasks(500)(snap)
    for (let n = 0; n < 25; n++)
      snap.issues.push({
        ...taskRow(snap, `u${n}`, n < 20 ? 'todo' : 'progress', 600 + n),
        assignee_id: undefined,
      })
  }

  it("lets the browser skip the lanes below a large Board's first screen", async () => {
    const board = await loadBoard(network, twoLanes, { metaViz: 'assignees' })
    await board.render(root)
    const bodies = [...document.querySelectorAll<HTMLElement>('.board-lane-body')]
    expect(bodies).toHaveLength(2)
    expect(bodies[0].hasAttribute('data-lane-deferred')).toBe(false)
    expect(bodies[0].style.containIntrinsicBlockSize).toBe('')
    expect(bodies[1].hasAttribute('data-lane-deferred')).toBe(true)
    // its tallest cell's estimated height: the padding above the 20 cards
    // waiting to do, whose space holds their estimated height and gaps
    const todo = bodies[1].querySelector<HTMLElement>('.board-pending')
    expect(bodies[1].style.containIntrinsicBlockSize).toBe(
      `auto ${8 + Number.parseFloat(todo?.style.height ?? '')}px`,
    )
    expect(Number.parseFloat(todo?.style.height ?? '')).toBeGreaterThan(20 * MIN_CARD_PITCH - 8)
  })

  it('skips a lane only until it first renders', async () => {
    const board = await loadBoard(network, twoLanes, { metaViz: 'assignees' })
    await board.render(root)
    const body = document.querySelectorAll<HTMLElement>('.board-lane-body')[1]
    const state = (skipped: boolean) =>
      body.dispatchEvent(Object.assign(new Event('contentvisibilityautostatechange'), { skipped }))
    state(true)
    expect(body.hasAttribute('data-lane-deferred')).toBe(true)
    // the browser renders it: the height it would keep while skipped from
    // then on would not follow its cards
    state(false)
    expect(body.hasAttribute('data-lane-deferred')).toBe(false)
    expect(body.style.containIntrinsicBlockSize).toBe('')
    // and a later change to its cards leaves it out too
    board.snapshot.issues.push({
      ...taskRow(board.snapshot, 'u25', 'todo', 625),
      assignee_id: undefined,
    })
    await board.deliver()
    expect(body.querySelectorAll('[data-board-pending]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-lane-deferred]')).toHaveLength(0)
    expect(document.querySelectorAll<HTMLElement>('.board-lane-body')[1]).toBe(body)
    expect(body.style.containIntrinsicBlockSize).toBe('')
  })

  it('skips no lane of a Board that renders whole', async () => {
    const board = await loadBoard(
      network,
      (snap) => {
        tasks(25)(snap)
        for (let n = 0; n < 5; n++)
          snap.issues.push({ ...taskRow(snap, `u${n}`, 'todo', 600 + n), assignee_id: undefined })
      },
      { metaViz: 'assignees' },
    )
    await board.render(root)
    expect(document.querySelectorAll('.board-lane-body')).toHaveLength(2)
    expect(document.querySelectorAll('[data-lane-deferred]')).toHaveLength(0)
  })
})
