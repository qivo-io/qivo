// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { type BoardArgs, boardStandIn } from './store/boardStandIn.setup'
import type { ForcedInbox } from './store/inboxStandIn.setup'
import { plannerFixture } from './store/plannerFixture.setup'
import type { Row } from './store/rows'

/* The Inbox badge on App and the real store: the desktop top bar's Inbox
   tab and the phone's bottom Inbox tab show the server's unread summary
   (store/planner.ts P.inboxSummary, lib/inboxBadge.ts), which the live
   double answers from the server's messages through its stand-in
   (store/inboxStandIn.setup.ts), never the groups the workspace loaded.
   The server here holds more unread tasks than the workspace loaded, past
   the inbox part's cut, so the two always say different things. An emit
   of the Inbox's section alone repaints both badges. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('./store/guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
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

let container: HTMLDivElement
let root: Root
let phone = false

beforeEach(() => {
  phone = false
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  Element.prototype.getAnimations = () => []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === '(max-width: 760px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  double.live?.forceInbox(null)
  container.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The fixture's organization with `loaded` unread tasks the workspace's
    Inbox loaded, and `beyond` more the server holds past its cut. */
function fixture(loaded: number, beyond: number) {
  const snap = plannerFixture()
  const me = snap.profiles[0].id
  const messages: Row<'messages'>[] = []
  for (let n = 0; n < loaded + beyond; n++) {
    const id = `task-${String(n).padStart(2, '0')}`
    snap.issues.push({
      id,
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: n + 1,
      title: `Task ${n + 1}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: AT,
      updated_at: AT,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    messages.push({
      id: `message-${n}`,
      org_id: snap.orgs[0].id,
      recipient_id: me,
      issue_id: id,
      issue_title: `Task ${n + 1}`,
      kind: 'comment',
      detail: 'New comment',
      created_at: AT,
    })
  }
  snap.orgs[0].next_issue_num = loaded + beyond
  snap.messages = messages.slice(0, loaded)
  return { snap, beyondCut: messages.slice(loaded) }
}

/** Boots the real store on `server` and renders App, with the inbox reads
    answering `force` from the start. */
async function app(server: ReturnType<typeof fixture>, force?: ForcedInbox) {
  vi.resetModules()
  // All projects' Board, under the top bar
  history.replaceState(null, '', '/app/~/board/all')
  network.onUpdate.mockImplementation((ref, args, next) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole')
      next(structuredClone({ ...server.snap, beyondCut: server.beyondCut }))
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'tasks:board') next(boardStandIn(server.snap, args as BoardArgs))
    return () => {}
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  const store = await import('./store/planner')
  // vi.resetModules keeps the live double, and with it a state forced before
  double.live?.forceInbox(force ?? null)
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
  return store.P
}

/** The desktop Inbox tab's name and its chip's text and state, or nulls. */
function desktopBadge() {
  const tab = document.querySelector<HTMLElement>('[data-view-switch] [aria-label^="Inbox"]')
  if (!tab) throw new Error('missing the Inbox tab')
  const chip = tab.querySelector<HTMLElement>('[data-inbox-badge]')
  return {
    name: tab.getAttribute('aria-label'),
    chip: chip?.textContent ?? null,
    state: chip?.dataset.inboxBadgeState ?? null,
    refreshing: chip ? chip.dataset.refreshing !== undefined : false,
  }
}

/** The phone's Inbox tab badge's name and text, or nulls. */
function phoneBadge() {
  const tab = document.querySelector<HTMLElement>('[data-inbox-nav]')
  if (!tab) throw new Error('missing the phone Inbox tab')
  const badge = tab.querySelector<HTMLElement>('.mobile-unread-badge')
  return {
    name: badge?.getAttribute('aria-label') ?? null,
    chip: badge?.textContent ?? null,
    state: badge?.dataset.inboxBadgeState ?? null,
  }
}

const shows = (read: () => unknown, want: unknown) =>
  vi.waitFor(() => expect(read()).toEqual(want), { timeout: 10_000 })

describe('the Inbox badge', { timeout: 30_000 }, () => {
  it("counts the server's unread tasks, not the groups the workspace loaded", async () => {
    const P = await app(fixture(3, 9))
    await shows(desktopBadge, {
      name: 'Inbox, 12 unread',
      chip: '12',
      state: 'count',
      refreshing: false,
    })
    expect(P.unreadMessages).toBe(3)
  })

  it('shows 99+ for more than 99 and 12+ for an incomplete count, with their names', async () => {
    await app(fixture(3, 9), 'more')
    await shows(desktopBadge, {
      name: 'Inbox, more than 99 unread',
      chip: '99+',
      state: 'more',
      refreshing: false,
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(fixture(3, 9), 'incomplete')
    await shows(desktopBadge, {
      name: 'Inbox, at least 12 unread',
      chip: '12+',
      state: 'partial',
      refreshing: false,
    })
  })

  it('shows the ellipsis while it loads and after it failed, and nothing only for zero', async () => {
    const P = await app(fixture(3, 9), 'loading')
    await shows(desktopBadge, {
      name: 'Inbox, unread count loading',
      chip: '…',
      state: 'unknown',
      refreshing: false,
    })
    expect(P.unreadMessages).toBe(3)
    // an emit of the Inbox's section alone repaints the bar
    await act(async () => double.live?.forceInbox('failed'))
    await shows(desktopBadge, {
      name: 'Inbox, unread count unavailable',
      chip: '…',
      state: 'unknown',
      refreshing: false,
    })
    await act(async () => double.live?.forceInbox(null))
    await shows(desktopBadge, {
      name: 'Inbox, 12 unread',
      chip: '12',
      state: 'count',
      refreshing: false,
    })
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(fixture(0, 0))
    await shows(desktopBadge, { name: 'Inbox', chip: null, state: null, refreshing: false })
  })

  it("shows the same on the phone's Inbox tab, and nothing on the others", async () => {
    phone = true
    await app(fixture(3, 9))
    await shows(phoneBadge, { name: '12 unread', chip: '12', state: 'count' })
    expect(document.querySelectorAll('.mobile-unread-badge')).toHaveLength(1)
    await act(async () => double.live?.forceInbox('incomplete'))
    await shows(phoneBadge, { name: 'At least 12 unread', chip: '12+', state: 'partial' })
    await act(async () => double.live?.forceInbox('more'))
    await shows(phoneBadge, { name: 'More than 99 unread', chip: '99+', state: 'more' })
    await act(async () => double.live?.forceInbox('failed'))
    await shows(phoneBadge, { name: 'Unread count unavailable', chip: '…', state: 'unknown' })
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(fixture(3, 9), 'loading')
    await shows(phoneBadge, { name: 'Unread count loading', chip: '…', state: 'unknown' })
    await act(async () => root.unmount())
    root = createRoot(container)
    await app(fixture(0, 0))
    await shows(phoneBadge, { name: null, chip: null, state: null })
  })
})
