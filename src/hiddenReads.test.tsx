// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './components/ui/tooltip'
import { subscribersStandIn } from './store/followerStandIn.setup'
import { WHOLE } from './store/guard/liveDouble.setup'
import type { NotificationsStandIn } from './store/notificationsStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './store/plannerFixture.setup'

/* A hidden page holds only the reads the register in lib/viewVisibility.ts
   keeps running. Each case mounts what the app shows at once: the
   appearance provider, the read-only banner, a task window with its
   details and its history under All, its subscriber popover open, the
   desktop alert leader on a page that can notify, and one Settings page,
   since Settings shows one page at a time. It hides the page, and every
   subscription still open, on the live transport and on convex.onUpdate,
   must be one the register names, and every one of those the case mounts
   must still run; it shows the page again, and the view reads come back.
   Everyday values: one organization, one task, a few people. */

const network = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  onUpdate: vi.fn(),
  connectionState: vi.fn(() => ({ isWebSocketConnected: true, inflightMutations: 0 })),
}))
type Double = ReturnType<typeof import('./store/guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
vi.mock('./lib/convex', async () => {
  const { liveOver } = await import('./store/guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('./lib/auth', () => ({
  AUTH_STORAGE_PREFIX: 'better-auth',
  armConvexAuth: async () => true,
  onSignedIn: () => () => {},
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
const demo = vi.hoisted(() => ({ on: false }))
vi.mock('./lib/demoMode', async (original) => ({
  ...(await original<typeof import('./lib/demoMode')>()),
  get DEMO_MODE() {
    return demo.on
  },
}))

/** A page Notification the person allowed, so the leader runs. */
class PageNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = async () => PageNotification.permission
  onclick: (() => void) | null = null
  close() {}
}

/* The reads the register keeps running while hidden, by query name. */
const KEPT = new Set([
  'workspace:root',
  'inbox:summary',
  'inbox:feed',
  'notifications:settings',
  'billing:status',
  'appearance:get',
])

const NOW = '2026-09-14T08:00:00.000Z'
const DETAILS = {
  enabled: true,
  configured: true,
  plan: null,
  plan_assigned: false,
  can_assign_plan: false,
  can_grant_complimentary: false,
  status: 'active',
  writable: true,
  active_users: 1,
  inactive_users: 0,
  invited_users_with_own_billing: 0,
  billable_users: 1,
  billed_seats: 1,
  next_seats: 1,
  next_seat_amount_cents: 1000,
  current_period_start: '2026-09-01T00:00:00.000Z',
  current_period_end: '2099-10-01T00:00:00.000Z',
  complimentary_until: null,
  cancel_at_period_end: false,
  checkout_available: false,
  portal_available: false,
  cancel_available: false,
  checkout_due_at: null,
  last_export_at: null,
  deletion: null,
  sync_pending: false,
  sync_error: null,
}
const EMPTY_LIST = { state: 'ready', rows: [], next: null, stopped: false }

let snap: Snapshot
let org: string
let stand: NotificationsStandIn
let floor = 0
// the subscriptions open through the client's onUpdate, by query name
let direct: Map<symbol, string>
let container: HTMLDivElement
let root: Root
let store: typeof import('./store/planner')

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
/** Sets the page's visibility, as the browser does when a tab hides. */
const setVisibility = async (value: 'visible' | 'hidden') => {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await settle()
}
/** Every query a subscription holds now, on either path. */
const open = () =>
  [...new Set([...(double.live?.opened(floor).map((w) => w.name) ?? []), ...direct.values()])]
    .filter((name) => name !== WHOLE)
    .sort()

beforeEach(async () => {
  vi.resetModules()
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
  vi.stubGlobal('Notification', PageNotification)
  Element.prototype.scrollIntoView = () => {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
  window.showToast = vi.fn()
  snap = underProgram(plannerFixture())
  org = snap.orgs[0].id
  snap.issues.push({
    id: 'task-a',
    org_id: org,
    project_id: snap.projects[0].id,
    num: 5,
    title: 'Run the soak test',
    description: '',
    status: 'progress',
    priority: 'medium',
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })
  direct = new Map()
  const { createNotificationsStandIn } = await import('./store/notificationsStandIn.setup')
  stand = createNotificationsStandIn()
  network.query.mockImplementation(async (ref) => {
    const name = getFunctionName(ref)
    if (name === 'billing:storageProjects' || name === 'billing:apiAccounts') return EMPTY_LIST
    return null
  })
  network.mutation.mockImplementation(async (ref, args) => {
    const name = getFunctionName(ref)
    return stand.answers(name) ? stand.answer(name, args) : null
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    const id = Symbol(name)
    direct.set(id, name)
    const close = () => {
      direct.delete(id)
    }
    if (name === WHOLE) next(structuredClone(snap))
    else if (name === 'notifications:settings') {
      const stop = stand.watch(next, fail, {})
      return () => {
        close()
        stop()
      }
    } else if (name === 'issues:subscribers')
      next(
        subscribersStandIn(snap, args as { org_id: string; issue_id: string }, { canManage: true }),
      )
    else if (name === 'billing:details') next(structuredClone(DETAILS))
    else if (name === 'billing:status') next({ writable: true })
    else if (name === 'orgRemovals:state')
      next({ slug: 'testbed', last_export_at: null, deletion: null })
    else if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    else if (name === 'snapshot:threadHistory') next({ events: [], earlier: false, next: null })
    else next(null)
    return close
  })
  floor = double.live?.generation() ?? 0
  store = await import('./store/planner')
  await store.initStore()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  // the store's disposal stops its alert client and its timers
  demo.on = true
  store.disposeDemoStore()
  demo.on = false
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Renders the app's readers with Settings page `page` beside them, and
    opens the task's subscriber popover. */
async function mount(page: () => React.ReactNode) {
  const { AppearanceProvider } = await import('./AppearanceProvider')
  const { BillingNotice } = await import('./components/BillingNotice')
  const { IssueDetail } = await import('./panels/IssueDetail')
  const P = store.P
  const task = P.openTask('task-a', org, 5)
  await act(async () =>
    root.render(
      <AppearanceProvider accountId="test-account">
        <TooltipProvider>
          <BillingNotice
            orgId={org}
            orgName={P.org.name}
            admin={P.isAdmin()}
            onBilling={vi.fn()}
            onExport={vi.fn()}
          />
          <IssueDetail issueId={task} onClose={vi.fn()} onOpen={vi.fn()} />
          {page()}
        </TooltipProvider>
      </AppearanceProvider>,
    ),
  )
  await settle()
  // the window's history, as under All
  P.showHistory({}, true)
  await settle()
  await act(async () => document.querySelector<HTMLElement>('[data-task-subscribe]')?.click())
  await settle()
}

/* The task window's reads and the popover's, which every case mounts. */
const WINDOW = [
  'inbox:item',
  'issues:subscribers',
  'snapshot:threadComments',
  'snapshot:threadHistory',
  'taskWindow:attachments',
  'taskWindow:links',
  'taskWindow:task',
]

/** Hides the page and checks what stays open, then shows it again and
    checks that `reads` came back. */
async function hideAndShow(reads: readonly string[]) {
  for (const name of [...WINDOW, ...reads]) expect(open(), name).toContain(name)
  await setVisibility('hidden')
  const hidden = open()
  expect(hidden.filter((name) => !KEPT.has(name))).toEqual([])
  // every kept read the page mounts goes on
  expect(hidden).toEqual([...KEPT].sort())
  await setVisibility('visible')
  for (const name of [...WINDOW, ...reads]) expect(open(), name).toContain(name)
}

describe('a hidden page', () => {
  it('holds only the kept reads beside Billing', async () => {
    const { BillingSettings } = await import('./panels/BillingSettings')
    await mount(() => <BillingSettings setPage={vi.fn()} onViewCredentials={vi.fn()} />)
    await hideAndShow(['billing:details'])
  })

  it('holds only the kept reads beside Your preferences, Appearance and Notifications included', async () => {
    const { AccountPage } = await import('./panels/settings/AccountSettings')
    await mount(() => <AccountPage setPage={vi.fn()} />)
    // the page's own read of the delivery setting, beside the leader's
    expect(
      [...direct.values()].filter((name) => name === 'notifications:settings').length,
    ).toBeGreaterThan(0)
    await hideAndShow([])
  })

  it('holds only the kept reads beside Organization › General', async () => {
    const { OrgGeneralPage } = await import('./panels/settings/OrganizationSettings')
    await mount(() => <OrgGeneralPage setPage={vi.fn()} />)
    await hideAndShow(['orgRemovals:state', 'orgs:projectCreators'])
  })
})
