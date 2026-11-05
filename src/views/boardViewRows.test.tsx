// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act, memo } from 'react'
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
    the answer's task `far` the workspace lacks, with `prepare`'s changes,
    as the phone's task list with `phone`. */
async function farBoard(prepare: (snap: Snapshot) => void = () => {}, phone = false) {
  const board = await loadBoard(
    network,
    (snap) => {
      snap.projects[0].track_delay = true
      snap.issues.push(taskRow(snap, 'a', 'todo', 1))
      prepare(snap)
    },
    { phone },
  )
  // the workspace holds every task it has, which leaves out far
  await board.ask()
  board.server.edit = (answer) =>
    answer.state === 'ok' ? { ...answer, rows: [...answer.rows, far(board.snapshot)] } : answer
  await board.render(root)
  await board.answer()
  return board
}

/** A second person of the organization. */
const OTHER = 'other-person'

/** Gives the held task `a` to OTHER, in progress with hours left, planned
    and due, so its verdict would read OTHER's load if the cache judged it. */
function heldByOther(snap: Snapshot) {
  snap.profiles.push({
    ...snap.profiles[0],
    id: OTHER,
    auth_user_id: 'other-account',
    name: 'Other',
    initials: 'OT',
    org_role: 'user',
  })
  const a = snap.issues.find((t) => t.id === 'a')
  if (!a) throw new Error('no task a')
  Object.assign(a, {
    assignee_id: OTHER,
    status: 'progress',
    remaining_hours: 10,
    start_week: weekToISO(TODAY_WEEK),
    end_week: weekToISO(TODAY_WEEK + 1),
    due_date: weekToISO(TODAY_WEEK + 2),
  })
}

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
const count = (status: string) =>
  document.querySelector(`[data-status-count="${status}"]`)?.textContent
const busy = () => document.querySelector('[data-board-root]')?.getAttribute('aria-busy') === 'true'

/** Drops the card of task `uuid` on the pooled lane's `status` cell. */
async function drop(board: Awaited<ReturnType<typeof loadBoard>>, uuid: string, status: string) {
  await act(async () => board.card(uuid)?.dispatchEvent(dragEvent('dragstart')))
  await act(async () => cell(status)?.dispatchEvent(dragEvent('dragover')))
  await act(async () => cell(status)?.dispatchEvent(dragEvent('drop')))
}

const writes = () =>
  network.mutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === 'issues:update')
    .map(([, args]) => args as { id: string; patch: Record<string, unknown> })

