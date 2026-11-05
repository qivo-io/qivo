// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn, type ForcedBoard } from './store/boardStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* A boot on a task's address, on App and the real store: the live parts
   read the task the address names with their first stage (AuthGate passes
   the address, store/liveParts.ts `address`), so the window shows it from
   that answer while the workspace still loads its tasks, without waiting
   for every task, and the window's reference takes the read over with no
   second one. The scope moves to the task's project once the answer names
   it, and the window turns editable in place once the workspace holds the
   task. An archived task's address shows it read-only, with Restore for
   an editor only. A task the server answers unavailable can't be opened,
   with Retry where no read follows that answer, as for a uuid every
   organization answered. The Board behind it can be past its budget. The
   address-moved gate shows nothing of the task and reads no message. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void },
}))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
// 12,800 task numbers make 64 task windows; the last starts at fc000000
const LAST_WINDOW = 'fc000000'
// QN-2, in the last task window
const SOAK = 'fd000000-0000-4000-8000-000000000002'

let container: HTMLDivElement
let root: Root
/* The reads of taskWindow.task, which the test answers. */
let reads: { args: Record<string, unknown>; next: (value: unknown) => void }[]

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.holdWindow(null)
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Waits for `find` to answer, through lazy modules that can take seconds
    to load on a busy worker. */
function waitFor<T>(find: () => T | null | undefined, what: string) {
  return vi.waitFor(
    () => {
      const found = find()
      if (!found) throw new Error(`missing ${what}`)
      return found
    },
    { timeout: 10_000 },
  )
}

/** Boots on `address` as AuthGate does, the task it names read with the
    first stage, on a large workspace whose last task window, holding QN-2,
    is still to arrive. `shape` changes the workspace first, `board` forces
    the Board's answer and `before` runs once the store holds the workspace,
    before App renders. Answers the store and a way to let the last window
    answer. */
