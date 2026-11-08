import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The desktop alerts on the real store over the live double
   (store/planner.ts startAlerts, lib/notificationFeed.ts): the store watches
   the Inbox feed only on a page that can notify, with the floor its client
   holds, outside the visibility gate, and watches it again on a fresh
   registry; it raises an alert only for what the session functions'
   stand-in grants (store/notificationsStandIn.setup.ts), opens the Inbox
   on a click and writes nothing for it, and stops at the demo's disposal.
   The server's own rules, its floors, targets and handoffs, are
   convex/tests/notificationFeedClient.test.ts's. The feed's floor is the
   safeguard of the stored messages of a task that comes back into view or
   a restore brings back: they raise nothing unless under ten minutes old.
   Times are the real clock's, as the client reads Date.now(). */

const network = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  onUpdate: vi.fn(),
  connectionState: vi.fn(),
}))
type Double = ReturnType<typeof import('./guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
// every query the store watches on the live transport, by name and arguments
const watched = vi.hoisted(() => [] as { name: string; args: Record<string, unknown> }[])
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  const { getFunctionName: nameOf } = await import('convex/server')
  double.live = liveOver(network)
  const watch = double.live.watch
  double.live.watch = (ref, args) => {
    watched.push({ name: nameOf(ref), args: args as Record<string, unknown> })
    return watch(ref, args)
  }
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))
const demo = vi.hoisted(() => ({ on: false }))
vi.mock('../lib/demoMode', async (original) => {
  const real = await original<typeof import('../lib/demoMode')>()
  return {
    ...real,
    get DEMO_MODE() {
      return demo.on
    },
  }
})

const MINUTE = 60_000
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A page Notification that records what it showed. */
class PageNotification {
  static permission: NotificationPermission = 'granted'
  static shown: PageNotification[] = []
  onclick: (() => void) | null = null
  constructor(
    readonly title: string,
    readonly options: { body: string; tag: string },
  ) {
    PageNotification.shown.push(this)
  }
  close() {}
}

