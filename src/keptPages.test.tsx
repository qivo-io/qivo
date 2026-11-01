// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import { plannerFixture, underProgram } from './store/plannerFixture.setup'
import { taskRow } from './views/boardFixture.setup'

/* The main pages stay loaded while the person moves between them, on App
   and the real store (lib/keptPages.ts): each page opened stays in the
   page, hidden, and shows again as the same elements; Settings goes when
   the person leaves it; and once the person leaves the app alone for 30
   minutes, every kept page but the one shown goes. */

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
  Element.prototype.getAnimations = () => []
  // jsdom does not scroll: a scroll to a place sets the element's offset
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollTop = options.top ?? 0
  }
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

type Snapshot = ReturnType<typeof plannerFixture>

/** Boots App on the fixture workspace, with what `prepare` adds, and the
    task window from `held` on still to load. Answers the organization's
    slug. */
async function boot(prepare: (snap: Snapshot) => void = () => {}, held: string | null = null) {
  vi.resetModules()
  const snap = plannerFixture()
  for (let n = 1; n <= 3; n++) snap.issues.push(taskRow(snap, `t${n}`, 'todo', n))
  snap.issues[0].title = 'Write the release notes'
  prepare(snap)
  threads.length = 0
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') next(structuredClone(snap))
    else if (name === 'tasks:board') next(boardStandIn(snap, args as BoardArgs))
    else if (name === 'teamSync:lastComments')
      next({ rows: [{ issue_id: 't1', at: '2026-09-10T08:00:00.000Z' }], complete: true })
    else if (name === 'snapshot:threadComments') {
      next({ comments: [], earlier: false })
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
  double.live?.holdWindow(held)
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

  it('keeps Team sync through its sitting, where it was, and opens it anew after Done', async () => {
    const org = await boot()
    const { P } = await import('./store/planner')
    const me = P.CURRENT_USER
    await go(`/app/${org}/sync/p/1/people/${me}`)
    const sync = await shownPage('sync')
    const page = await waitFor(
      () => sync.querySelector<HTMLElement>('[data-sync-page]'),
      'the Team sync page',
    )
    // the tasks wait under Later, which opens for this sitting
    const later = await waitFor(
      () => sync.querySelector<HTMLElement>(`[data-sync-later="${me}"]`),
      'Later',
    )
    await act(async () => later.click())
    const tick = await waitFor(
      () => sync.querySelector<HTMLElement>('[data-sync-tick="QN-1"]'),
      "a task's review tick",
    )
    await act(async () => tick.click())
    expect(tick.dataset.syncReviewed).toBe('1')
    page.scrollTop = 120
    await waitFor(() => P.lastComments.size > 0, 'the comment marks')

    // a jump to the Board keeps the page; its marks wait for a new answer
    await go(`/app/${org}/board/all`)
    await shownPage('kanban')
    expect(sync.dataset.hiddenView).toBe('sync')
    expect(P.lastComments.size).toBe(0)
    // the sidebar's Team sync goes back to the same page, where it was
    const nav = await waitFor(
      () => document.querySelector<HTMLElement>('[data-sync-nav]'),
      "the sidebar's Team sync",
    )
    await act(async () => nav.click())
    expect(await shownPage('sync')).toBe(sync)
    expect(location.pathname).toContain(`/people/${me}`)
    expect(page.scrollTop).toBe(120)
    expect(tick.dataset.syncReviewed).toBe('1')

    // Done on the last step ends the sitting
    for (;;) {
      const next = await waitFor(
        () => sync.querySelector<HTMLElement>('[data-sync-next]'),
        'Next or Done',
      )
      const done = next.textContent?.includes('Done')
      await act(async () => next.click())
      if (done) break
    }
    await waitFor(() => !sync.isConnected, 'the ended sitting gone')
    await act(async () => nav.click())
    const again = await shownPage('sync')
    expect(again).not.toBe(sync)
    expect(location.pathname).not.toContain('/people/')
    await go(`/app/${org}/sync/p/1/people/${me}`)
    await waitFor(() => again.querySelector(`[data-sync-later="${me}"]`), 'Later again')
    expect(again.querySelector('[data-sync-tick]')).toBeNull()
    await act(async () => again.querySelector<HTMLElement>(`[data-sync-later="${me}"]`)?.click())
    const fresh = await waitFor(
      () => again.querySelector<HTMLElement>('[data-sync-tick="QN-1"]'),
      "the new sitting's review tick",
    )
    expect(fresh.dataset.syncReviewed).toBe('0')
  })

  it("opens an all-project sync row's Board jump on the task's sub-project, and its Roadmap jump on All projects", async () => {
    // the fixture's project as a sub-project (p/1) of a top-level one
    const org = await boot((snap) => void underProgram(snap))
    const { P } = await import('./store/planner')
    const me = P.CURRENT_USER
    const later = async () => {
      await go(`/app/${org}/sync/all/people/${me}`)
      const sync = await shownPage('sync')
      const open = await waitFor(
        () => sync.querySelector<HTMLElement>(`[data-sync-later="${me}"]`),
        'Later',
      )
      // Later stays open while the sitting is kept
      if (!sync.querySelector('[data-sync-board="QN-1"]')) await act(async () => open.click())
      return sync
    }
    let sync = await later()
    const roadmap = await waitFor(
      () => sync.querySelector<HTMLElement>('[data-sync-roadmap="QN-1"]'),
      'the Roadmap jump',
    )
    await act(async () => roadmap.click())
    await shownPage('roadmap')
    expect(location.pathname).toBe('/app/~/roadmap/all')
    sync = await later()
    const board = await waitFor(
      () => sync.querySelector<HTMLElement>('[data-sync-board="QN-1"]'),
      'the Board jump',
    )
    await act(async () => board.click())
    await shownPage('kanban')
    // the project form of a task's address, not All projects' (board/all)
    expect(location.pathname).toBe(`/app/${org}/board/tasks/qn-1`)
    await waitFor(
      () =>
        document
          .querySelector('[data-workspace-view="kanban"] [data-board-root]')
          ?.getAttribute('data-board-state') === 'ok',
      "the sub-project's Board",
    )
    expect(
      document.querySelector('[data-workspace-view="kanban"] [data-card="QN-1"]'),
    ).not.toBeNull()
  })

  it('keeps a saved All projects scope under an Inbox task address, at boot, on Back or Forward and for a task still to load', async () => {
    let key = ''
    // 12,800 task numbers make 64 task windows; the last, from fc000000,
    // holds QN-5 back
    const org = await boot((snap) => {
      underProgram(snap)
      snap.orgs[0].next_issue_num = 64 * 200
      snap.issues.push(
        taskRow(snap, '01000000-early', 'todo', 4),
        taskRow(snap, 'fd000000-late', 'todo', 5),
      )
      // a Board on All projects, saved before the page loaded
      key = `planner.ui.v1:${snap.myProfileIds[0]}`
      localStorage.setItem(key, JSON.stringify({ scope: 'all', view: 'kanban' }))
      history.replaceState(null, '', '/app/testbed/inbox/tasks/qn-4')
    }, 'fc000000')
    try {
      const { P } = await import('./store/planner')
      await shownPage('inbox')
      expect(P.loadUI()).toMatchObject({ scope: 'all', view: 'kanban' })
      await go(`/app/${org}/board/all`)
      await shownPage('kanban')
      await go(`/app/${org}/inbox/tasks/qn-4`)
      await shownPage('inbox')
      expect(P.loadUI()).toMatchObject({ scope: 'all', view: 'kanban' })
      // a task still to load, which the app opens once it arrived
      await go(`/app/${org}/inbox/tasks/qn-5`)
      await act(async () => {
        double.live?.holdWindow(null)
        await new Promise((resolve) => realTimeout(resolve, 0))
      })
      await waitFor(() => P.stillLoading() === null, 'every task')
      await waitFor(() => location.pathname.endsWith('/inbox/tasks/qn-5'), 'the task that arrived')
      expect(P.loadUI()).toMatchObject({ scope: 'all', view: 'kanban' })
    } finally {
      localStorage.removeItem(key)
    }
  })

  it('shows the Inbox again with an empty pane, holding nothing of the item picked before', async () => {
    const org = await boot((snap) => {
      const message = (id: string, issue: string, title: string) => ({
        id,
        org_id: snap.orgs[0].id,
        recipient_id: snap.profiles[0].id,
        issue_id: issue,
        issue_title: title,
        kind: 'comment' as const,
        detail: 'New comment',
        created_at: '2026-09-14T08:30:00.000Z',
      })
      snap.messages.push(message('m1', 't1', 'Write the release notes'))
      // an item whose task this person cannot open
      snap.messages.push(message('m2', 'gone', 'Plan the offsite'))
    })
    await go(`/app/${org}/inbox`)
    const inbox = await shownPage('inbox')
    const pick = async (id: string) => {
      const row = await waitFor(
        () => inbox.querySelector<HTMLElement>(`[data-message="${id}"] button`),
        `the item ${id}`,
      )
      await act(async () => row.click())
    }
    await pick('gone')
    expect(inbox.textContent).toContain('archived or unavailable')
    await go(`/app/${org}/board/all`)
    await shownPage('kanban')
    await go(`/app/${org}/inbox`)
    expect(await shownPage('inbox')).toBe(inbox)
    expect(inbox.textContent).not.toContain('archived or unavailable')

    // the item read as it opened is not new when its task opens again
    await pick('t1')
    await waitFor(() => inbox.querySelector('[data-unread-divider]'), "the item's new part")
    await go(`/app/${org}/board/tasks/qn-1`)
    await shownPage('kanban')
    await go(`/app/${org}/inbox/tasks/qn-1`)
    await shownPage('inbox')
    await waitFor(() => inbox.textContent?.includes('Write the release notes'), 'the task pane')
    expect(inbox.querySelector('[data-unread-divider]')).toBeNull()
  })

  it('shows a page kept while the tasks loaded as itself once they have', async () => {
    // 12,800 task numbers make 64 task windows; the last starts at fc000000
    const org = await boot((snap) => {
      snap.orgs[0].next_issue_num = 64 * 200
    }, 'fc000000')
    await go(`/app/${org}/overview/all`)
    const overview = await shownPage('overview')
    expect(overview.textContent).toContain('opens once every task has loaded')
    await go(`/app/${org}/inbox`)
    await shownPage('inbox')
    await act(async () => {
      double.live?.holdWindow(null)
      await new Promise((resolve) => realTimeout(resolve, 0))
    })
    const { P } = await import('./store/planner')
    expect(P.stillLoading()).toBeNull()
    // the Overview's code, which the app loads in the background
    await (await import('./lib/workspaceChunks')).loadOverview()
    // the commit that shows it holds no notice, before any frame paints
    vi.stubGlobal('requestAnimationFrame', () => 0)
    await go(`/app/${org}/overview/all`)
    expect(await shownPage('overview')).toBe(overview)
    expect(overview.textContent).not.toContain('opens once every task has loaded')
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

  it("opens the next Inbox task in the pane after the person left the Inbox from the task's pop-out", async () => {
    const org = await boot()
    await go(`/app/${org}/inbox/tasks/qn-1`)
    const inbox = await shownPage('inbox')
    const popOut = await waitFor(
      () => inbox.querySelector<HTMLElement>('[data-task-popout]'),
      'the pop-out button',
    )
    await act(async () => popOut.click())
    await waitFor(() => document.querySelector('[role="dialog"]'), 'the popped-out window')
    await go(`/app/${org}/board/tasks/qn-1`)
    await shownPage('kanban')
    await go(`/app/${org}/inbox/tasks/qn-2`)
    expect(await shownPage('inbox')).toBe(inbox)
    await waitFor(() => inbox.querySelector('[data-task-popout]'), 'the next task in the pane')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
