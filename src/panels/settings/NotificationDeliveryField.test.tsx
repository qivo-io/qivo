// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../components/ui/tooltip'
import { WHOLE } from '../../store/guard/liveDouble.setup'
import type {
  ForcedNotifications,
  NotificationsStandIn,
} from '../../store/notificationsStandIn.setup'
import { plannerFixture, type Snapshot } from '../../store/plannerFixture.setup'

/* Notification delivery on Settings › Your preferences › Notifications, on
   the real store, its live read answered by the notification stand-in
   (store/notificationsStandIn.setup.ts) as the server would, through the
   live double's onUpdate path. The field shows no choice as saved before
   the read answers, saves through setDelivery and lets the read own what
   shows, words a refusal as the server does, stops its read while the tab
   is hidden, and asks for no permission. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../../lib/convex', async () => ({
  convex: network,
  live: (await import('../../store/guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../../lib/auth', () => ({
  AUTH_STORAGE_PREFIX: 'better-auth',
  armConvexAuth: async () => true,
  onSignedIn: () => () => {},
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

let stand: NotificationsStandIn
let force: ForcedNotifications
let snap: Snapshot
// the settings watches open now, by who opened them
let watches: number
let saves: { args: Record<string, unknown>; answer: () => void; refuse: (e: unknown) => void }[]
let pages: {
  field: typeof import('./NotificationDeliveryField')
  account: typeof import('./AccountSettings')
  notify: typeof import('../../lib/notify')
  liveView: typeof import('../../lib/liveView')
}
let container: HTMLDivElement
let root: Root

/** The page's Notification, whose permission the case sets. */
const PageNotification = {
  permission: 'default' as NotificationPermission,
  requestPermission: vi.fn(async () => PageNotification.permission),
}