async function bootAt(
  address: string,
  {
    shape,
    board,
    before,
  }: {
    shape?: (snap: Snapshot) => void
    board?: ForcedBoard
    before?: (store: typeof import('./store/planner')) => void
  } = {},
) {
  vi.resetModules()
  reads = []
  history.replaceState(null, '', address)
  const snap: Snapshot = plannerFixture()
  snap.orgs[0].next_issue_num = 64 * 200
  snap.issues.push({
    id: SOAK,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num: 2,
    title: 'Run the soak test',
    description: 'Hold it for a day.',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  shape?.(snap)
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'taskWindow:task') reads.push({ args, next })
    else if (name === 'tasks:board')
      next(boardStandIn(snap, args as BoardArgs, board ? { force: board } : {}))
    else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  const { addressedTask } = await import('./lib/router')
  double.live?.holdWindow(LAST_WINDOW)
  await store.initStore(undefined, undefined, {
    address: addressedTask(location.pathname, location.hash),
  })
  expect(store.P.stillLoading()).not.toBeNull()
  before?.(store)
  const { syncStatus } = await import('./lib/syncStatus')
  syncStatus.setSocket({ connected: true, everConnected: true })
  const { default: App } = await import('./App')
  await act(async () =>
    root.render(
      <TooltipProvider>
        <App />
      </TooltipProvider>,
    ),
  )
  const arrive = () =>
    act(async () => {
      double.live?.holdWindow(null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  return { store, snap, arrive }
}

/** The answer readWindowTask gives the soak test, active or archived, at
    `level`. */
function answerOf(snap: Snapshot, archived = false, level = 'lead') {
  const row = snap.issues.find((it) => it.id === SOAK)
  if (!row) throw new Error('no soak test')
  if (archived) {
    const { description, has_hidden_subtasks: _h, has_hidden_parent: _p, ...page } = row
    return {
      state: 'archived',
      task: { ...page, archived_at: '2026-09-14T09:00:00.000Z', is_group: false },
      description,
      labels: [],
      level,
    }
  }
  return {
    state: 'ok',
    task: { ...row, has_subtasks: false },
    level,
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: [], complete: true },
  }
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const note = () => document.querySelector('[data-task-gone] [role="status"]')?.textContent

describe('a boot on a task address', { timeout: 30_000 }, () => {
  it('reads the task with the first stage, shows it from that answer while tasks load, and turns editable in place once the workspace holds it', async () => {
    const { store, snap, arrive } = await bootAt('/app/testbed/board/all/tasks/qn-2')
    const org = snap.orgs[0].id
    // the read the boot subscribed with its first stage
    expect(reads.map((read) => read.args)).toEqual([{ org_id: org, ref: 'QN-2' }])
    await waitFor(() => note() === 'Loading QN-2…', 'the loading frame')
    expect(dialog()?.querySelector('[data-task-loading]')).not.toBeNull()
    await act(async () => reads[0]?.next(answerOf(snap)))
    await waitFor(() => dialog()?.dataset.taskSource === 'answer', 'the task from its answer')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Run the soak test')
    // the window's reference took the boot's read over; its own read by
    // uuid is the only other
    expect(reads.filter((read) => read.args.ref === 'QN-2')).toHaveLength(1)
    expect(reads.map((read) => read.args.ref)).toEqual(['QN-2', SOAK])
    expect(store.P.stillLoading()).not.toBeNull()
    const window = dialog()
    // the workspace brings it: the same window, now the workspace's
    await arrive()
    await waitFor(() => dialog()?.dataset.taskSource === 'workspace', "the workspace's task")
    expect(dialog()).toBe(window)
    expect(location.pathname).toBe('/app/testbed/board/all/tasks/qn-2')
  })

  it("moves the page behind it to the task's own project once its answer names it", async () => {
    const { snap } = await bootAt('/app/testbed/board/tasks/qn-2', {
      // My view, saved, holds only my tasks, and nobody has QN-2
      shape: (next) =>
        localStorage.setItem(
          `planner.ui.v1:${next.profiles[0].id}`,
          JSON.stringify({ scope: 'mine', view: 'kanban' }),
        ),
    })
    await waitFor(() => note() === 'Loading QN-2…', 'the loading frame')
    expect(location.pathname).toBe('/app/testbed/board/tasks/qn-2')
    await act(async () => reads[0]?.next(answerOf(snap)))
    await waitFor(() => dialog()?.dataset.taskSource === 'answer', 'the task from its answer')
    // closing it shows its project's Board, not My view
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await waitFor(() => location.pathname === '/app/testbed/board/p/1', "its project's Board")
  })

  it('shows an archived task read-only, with Restore for someone who can edit its project only', async () => {
    for (const [level, restore] of [
      ['lead', true],
      ['viewer', false],
    ] as const) {
      await act(async () => root.unmount())
      root = createRoot(container)
      const { snap } = await bootAt('/app/testbed/tasks/qn-2', {
        shape: (next) => {
          if (level === 'viewer') {
            next.profiles[0].org_role = 'user'
            next.access.push({
              project_id: next.projects[0].id,
              profile_id: next.profiles[0].id,
              level: 'viewer',
            })
          }
        },
      })
      await waitFor(() => note() === 'Loading QN-2…', 'the loading frame')
      await act(async () => reads[0]?.next(answerOf(snap, true, level)))
      await waitFor(() => dialog()?.dataset.taskArchived === '', 'the archived task')
      expect(document.querySelector('[data-task-title]')?.textContent).toBe('Run the soak test')
      const buttons = [...document.querySelectorAll('[data-task-gone] button')]
      expect(
        buttons.some((b) => b.textContent === 'Restore'),
        level,
      ).toBe(restore)
    }
  })

  it("says a task the server answers unavailable can't be opened, with Retry where no read follows that answer", async () => {
    // a number in its organization, whose read goes on after the answer
    let booted = await bootAt('/app/testbed/tasks/qn-2')
    await act(async () => reads[0]?.next({ state: 'unavailable' }))
    await waitFor(() => note()?.startsWith("QN-2 can't be opened."), 'the note')
    const retry = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-task-gone] button')].find(
        (b) => b.textContent === 'Retry',
      )
    expect(retry()).toBeUndefined()
    // a uuid, which every organization of the login answered unavailable
    await act(async () => root.unmount())
    root = createRoot(container)
    booted = await bootAt(`/app/testbed/tasks/${SOAK}`)
    const org = booted.snap.orgs[0].id
    expect(reads.map((read) => read.args)).toEqual([{ org_id: org, ref: SOAK }])
    await act(async () => reads[0]?.next({ state: 'unavailable' }))
    await waitFor(() => note()?.startsWith("This task can't be opened."), 'the note')
    // Retry reads it again, and it opens
    await act(async () => retry()?.click())
    expect(reads.map((read) => read.args)).toEqual([
      { org_id: org, ref: SOAK },
      { org_id: org, ref: SOAK },
    ])
    await act(async () => reads[1]?.next(answerOf(booted.snap)))
    await waitFor(() => dialog()?.dataset.taskSource === 'answer', 'the task from its answer')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Run the soak test')
  })

  it('opens the task when its Board is past its budget', async () => {
    const { snap } = await bootAt('/app/testbed/board/tasks/qn-2', { board: 'over_ceiling' })
    await act(async () => reads[0]?.next(answerOf(snap)))
    await waitFor(() => dialog()?.dataset.taskSource === 'answer', 'the task from its answer')
    expect(document.querySelector('[data-task-title]')?.textContent).toBe('Run the soak test')
  })

  it('shows nothing of the task behind the address-moved gate, and reads no message', async () => {
    const { snap } = await bootAt('/app/testbed/inbox/tasks/qn-2', {
      shape: (next) =>
        next.messages.push({
          id: 'message-a',
          org_id: next.orgs[0].id,
          recipient_id: next.profiles[0].id,
          issue_id: SOAK,
          issue_title: 'Run the soak test',
          kind: 'comment',
          detail: 'New comment',
          created_at: '2026-09-14T09:00:00.000Z',
        }),
      // this login followed the address when it named another organization
      before: (store) => {
        localStorage.setItem(
          `qivo.addr.v1:${store.P.CURRENT_USER}`,
          JSON.stringify({ testbed: 'another-org' }),
        )
      },
    })
    await waitFor(() => document.querySelector('[data-address-continue]'), 'the gate')
    // the boot's read may answer behind it
    await act(async () => reads[0]?.next(answerOf(snap)))
    expect(dialog()).toBeNull()
    expect(document.body.textContent).not.toContain('Run the soak test')
    const marks = network.mutation.mock.calls.filter(
      ([ref]) => getFunctionName(ref) === 'messages:markRead',
    )
    expect(marks).toEqual([])
  })
})