describe('desktop alerts in the store', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let publish: (snap: Snapshot) => void
  let stand: import('./notificationsStandIn.setup').NotificationsStandIn
  let online: boolean
  let sentNames: string[]

  /** The task `id` of the fixture's project. */
  const task = (id: string): Snapshot['issues'][number] => ({
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num: snapshot.issues.length + 1,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })

  /** An unread message to the signed-in person about task `issue`, made
      `ago` ms before now, of `kind`. */
  const message = (
    id: string,
    issue: string,
    ago: number,
    kind: 'mention' | 'change' = 'mention',
  ) => ({
    id,
    org_id: snapshot.orgs[0].id,
    recipient_id: snapshot.profiles[0].id,
    actor_id: snapshot.profiles[0].id,
    issue_id: issue,
    issue_title: `Task ${issue}`,
    kind,
    detail: 'Look at this',
    created_at: new Date(Date.now() - ago).toISOString(),
  })

  /** The tags of the alerts the page showed. */
  const tags = () => (globalThis.window.__qivoNotes ?? []).map((n) => n.tag)
  /** The floors the store watched the feed with. */
  const feedWatches = () => watched.filter((w) => w.name === 'inbox:feed').map((w) => w.args.after)
  const settle = async () => {
    for (let i = 0; i < 6; i++) await tick()
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    watched.length = 0
    PageNotification.permission = 'granted'
    PageNotification.shown = []
    online = true
    sentNames = []
    vi.stubGlobal('window', {
      showToast: vi.fn(),
      setTimeout,
      clearTimeout,
      focus: () => {},
      Notification: PageNotification,
    })
    vi.stubGlobal('Notification', PageNotification)
    snapshot = plannerFixture()
    snapshot.issues.push(task('a'))
    network.query.mockResolvedValue(null)
    network.connectionState.mockImplementation(() => ({
      isWebSocketConnected: online,
      inflightMutations: 0,
    }))
    const { createNotificationsStandIn } = await import('./notificationsStandIn.setup')
    stand = createNotificationsStandIn()
    network.mutation.mockImplementation(async (ref, args) => {
      const name = getFunctionName(ref)
      sentNames.push(name)
      if (stand.answers(name)) return stand.answer(name, args)
      return null
    })
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        publish = (snap) => receive(structuredClone(snap))
        publish(snapshot)
      }
      return () => {}
    })
    store = await import('./planner')
  })

  afterEach(() => {
    // the store's disposal stops its alert client and its timers, so none
    // runs on into the next case
    demo.on = true
    store.disposeDemoStore()
    demo.on = false
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const boot = async () => {
    await store.initStore()
    await settle()
  }

  it('runs no beat, feed or claim on a page that cannot notify', async () => {
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.stubGlobal('Notification', undefined)
    snapshot.messages.push(message('m1', 'a', 1000))
    await boot()
    expect(store.P.loaded).toBe(true)
    expect(feedWatches()).toEqual([])
    expect(sentNames.filter((n) => n.startsWith('notifications:'))).toEqual([])
  })

  it('takes a baseline from the first answer, then alerts what the server grants, and opens the Inbox on a click', async () => {
    snapshot.messages.push(message('stored', 'a', 2 * MINUTE))
    const opened = vi.fn()
    await boot()
    store.P.setInboxOpener(opened)
    // first ten minutes before the beat, then the baseline's through, the
    // stored message's time
    const [floor, through] = feedWatches() as number[]
    expect(Date.now() - floor).toBeGreaterThanOrEqual(10 * MINUTE)
    expect(through).toBe(Date.parse(snapshot.messages[0].created_at))
    expect(feedWatches()).toHaveLength(2)
    expect(stand.calls.map((c) => c.name)).toEqual([
      'notifications:beat',
      'notifications:claimAlerts',
    ])
    expect(stand.calls[1].args).toMatchObject({ events: [] })
    expect(tags()).toEqual([])
    // a new mention raises one alert with today's words
    snapshot.messages.push(message('new', 'a', 0))
    publish(snapshot)
    await settle()
    expect(tags()).toEqual(['new'])
    expect(PageNotification.shown.map((n) => n.title)).toEqual(['Planner mentioned you, Task a'])
    // its click opens the Inbox and writes nothing, and nothing read the
    // Inbox's page before it
    expect(watched.some((w) => w.name === 'inbox:page')).toBe(false)
    const before = sentNames.length
    PageNotification.shown[0].onclick?.()
    expect(opened).toHaveBeenCalledOnce()
    await settle()
    expect(sentNames.slice(before)).toEqual([])
  })

  it('raises nothing for the stored messages of a task that comes back into view, and one for a new mention', async () => {
    // task b is out of view, its message stored long before
    snapshot.messages.push(message('stored', 'b', 30 * MINUTE))
    await boot()
    snapshot.issues.push(task('b'))
    publish(snapshot)
    await settle()
    expect(tags()).toEqual([])
    snapshot.messages.push(message('mention', 'b', 0))
    publish(snapshot)
    await settle()
    expect(tags()).toEqual(['mention'])
  })

  it('alerts a mention made a moment before an answer that reaches the store only later', async () => {
    await boot()
    snapshot.messages.push(message('late', 'a', 30_000))
    publish(snapshot)
    await settle()
    expect(tags()).toEqual(['late'])
  })

  it('raises nothing for a restore’s old stored messages, and one for one under ten minutes old', async () => {
    snapshot.issues.push({ ...task('r'), archived_at: new Date().toISOString() })
    snapshot.messages.push(message('kept', 'r', 60 * MINUTE), message('fresh', 'r', 3 * MINUTE))
    await boot()
    snapshot.issues = snapshot.issues.map((t) =>
      t.id === 'r' ? { ...t, archived_at: undefined } : t,
    )
    publish(snapshot)
    await settle()
    expect(tags()).toEqual(['fresh'])
  })

  it('keeps the feed running while the tab is hidden', async () => {
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    await boot()
    snapshot.messages.push(message('hidden', 'a', 0))
    publish(snapshot)
    await settle()
    expect(tags()).toEqual(['hidden'])
  })

  it('watches the feed again with the same floor on a fresh registry, and shows one summary after a reconnect', async () => {
    await boot()
    const [floor] = feedWatches()
    // a new organization's re-init starts fresh parts
    await store.initStore()
    await settle()
    expect(feedWatches().at(-1)).toBe(floor)
    // the server says something arrived during the outage
    stand.summaryNext()
    const from = stand.calls.length
    double.live?.reconnect()
    await settle()
    expect(stand.calls.slice(from).map((c) => c.name)).toEqual([
      'notifications:beat',
      'notifications:claimSummary',
    ])
    expect(tags()).toEqual(['qivo:catch-up'])
    expect(PageNotification.shown[0].title).toBe('New unread activity')
  })

  it('sends no call while the socket is down, and stops at the demo’s disposal', async () => {
    demo.on = true
    try {
      await boot()
      online = false
      const from = stand.calls.length
      snapshot.messages.push(message('offline', 'a', 0))
      publish(snapshot)
      await settle()
      expect(stand.calls.length).toBe(from)
      expect(tags()).toEqual([])
      const watches = watched.length
      store.disposeDemoStore()
      online = true
      publish(snapshot)
      await settle()
      expect(stand.calls.length).toBe(from)
      expect(watched.length).toBe(watches)
    } finally {
      demo.on = false
    }
  })
})

describe('the close guard', () => {
  it('leaves the notification calls in flight out, and counts every other mutation', async () => {
    const { createNotificationFeed, othersInFlight, notificationCallsInFlight } = await import(
      '../lib/notificationFeed'
    )
    let answer: (value: unknown) => void = () => {}
    const client = createNotificationFeed({
      convex: {
        mutation: () => new Promise((resolve) => (answer = resolve)),
        connectionState: () => ({ isWebSocketConnected: true }),
      } as never,
      watch: () => {},
      unwatch: () => {},
      notify: () => {},
      openInbox: () => {},
      canNotify: () => true,
      supported: () => true,
    })
    client.start()
    // the first beat waits
    expect(notificationCallsInFlight()).toBe(1)
    expect(othersInFlight(1)).toBe(0)
    // a save in flight beside it still counts
    expect(othersInFlight(2)).toBe(1)
    answer({ every_ms: 60_000, live_ms: 180_000, now: Date.now() })
    await client.idle()
    expect(notificationCallsInFlight()).toBe(0)
    expect(othersInFlight(1)).toBe(1)
    client.stop()
  })

  it('counts nothing for a call that throws at once', async () => {
    const { createNotificationFeed, notificationCallsInFlight } = await import(
      '../lib/notificationFeed'
    )
    const client = createNotificationFeed({
      convex: {
        mutation: () => {
          throw new Error('the socket restarted')
        },
        connectionState: () => ({ isWebSocketConnected: true }),
      } as never,
      watch: () => {},
      unwatch: () => {},
      notify: () => {},
      openInbox: () => {},
      canNotify: () => true,
      supported: () => true,
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.start()
    await client.idle()
    expect(notificationCallsInFlight()).toBe(0)
    client.stop()
  })
})
