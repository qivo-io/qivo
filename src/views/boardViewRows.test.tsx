// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewRow } from '../../convex/lib/viewReads'
import { isoFromDate, TODAY_WEEK, weekToISO } from '../lib/dates'
import type { ScopeInfo } from '../store/planner'
import type { Snapshot } from '../store/plannerFixture.setup'
import { BOARD_TEST_TIMEOUT, cell, dragEvent, loadBoard, taskRow } from './boardFixture.setup'

/* Modules that read the store, imported after loadBoard booted it, so
   they read the same store (loadBoard resets the module registry). */
const booted = async () => ({
  ...(await import('./board/cardEstimate')),
  ...(await import('../components/AssigneeAvatar')),
  ...(await import('../components/ui/tooltip')),
  ...(await import('../lib/openedTasks')),
})

/* A Board card of a task only the Board's answer brings, whose task the
   workspace has not received (store/viewRows.ts): it shows, its delay comes
   from the owner-load cache with Delay unknown where the load cannot be
   read, it drags, its owner changes, and it opens in the task window. */

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
  Element.prototype.scrollIntoView = () => {}
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Task `far` as the Board's answer sends it, planned this week and next
    with 10 hours left and due in two weeks, which the workspace lacks. */
function far(snap: Snapshot): ViewRow {
  const { description: _text, ...fields } = taskRow(snap, 'far', 'progress', 50)
  return {
    ...fields,
    remaining_hours: 10,
    start_week: weekToISO(TODAY_WEEK),
    end_week: weekToISO(TODAY_WEEK + 1),
    due_date: weekToISO(TODAY_WEEK + 2),
    has_subtasks: false,
  }
}

/** A Board whose project shows delays, one task the workspace holds, and
    the answer's task `far` the workspace lacks. */
async function farBoard() {
  const board = await loadBoard(network, (snap) => {
    snap.projects[0].track_delay = true
    snap.issues.push(taskRow(snap, 'a', 'todo', 1))
  })
  board.server.edit = (answer) =>
    answer.state === 'ok' ? { ...answer, rows: [...answer.rows, far(board.snapshot)] } : answer
  await board.render(root)
  await board.answer()
  return board
}

const writes = () =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === 'issues:update')
    .map(([, args]) => args as { id: string; patch: Record<string, unknown> })

