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
   it, and the task opens once it arrives, in its own scope. The waiting
   window closes, and a task that never arrives closes it once every task
   has loaded. Settings opens meanwhile, but its pages that read every task
   wait. */

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
// All projects' Board, which names no organization
const ALL_BOARD = '/app/~/board/all'
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

/** Boots App on a large workspace whose last task window, holding task
    QN-2, is still to arrive, or with every task loaded when not `held`.
    Answers the store and the organization's slug. */
async function bootLoading(held = true) {
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
  if (held) double.live?.holdWindow(LAST_WINDOW)
  await store.initStore()
  expect(store.P.stillLoading() !== null).toBe(held)
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
  return { store, org: location.pathname.split('/')[2] }
}

/** Goes to `address` as Back or Forward would, to an entry from earlier in
    this session's history. */
const back = (address: string) =>
  act(async () => {
    history.pushState(null, '', address)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

/** Closes the task window with Escape, as a person would. */
const close = () =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

/** Lets the last task window answer. */
const arrive = () =>
  act(async () => {
    double.live?.holdWindow(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe('Back to a task still to arrive', { timeout: 30_000 }, () => {
  it('holds its address in a window that shows, and opens the task in its own scope once it arrives', async () => {
    const { store, org } = await bootLoading()
    // from All projects, which Back to a task address leaves
    await back(`/app/${org}/board/all`)
    const address = `/app/${org}/board/tasks/qn-2`
    await back(address)
    const waiting = await waitFor(
      () => document.querySelector('[data-task-loading]'),
      'the waiting window',
    )
    const dialog = waiting.closest<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-hidden')).toBeNull()
    expect(dialog?.style.opacity).toBe('1')
    expect(location.pathname).toBe(address)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    await waitFor(
      () => document.body.textContent?.includes('Run the soak test'),
      "the task's window",
    )
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    expect(location.pathname).toBe(address)
    // it opened in its own project, so closing it shows that project's
    // Board, not All projects
    await close()
    expect(location.pathname).toBe(`/app/${org}/board/p/1`)
  })

  it('closes from the waiting window, and the task does not open when it arrives', async () => {
    const { store, org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    await back(`/app/${org}/board/tasks/qn-2`)
    const waiting = await waitFor(
      () => document.querySelector('[data-task-loading]'),
      'the waiting window',
    )
    const closing = [...waiting.querySelectorAll('button')].find((b) => b.textContent === 'Close')
    await act(async () => closing?.click())
    expect(document.querySelector('[data-task-loading]')).toBeNull()
    expect(location.pathname).toBe(ALL_BOARD)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    expect(document.body.textContent).not.toContain('Run the soak test')
    expect(location.pathname).toBe(ALL_BOARD)
  })

  it('closes the window once every task has loaded without the task', async () => {
    const { store, org } = await bootLoading()
    await back(`/app/${org}/board/all`)
    // no task has number 3
    await back(`/app/${org}/board/tasks/qn-3`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the waiting window')
    expect(location.pathname).toBe(`/app/${org}/board/tasks/qn-3`)

    await arrive()
    expect(store.P.stillLoading()).toBeNull()
    await waitFor(() => !document.querySelector('[data-task-loading]'), 'the closed window')
    expect(location.pathname).toBe(ALL_BOARD)
  })

  it('names the page it shows when Back reaches a task that is gone after every task loaded', async () => {
    const { org } = await bootLoading(false)
    await back(`/app/${org}/board/all`)
    expect(location.pathname).toBe(ALL_BOARD)
    // the page stays All projects' Board
    await back(`/app/${org}/board/tasks/qn-3`)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(location.pathname).toBe(ALL_BOARD)
  })

  it('says in the Inbox that the task still loads, then opens it there', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/inbox/tasks/qn-2`)
    await waitFor(() => document.querySelector('[data-task-loading]'), 'the loading note')
    expect(document.body.textContent).not.toContain('No message selected.')
    await arrive()
    await waitFor(() => document.body.textContent?.includes('Run the soak test'), "the task's pane")
    expect(document.querySelector('[data-task-loading]')).toBeNull()
  })
})

describe('Settings while tasks load', { timeout: 30_000 }, () => {
  it('opens, with Sign out, while a page that reads every task waits', async () => {
    const { org } = await bootLoading()
    await back(`/app/${org}/settings/account`)
    await waitFor(
      () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out'),
      'Sign out',
    )
    expect(document.querySelector('[data-tasks-loading-view]')).toBeNull()
    await back(`/app/${org}/settings/org-labels`)
    await waitFor(() => document.querySelector('[data-tasks-loading-view]'), 'the waiting page')
    await arrive()
    await waitFor(
      () =>
        !document.querySelector('[data-tasks-loading-view]') &&
        document.querySelector('[data-settings-page="org-labels"]'),
      'the Labels page',
    )
  })
})