async function load({ delivery = 'recent' }: { delivery?: 'recent' | 'all' } = {}) {
  vi.resetModules()
  snap = plannerFixture()
  force = {}
  watches = 0
  saves = []
  const { createNotificationsStandIn } = await import('../../store/notificationsStandIn.setup')
  stand = createNotificationsStandIn(undefined, delivery)
  // the store's and the other sections' one-shot reads find nothing
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'notifications:settings') {
      watches += 1
      const stop = stand.watch(next, fail, force)
      return () => {
        watches -= 1
        stop()
      }
    }
    if (name === WHOLE) next(structuredClone(snap))
    return () => {}
  })
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name !== 'notifications:setDelivery') return Promise.resolve(null)
    // the server answers when the case says, after its watches heard it
    return new Promise((resolve, reject) => {
      saves.push({
        args,
        answer: () => {
          try {
            resolve(stand.answer(name, args, force))
          } catch (e) {
            reject(e)
          }
        },
        refuse: reject,
      })
    })
  })
  const store = await import('../../store/planner')
  await store.initStore()
  pages = {
    field: await import('./NotificationDeliveryField'),
    account: await import('./AccountSettings'),
    notify: await import('../../lib/notify'),
    liveView: await import('../../lib/liveView'),
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
  PageNotification.permission = 'default'
  PageNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', PageNotification)
  window.showToast = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  window.qivoDesktop = undefined
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

async function render(node: () => React.ReactNode) {
  await act(async () => root.render(<TooltipProvider>{node()}</TooltipProvider>))
}
const field = () => <pages.field.NotificationDeliveryField />
const select = () => container.querySelector<HTMLSelectElement>('[data-notification-delivery]')
const state = () =>
  container
    .querySelector('[data-notification-delivery-state]')
    ?.getAttribute('data-notification-delivery-state')
const text = (selector: string) => container.querySelector(selector)?.textContent
async function choose(value: string) {
  await act(async () => {
    const s = select()
    if (!s) throw new Error('no select')
    s.value = value
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('Notification delivery', () => {
  it('says it is loading until the server answers, showing no choice as saved', async () => {
    await load()
    force.settings = 'loading'
    await render(field)
    expect(state()).toBe('loading')
    expect(text('[role="status"]')).toBe('Loading notification delivery…')
    expect(select()).toBeNull()
    expect(container.textContent).not.toContain('Most recently active session')
  })

  it('shows the saved mode with its hint, and the line for this browser', async () => {
    await load()
    await render(field)
    expect(state()).toBe('ready')
    expect(select()?.value).toBe('recent')
    expect(select()?.getAttribute('aria-label')).toBe('Notification delivery')
    expect(container.textContent).toContain(
      'Qivo shows desktop alerts only in the browser or desktop app you used last that can show them. When it closes or goes offline, the next one takes over.',
    )
    expect(container.textContent).toContain(
      'This does not turn alerts on. Turn them on with Enable notifications in Inbox, or with Show notifications in the desktop app.',
    )
    expect(text('[data-notification-capability]')).toBe("This browser can't show alerts.")
    await load({ delivery: 'all' })
    await render(field)
    expect(select()?.value).toBe('all')
    expect(container.textContent).toContain(
      'Qivo shows desktop alerts in every browser and desktop app that can show them, once in each.',
    )
  })

  it('saves a choice once, waits with the select disabled, then shows the read’s value', async () => {
    await load()
    await render(field)
    await choose('all')
    expect(saves.map((s) => s.args)).toEqual([{ delivery: 'all' }])
    expect(select()?.disabled).toBe(true)
    expect(select()?.value).toBe('all')
    expect(state()).toBe('saving')
    await act(async () => saves[0].answer())
    expect(select()?.disabled).toBe(false)
    expect(select()?.value).toBe('all')
    expect(text('[data-notification-delivery-saved]')).toBe('Notification delivery saved.')
    // another tab switches back, and its delivery replaces what shows
    await act(async () => {
      stand.answer('notifications:setDelivery', { delivery: 'recent' })
    })
    expect(select()?.value).toBe('recent')
    expect(saves).toHaveLength(1)
  })

  it('returns the select and words a refusal as the server does, the demo’s limit included', async () => {
    await load()
    await render(field)
    force.setDelivery = 'demo-limit'
    await choose('all')
    await act(async () => saves[0].answer())
    expect(select()?.value).toBe('recent')
    expect(text('[data-notification-delivery-error]')).toBe(
      'Your demo has reached its change limit. Try again later.',
    )
    expect(
      container.querySelector('[data-notification-delivery-error]')?.getAttribute('role'),
    ).toBe('alert')
  })

  it('says it could not load, and Try again reads again', async () => {
    await load()
    force.settings = 'failed'
    await render(field)
    expect(state()).toBe('unavailable')
    expect(container.textContent).toContain("Notification delivery couldn't be loaded.")
    expect(select()).toBeNull()
    force.settings = undefined
    const again = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again',
    )
    await act(async () => again?.click())
    expect(select()?.value).toBe('recent')
  })

  it('follows this browser’s capability and asks for no permission', async () => {
    await load()
    await render(field)
    expect(text('[data-notification-capability]')).toBe("This browser can't show alerts.")
    PageNotification.permission = 'granted'
    await act(async () => pages.notify.noteCapabilityChange())
    expect(text('[data-notification-capability]')).toBe('This browser can show alerts.')
    await choose('all')
    await act(async () => saves[0].answer())
    expect(PageNotification.requestPermission).not.toHaveBeenCalled()
  })

  it('in the desktop app, names its switch and changes no local switch', async () => {
    const update = vi.fn()
    window.qivoDesktop = {
      notifications: { supported: true, permission: 'denied', currentPermission: () => 'denied' },
      settings: { get: vi.fn(), update },
    } as unknown as QivoDesktopBridge
    await load()
    await render(field)
    expect(text('[data-notification-capability]')).toBe(
      'Show notifications is off in this desktop app.',
    )
    expect(container.textContent).toContain(
      'Turn them on with Show notifications in Settings → User account → Desktop app.',
    )
    await choose('all')
    await act(async () => saves[0].answer())
    expect(update).not.toHaveBeenCalled()
  })

  it('stops its read while the tab is hidden, while the leader’s watch goes on, and marks the held value refreshing on return', async () => {
    await load()
    // the leader's own watch of the same query, outside the gate
    const stopLeader = pages.liveView.watchLive(
      (await import('../../../convex/_generated/api')).api.notifications.settings,
      {},
      () => {},
    )
    await render(field)
    expect(watches).toBe(2)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(watches).toBe(1)
    // back in view the held value shows refreshing until the read answers
    force.settings = 'loading'
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(state()).toBe('refreshing')
    expect(select()?.value).toBe('recent')
    expect(select()?.disabled).toBe(true)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    stopLeader()
  })
})

describe('the Notifications section', () => {
  it('lists Notifications on a phone and opens it as its own page', async () => {
    await load()
    const setPage = vi.fn()
    await render(() => <pages.account.AccountPage narrow setPage={setPage} />)
    const rows = [...container.querySelectorAll('[data-settings-account-section]')].map((r) =>
      r.getAttribute('data-settings-account-section'),
    )
    expect(rows).toEqual(['profile', 'appearance', 'notifications', 'inbox', 'mcp'])
    const row = container.querySelector<HTMLButtonElement>(
      '[data-settings-account-section="notifications"]',
    )
    expect(row?.textContent).toContain('Where desktop alerts appear')
    await act(async () => row?.click())
    expect(setPage).toHaveBeenCalledWith('account-notifications')
    await render(() => (
      <pages.account.AccountPage narrow section="notifications" setPage={setPage} />
    ))
    expect(select()?.value).toBe('recent')
    expect(container.querySelector('[data-appearance-settings]')).toBeNull()
  })

  it('shows the section between Appearance and Inbox at desktop width', async () => {
    await load()
    await render(() => <pages.account.AccountPage setPage={vi.fn()} />)
    const headings = [...container.querySelectorAll('.settings-section')].map(
      (s) => s.querySelector(':scope > legend')?.textContent ?? '',
    )
    const at = (name: string) => headings.findIndex((h) => h.includes(name))
    expect(at('Appearance')).toBeGreaterThanOrEqual(0)
    expect(at('Notifications')).toBe(at('Appearance') + 1)
    expect(at('Inbox')).toBe(at('Notifications') + 1)
  })
})