describe('a card only the answer brings', { timeout: BOARD_TEST_TIMEOUT }, () => {
  it("shows Delay unknown once its owner's load cannot be read, and sizes its card again", async () => {
    const board = await farBoard(heldByOther)
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
    // and a held task keeps the workspace's own delay: its owner's load is
    // never asked for, though its verdict would read one
    const asked = network.onUpdate.mock.calls
      .filter(([ref]) => getFunctionName(ref) === 'planning:ownerLoads')
      .flatMap(([, args]) => (args as { owner_ids: string[] }).owner_ids)
    expect(asked).toContain(board.snapshot.profiles[0].id)
    expect(asked).not.toContain(OTHER)
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

  it('drops a card of a session that never asked, marked as a write on the answer’s task', async () => {
    // the app's state: no task held, every card the answer's row
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1), {
        ...taskRow(snap, 'b', 'todo', 2),
        assignee_id: undefined,
      })
    })
    await board.render(root)
    expect(board.P.taskLoad()).toEqual({ state: 'not_asked' })
    board.probe?.faults()
    board.probe?.answerMarks()
    await drop(board, 'a', 'review')
    // an owner change on the card too, from its row
    const b = board.card('b')?.dataset.card ?? ''
    await act(async () => void board.P.updateIssue(b, { assignee: board.snapshot.profiles[0].id }))
    expect(writes().map((w) => w.patch)).toEqual([
      { status: 'review' },
      { assignee_id: board.snapshot.profiles[0].id },
    ])
    // the view write's mark lets both through the guard, with no ask
    expect(board.probe?.answerMarks()).toEqual(['issues:update', 'issues:update'])
    expect(board.probe?.faults()).toEqual([])
    expect(board.P.taskLoad()).toEqual({ state: 'not_asked' })
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

  it('keeps the Board loading while a loaded subtask waits for a parent only the answer brings', async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push({ ...taskRow(snap, 'y', 'todo', 2), parent_id: 'x' })
    })
    // its parent x, in a part of the workspace still to come, which the
    // server names as y's parent and sends among the answer's parents
    const { description: _text, ...fields } = taskRow(board.snapshot, 'x', 'todo', 1)
    const parent: ViewRow = { ...fields, has_subtasks: true, group_done: false }
    board.server.edit = (answer) =>
      answer.state === 'ok'
        ? {
            ...answer,
            rows: answer.rows.map((row) => (row.id === 'y' ? { ...row, parent_id: 'x' } : row)),
            parents: [...answer.parents, parent],
          }
        : answer
    // y is held, and a load of every task is on its way
    await board.ask()
    const loading = vi.spyOn(board.P, 'tasksArriving').mockReturnValue(true)
    await board.render(root)
    await board.answer()
    const state = () => document.querySelector<HTMLElement>('[data-board-root]')?.dataset.boardState
    expect(board.P.handleOf('y')).not.toBeNull()
    expect(board.P.viewTask('board:desktop', 'x')).toBeDefined()
    // the card shows, and the Board does not say it is complete
    expect(board.card('y')).not.toBeNull()
    expect(state()).toBe('loading')
    // once every task has loaded, the workspace would hold x too
    loading.mockReturnValue(false)
    await board.answer()
    expect(state()).toBe('ok')
  })

  it("renders for its own news, not for the workspace's, as a kept Board that hides", async () => {
    const board = await loadBoard(network, (snap) => {
      snap.issues.push(taskRow(snap, 'a', 'todo', 1))
    })
    const { useBoardView } = await import('./board/useBoardView')
    const filters = {
      mine: false,
      assignees: [],
      priority: null,
      stale: false,
      focus: false,
      search: '',
    }
    let renders = 0
    // kept from its parent's renders, as KeptView keeps a hidden page
    const Probe = memo(function Probe({ scope }: { scope: string }) {
      const info = board.P.scopeInfo(scope)
      if (!info) throw new Error('missing the scope')
      const view = useBoardView(info, filters, 'desktop')
      renders++
      return <div data-probe-state={view.state} />
    })
    const scope = board.snapshot.projects[0].id
    await board.renderView(root, () => <Probe scope={scope} />)
    await board.answer()
    const answered = renders
    // another person renames the task: the workspace's delivery alone
    const a = board.snapshot.issues.find((t) => t.id === 'a')
    if (!a) throw new Error('no task a')
    a.title = 'Renamed'
    board.server.hold = true
    await board.deliver()
    expect(renders).toBe(answered)
    // the Board's answer with it is the Board's own news
    board.server.hold = false
    await board.answer()
    expect(renders).toBeGreaterThan(answered)
  })

  it('keeps a card moved off the word the search found it by, with its counts waiting', async () => {
    const board = await farBoard()
    // found by its status alone
    await board.search('progress')
    await wait(300)
    await board.answer()
    expect(board.card('far')).not.toBeNull()
    expect(count('progress')).toBe('1')
    expect(busy()).toBe(false)
    // dropped on In review, it may still match by its description, which
    // the Board does not hold
    board.server.hold = true
    await drop(board, 'far', 'review')
    expect(cell('review')?.contains(board.card('far'))).toBe(true)
    expect(count('review')).toBe('…')
    expect(busy()).toBe(true)
    // the answer that holds the write leaves it out; its paint waits for
    // the pending write or a 0 ms timer (store/planner.ts owe)
    board.server.edit = null
    board.server.hold = false
    await board.answer()
    await wait(10)
    expect(board.card('far')).toBeNull()
    expect(count('review')).toBe('0')
    expect(busy()).toBe(false)
  })

  it('counts a moved card that the search found by text its row does not send', async () => {
    const board = await farBoard()
    // no field the answer's row sends holds the word: the server found it
    // in the description or a label, which a drop does not change
    await board.search('harness')
    await wait(300)
    await board.answer()
    expect(board.card('far')).not.toBeNull()
    board.server.hold = true
    await drop(board, 'far', 'review')
    expect(cell('review')?.contains(board.card('far'))).toBe(true)
    expect(count('review')).toBe('1')
    expect(busy()).toBe(false)
  })

  /** Opens the window's own read of `far`, as its task window does, and
      answers it with the Board's row and `description`. */
  async function farWindow(board: Awaited<ReturnType<typeof farBoard>>, description: string) {
    let read: ((value: unknown) => void) | null = null
    const inner = network.onUpdate.getMockImplementation()
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      if (getFunctionName(ref) === 'taskWindow:task') {
        read = next
        return () => {}
      }
      return inner?.(ref, args, next, fail)
    })
    board.P.watchComments('far', board.snapshot.orgs[0].id)
    await wait(10)
    const row = far(board.snapshot)
    await act(async () => {
      read?.({
        state: 'ok',
        task: { ...row, description, has_hidden_subtasks: false, has_hidden_parent: false },
        level: 'lead',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      })
      await wait(10)
    })
    const handle = board.P.taskDetail('far')?.view?.id
    if (!handle) throw new Error('the window shows no task from its answer')
    return handle
  }

  it('shows a window write on its card at once, and counts it unsure while its description changes under a text filter', async () => {
    const board = await farBoard()
    await board.search('harness')
    await wait(300)
    await board.answer()
    expect(board.card('far')).not.toBeNull()
    expect(count('progress')).toBe('1')
    const handle = await farWindow(board, 'Check the harness')
    // the server accepts the window's writes
    network.mutation.mockImplementation(() => Promise.resolve(null))
    board.server.hold = true
    // a title away from the word: the row never held it, so the server found
    // it in the text the row does not send, which this write leaves alone
    void board.P.updateIssue(handle, { title: 'Tune the antenna' })
    await wait(10)
    expect(board.card('far')?.textContent).toContain('Tune the antenna')
    expect(count('progress')).toBe('1')
    expect(busy()).toBe(false)
    // the description may have held it: the counts wait for the answer
    void board.P.updateIssue(handle, { description: 'Check the cable' })
    await wait(10)
    expect(board.card('far')).not.toBeNull()
    expect(count('progress')).toBe('…')
    expect(busy()).toBe(true)
    board.server.hold = false
    await board.answer()
    await wait(10)
    expect(busy()).toBe(false)
  })

  it('opens in the task window by a reference to its organization, number and uuid, and a held card by its handle', async () => {
    const board = await farBoard()
    const opened: (string | null)[] = []
    await board.render(root, (task) => {
      opened.push(task)
      return null
    })
    const { refParts } = await import('../lib/taskReference')
    await act(async () => board.card('far')?.click())
    expect(refParts(opened.at(-1))).toEqual({
      org: board.snapshot.orgs[0].id,
      num: 50,
      uuid: 'far',
    })
    await act(async () => board.card('a')?.click())
    expect(opened.at(-1)).toBe(board.P.handleOf('a'))
  })

  it('opens from a phone row by a reference to its organization, number and uuid', async () => {
    const board = await farBoard(undefined, true)
    const opened: (string | null)[] = []
    await board.render(root, (task) => {
      opened.push(task)
      return null
    })
    const row = board.card('far')
    expect(row?.classList.contains('mobile-task-row')).toBe(true)
    expect(board.P.handleOf('far')).toBeNull()
    const { refParts } = await import('../lib/taskReference')
    await act(async () => row?.click())
    expect(refParts(opened.at(-1))).toEqual({
      org: board.snapshot.orgs[0].id,
      num: 50,
      uuid: 'far',
    })
    await act(async () => board.card('a')?.click())
    expect(opened.at(-1)).toBe(board.P.handleOf('a'))
  })
})