describe('a card only the answer brings', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows Delay unknown once its owner's load cannot be read, and sizes its card again", async () => {
    const board = await farBoard()
    const card = () => board.card('far')
    expect(card()).not.toBeNull()
    expect(board.P.handleOf('far')).toBeNull()
    // the stand-in reads the owner's load: on track, no band
    expect(card()?.querySelector('[data-delay]')).toBeNull()
    const model = board.P.viewTask('board:desktop', 'far')
    if (!model) throw new Error('no model')
    const { createEstimateCache } = await booted()
    const estimate = createEstimateCache()
    const group = (it: typeof model) => ({ key: 'g', parent: null, ancestors: [], issues: [it] })
    const before = estimate(group(model), () => null, 280, 'pooled', 'todo')
    // the owner's load turns unavailable
    board.server.unavailable = [board.snapshot.profiles[0].id]
    await board.answer()
    expect(card()?.querySelector('[data-delay="unknown"]')?.textContent).toBe('Delay unknown')
    // a new model, so the card renders and is sized again, taller by the band
    const after = board.P.viewTask('board:desktop', 'far')
    expect(after).not.toBe(model)
    if (!after) throw new Error('no model')
    expect(estimate(group(after), () => null, 280, 'pooled', 'todo')).toBeGreaterThan(before)
    // and a held task keeps the workspace's own delay: no load is asked for it
    const asked = network.onUpdate.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'planning:ownerLoads')
      .map(([, args]) => (args as { owner_ids: string[] }).owner_ids)
    expect(asked.every((owners) => owners.length === 1)).toBe(true)
  })

  it('drags to another status, painted at once', async () => {
    const board = await farBoard()
    await act(async () => board.card('far')?.dispatchEvent(dragEvent('dragstart')))
    await act(async () => cell('review')?.dispatchEvent(dragEvent('dragover')))
    await act(async () => cell('review')?.dispatchEvent(dragEvent('drop')))
    expect(writes().map((w) => w.patch)).toEqual([{ status: 'review' }])
    expect(board.P.viewTask('board:desktop', 'far')?.status).toBe('review')
    expect(cell('review')?.contains(board.card('far'))).toBe(true)
  })

  it("changes its owner from the owner picker, with the roster's check", async () => {
    const board = await farBoard()
    const model = board.P.viewTask('board:desktop', 'far')
    if (!model) throw new Error('no model')
    const { OwnerPickList, TooltipProvider } = await booted()
    await act(async () =>
      root.render(
        <TooltipProvider>
          <OwnerPickList issue={model} onClose={(then) => then()} />
        </TooltipProvider>,
      ),
    )
    const unassigned = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
      (item) => item.textContent === 'Unassigned',
    )
    await act(async () => unassigned?.click())
    expect(writes().map((w) => w.patch)).toEqual([{ assignee_id: null }])
    expect(board.P.viewTask('board:desktop', 'far')?.assignee).toBeUndefined()
  })

  it('keeps its card while the tab hides, marked refreshing until the fresh answer', async () => {
    const board = await farBoard()
    const state = () => document.querySelector<HTMLElement>('[data-board-root]')?.dataset.boardState
    const setVisibility = async (value: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    }
    try {
      await setVisibility('hidden')
      board.server.hold = true
      await setVisibility('visible')
      // the rows the read kept, not the store's own result, which lacks far
      expect(state()).toBe('refreshing')
      expect(board.card('far')).not.toBeNull()
      expect(document.querySelector('[data-status-count="progress"]')?.textContent).toBe('…')
      await board.answer()
      expect(state()).toBe('ok')
      expect(board.card('far')).not.toBeNull()
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('judges its delay again on a new day, with no delivery', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.projects[0].track_delay = true
    })
    // a task due today, which only the answer brings
    const due: ViewRow = {
      ...far(board.snapshot),
      id: 'due',
      num: 51,
      title: 'Task due',
      status: 'todo',
      remaining_hours: undefined,
      start_week: undefined,
      end_week: undefined,
      due_date: isoFromDate(new Date()),
    }
    board.server.edit = (answer) =>
      answer.state === 'ok' ? { ...answer, rows: [...answer.rows, due] } : answer
    await board.render(root)
    await board.answer()
    expect(board.card('due')).not.toBeNull()
    expect(board.card('due')?.querySelector('[data-delay]')).toBeNull()
    // the next morning, and the window gets the focus back
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(tomorrow)
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(board.card('due')?.querySelector('[data-delay]')?.getAttribute('data-delay')).toBe(
        'late',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets the other layout's rows go when the window crosses the phone's width", async () => {
    // the phone's list first, as on a narrow window
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    })
    board.server.edit = (answer) =>
      answer.state === 'ok' ? { ...answer, rows: [...answer.rows, far(board.snapshot)] } : answer
    const { useBoardView } = await import('./board/useBoardView')
    const filters = {
      mine: false,
      assignees: [],
      priority: null,
      stale: false,
      focus: false,
      search: '',
    }
    /** The Board's view in `variant`, as the phone's list or the desktop Board reads it. */
    function Probe({ info, variant }: { info: ScopeInfo; variant: 'desktop' | 'phone' }) {
      const view = useBoardView(info, filters, variant)
      return <div data-probe={variant} data-state={view.state} />
    }
    const show = (variant: 'desktop' | 'phone') =>
      board.renderView(root, (info) => <Probe key={variant} info={info} variant={variant} />)
    await show('phone')
    await board.answer()
    expect(board.P.viewTask('board:phone', 'far')?.status).toBe('progress')
    // wider than a phone: the desktop Board takes over
    await show('desktop')
    await board.answer()
    expect(board.P.boardRead('board:phone').key).toBeNull()
    expect(board.P.viewTask('board:phone', 'far')).toBeUndefined()
    // another person moves the task on; the phone's old row does not stand in
    const edit = board.server.edit
    board.server.edit = (answer) => {
      const next = edit ? edit(answer) : answer
      return next.state === 'ok'
        ? {
            ...next,
            rows: next.rows.map((r) => (r.id === 'far' ? { ...r, status: 'review' as const } : r)),
          }
        : next
    }
    await board.answer()
    const id = board.P.viewTask('board:desktop', 'far')?.id ?? ''
    expect(board.P.anyTask(id)?.status).toBe('review')
  })

  it("opens in the task window from the window's own read", async () => {
    const board = await farBoard()
    const handle = board.P.viewTask('board:desktop', 'far')?.id ?? ''
    const { openedTask } = await booted()
    expect(openedTask(handle, (t) => board.P.handleNow(t.uuid, t.org, t.num))).toBeUndefined()
    await act(async () => board.card('far')?.click())
    expect(openedTask(handle, (t) => board.P.handleNow(t.uuid, t.org, t.num))?.uuid).toBe('far')
  })
})
