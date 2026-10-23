// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture, type Snapshot } from './store/plannerFixture.setup'

/* Back or Forward to a task's address while a large workspace still loads
   its tasks in stages (store/liveParts.ts), on App and the real store: the
   task window waits for a task still to arrive, the address keeps naming
   it, and the task opens once it arrives. */

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
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

describe('Back to a task still to arrive', { timeout: 30_000 }, () => {
  it('holds its address and opens the task once it arrives', async () => {
    vi.resetModules()
    const snap: Snapshot = plannerFixture()
    snap.orgs[0].next_issue_num = 64 * 200
    snap.issues.push({
      id: 'fd000000-b',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
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
    network.onUpdate.mockImplementation((ref, _args, next) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') next(structuredClone(snap))
      else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
      return () => {}
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    const store = await import('./store/planner')
    double.live?.holdWindow(LAST_WINDOW)
    await store.initStore()
    expect(store.P.stillLoading()).not.toBeNull()
    // App's views load their code only while the socket counts as connected
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
    const org = location.pathname.split('/')[2]
    const address = `/app/${org}/board/tasks/qn-2`
    // an entry from earlier in this session's history, reached with Back
    await act(async () => {
      history.pushState(null, '', address)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    expect(location.pathname).toBe(address)

    await act(async () => {
      double.live?.holdWindow(null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(store.P.stillLoading()).toBeNull()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    expect(location.pathname).toBe(address)
  })
})
