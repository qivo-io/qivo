// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { answerOverview } from './store/overviewStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './store/plannerFixture.setup'

/* A task picked in Search while the Board shows, on App and the real store
   in a session that never asked for every task: the task window opens
   over the Board, and the Board rings the task's card, which only its
   answer brings, as the workspace holds no task. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  return { convex: network, live: liveOver(network) }
})
vi.mock('./lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const SOAK = 'fd000000-0000-4000-8000-000000000002'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  // jsdom has no element scrollTo, which the reveal scrolls the Board with
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
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
  const { TASKS } = await import('./store/liveParts')
  TASKS.atBoot = true
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  localStorage.clear()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
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

describe('a task picked in Search over the Board', { timeout: 30_000 }, () => {
  it("rings the Board's card of a task only the Board's answer brings, with no ask", async () => {
    vi.resetModules()
    history.replaceState(null, '', '/app/testbed/board/p/1')
    const snap: Snapshot = underProgram(plannerFixture())
    snap.orgs[0].next_issue_num = 2
    const project = snap.projects[0]
    snap.issues.push({
      id: SOAK,
      org_id: snap.orgs[0].id,
      project_id: project.id,
      num: 2,
      title: 'Run the soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    network.onUpdate.mockImplementation((ref, args, next, fail) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') next(structuredClone(snap))
      else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
      else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
      else if (name.startsWith('overview:')) answerOverview(snap, name, args, next, fail)
      return () => {}
    })
    // Search finds the task on the server
    network.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'search:page'
        ? {
            rows: [
              {
                kind: 'task',
                org_id: snap.orgs[0].id,
                id: SOAK,
                num: 2,
                title: 'Run the soak test',
                status: 'progress',
                is_group: false,
                archived: false,
                project: { id: project.id, name: project.name },
                parent: null,
              },
            ],
            next_cursor: null,
            coverage: { complete: true },
          }
        : null,
    )
    network.mutation.mockResolvedValue(null)
    const { TASKS } = await import('./store/liveParts')
    // the app's boot, without the test default's every task
    TASKS.atBoot = false
    const store = await import('./store/planner')
    await store.initStore()
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
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
    const card = () => document.querySelector<HTMLElement>('[data-card="QN-2"]')
    await waitFor(card, "the Board's card")
    expect(store.P.handleOf(SOAK)).toBeNull()
    await act(async () => document.querySelector<HTMLElement>('[data-sidebar-search]')?.click())
    const input = await waitFor(
      () =>
        document.querySelector<HTMLInputElement>('input[aria-label="Search tasks and projects"]'),
      'Search',
    )
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'soak')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const result = await waitFor(
      () => document.querySelector<HTMLElement>('[cmdk-item][data-value="issue-QN-2"]'),
      'the result',
    )
    await act(async () => result.click())
    // the window opens over the Board, which rings the card
    await waitFor(() => location.pathname.endsWith('/tasks/qn-2'), "the task's address")
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await waitFor(
      () => card()?.closest('.board-card')?.hasAttribute('data-board-revealed'),
      'the ring',
    )
    expect(store.P.taskLoad()).toEqual({ state: 'not_asked' })
  })
})
