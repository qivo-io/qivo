// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { plannerFixture } from './store/plannerFixture.setup'
import { taskRow } from './views/boardFixture.setup'

/* The main pages stay loaded while the person moves between them, on App
   and the real store (lib/keptPages.ts): each page opened stays in the
   page, hidden, and shows again as the same elements; Settings goes when
   the person leaves it; and once the person leaves the app alone for 30
   minutes, every kept page but the one shown goes. */

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

const MINUTE = 60_000
// the task comment threads the store subscribed to, and whether each stopped
const threads: { stopped: boolean }[] = []
const realTimeout = globalThis.setTimeout

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // the clock jumps when a test says so, and runs on its own meanwhile
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
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
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Waits for `find` to answer, through lazy modules that can take seconds
    to load on a busy worker. It polls on the real clock: the faked one
    runs only when a test moves it. */
async function waitFor<T>(find: () => T | null | undefined | false, what: string) {
  const end = performance.now() + 10_000
  for (;;) {
    const found = await act(async () => find())
    if (found) return found
    if (performance.now() > end) throw new Error(`missing ${what}`)
    await new Promise((resolve) => realTimeout(resolve, 20))
  }
}

/** Boots App on the fixture workspace. Answers the organization's slug. */
async function boot() {
  vi.resetModules()
  const snap = plannerFixture()
  for (let n = 1; n <= 3; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
  snap.issues[0].title = 'Write the release notes'
  threads.length = 0
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'snapshot:commentThread') {
      next({ comments: [], earlier: false, events: [] })
      const thread = { stopped: false }
      threads.push(thread)
      return () => {
        thread.stopped = true
      }
    }
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  await store.initStore()
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
  return location.pathname.split('/')[2]
}

/** Goes to `address` as Back or Forward would. */
const go = (address: string) =>
  act(async () => {
    history.pushState(null, '', address)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

/** The container of the shown main page `page`, once its content is in. */
const shownPage = (page: string) =>
  waitFor(() => {
    const box = document.querySelector<HTMLElement>(`[data-workspace-view="${page}"]`)
    return box?.querySelector('[data-kept-content]')?.firstElementChild && box
  }, `the shown ${page}`)

const hiddenPages = () =>
  [...document.querySelectorAll<HTMLElement>('main [data-hidden-view]')].map(
    (box) => box.dataset.hiddenView,
  )

describe('the main pages kept while the person uses the app', { timeout: 30_000 }, () => {
  it('keeps each page opened, unloads Settings, and releases the hidden pages after 30 idle minutes', async () => {
    const org = await boot()
    await go(`/app/${org}/board/all`)
    const board = await shownPage('kanban')
    await go(`/app/${org}/overview/all`)
    const overview = await shownPage('overview')
    await go(`/app/${org}/roadmap/all`)
    await shownPage('roadmap')
    await go(`/app/${org}/inbox`)
    const inbox = await shownPage('inbox')
    expect(hiddenPages().sort()).toEqual(['kanban', 'overview', 'roadmap'])

    // back to a kept page: the same elements show again
    await go(`/app/${org}/board/all`)
    expect(await shownPage('kanban')).toBe(board)
    expect(board.isConnected && overview.isConnected && inbox.isConnected).toBe(true)

    // Settings shows over the kept pages, and goes when the person leaves
    await go(`/app/${org}/settings/account`)
    await waitFor(() => document.querySelector('[data-settings-page]'), 'Settings')
    expect(hiddenPages().sort()).toEqual(['inbox', 'kanban', 'overview', 'roadmap'])
    const back = await waitFor(
      () => document.querySelector<HTMLElement>('[data-settings-back]'),
      "Settings' way back",
    )
    await act(async () => back.click())
    expect(await shownPage('kanban')).toBe(board)
    expect(document.querySelector('[data-settings-page]')).toBeNull()

    // input within the 30 minutes keeps every page
    await act(async () => vi.advanceTimersByTime(29 * MINUTE))
    window.dispatchEvent(new PointerEvent('pointermove'))
    await act(async () => vi.advanceTimersByTime(29 * MINUTE))
    expect(hiddenPages().sort()).toEqual(['inbox', 'overview', 'roadmap'])

    // 30 minutes without input: only the page on screen stays
    await act(async () => vi.advanceTimersByTime(MINUTE))
    await waitFor(() => !overview.isConnected && !inbox.isConnected, 'the released pages gone')
    expect(hiddenPages()).toEqual([])
    expect(board.isConnected).toBe(true)

    // a released page opens anew, as on a first visit
    await go(`/app/${org}/overview/all`)
    const again = await shownPage('overview')
    expect(again).not.toBe(overview)
    expect(hiddenPages()).toEqual(['kanban'])
  })

  it('mounts the pages of a new scope anew, and keeps the Inbox', async () => {
    const org = await boot()
    await go(`/app/${org}/inbox`)
    const inbox = await shownPage('inbox')
    await go(`/app/${org}/board/all`)
    const board = await shownPage('kanban')
    await go(`/app/${org}/board/mine`)
    const mine = await shownPage('kanban')
    expect(mine).not.toBe(board)
    await waitFor(() => !board.isConnected, "the old scope's Board gone")
    await go(`/app/${org}/inbox`)
    expect(await shownPage('inbox')).toBe(inbox)
  })

  it('hides the Inbox without its task pane, and keeps the task window that opens over the Board', async () => {
    const org = await boot()
    await go(`/app/${org}/inbox/tasks/qn-1`)
    const inbox = await shownPage('inbox')
    await waitFor(() => inbox.textContent?.includes('Write the release notes'), 'the task pane')
    await waitFor(() => threads.length > 0, "the task's comments")
    // the task opens over the Board, as the pane's Show on board does
    await go(`/app/${org}/board/tasks/qn-1`)
    await shownPage('kanban')
    expect(inbox.dataset.hiddenView).toBe('inbox')
    expect(inbox.textContent).not.toContain('Write the release notes')
    await waitFor(
      () =>
        document.querySelector('[role="dialog"]')?.textContent?.includes('Write the release notes'),
      'the task window',
    )
    expect(threads.at(-1)?.stopped).toBe(false)
  })
})
