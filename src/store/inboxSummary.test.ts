// @vitest-environment jsdom
import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxBadge } from '../lib/inboxBadge'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The unread summary as a side of the live parts (store/liveParts.ts,
   store/planner.ts P.inboxSummary), on the real store over the live
   double, which answers it from the published whole through its stand-in
   (store/inboxStandIn.setup.ts): watched right after the root part, so its
   first answer comes with the boot; a held answer after a reconnect or a
   re-init that is not current until it arrives again; a failure of its
   own, which opening the Inbox runs again; every new registry watching it
   again; answers while the tab is hidden; and Mark all as read and Remove
   all read from its seat flags, true while it has no answer. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('./guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/* The live double's own watch, which vi.resetModules keeps with the double
   across this file's tests, so each test's log wraps it once. */
let doubleWatch: Double['watch'] | null = null
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The fixture's organization with three tasks, with unread messages about
    the first two and a read one about the third. */
function fixture(): Snapshot {
  const snap = plannerFixture()
  const org = snap.orgs[0].id
  const me = snap.profiles[0].id
  for (const [n, read] of [false, false, true].entries()) {
    const id = `task-${n}`
    snap.issues.push({
      id,
      org_id: org,
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
    snap.messages.push({
      id: `message-${n}`,
      org_id: org,
      recipient_id: me,
      issue_id: id,
      issue_title: `Task ${n + 1}`,
      kind: 'comment',
      detail: 'New comment',
      created_at: AT,
      ...(read ? { read_at: AT } : {}),
    })
  }
  return snap
}

describe('the unread summary in the store', () => {
  let store: typeof import('./planner')
  let liveParts: typeof import('./liveParts')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void
  // every query the store's registry watched, in order
  let watched: string[]
  // the summary as each emit of the Inbox's section found it
  let inboxEmits: { state: string; current: boolean }[]

  const P = () => store.P
  const live = () => {
    if (!double.live) throw new Error('the live double is not set up')
    return double.live
  }
  const summaryWatches = () => watched.filter((name) => name === 'inbox:summary').length

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    window.showToast = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = fixture()
    watched = []
    inboxEmits = []
    network.query.mockResolvedValue(null)
    network.mutation.mockResolvedValue(null)
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = (snap) => receive(structuredClone(snap))
        deliver(snapshot)
      }
      return () => {}
    })
    liveParts = await import('./liveParts')
    store = await import('./planner')
    const transport = live()
    doubleWatch ??= transport.watch.bind(transport)
    const watch = doubleWatch
    transport.watch = (ref, args) => {
      watched.push(getFunctionName(ref))
      return watch(ref, args)
    }
    P().updates.inbox.subscribe(() =>
      inboxEmits.push({ state: P().inboxSummary.state, current: P().inboxSummary.current }),
    )
  })

  afterEach(() => {
    liveParts.STALL.ms = 60_000
    live().forceInbox(null)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    vi.restoreAllMocks()
  })

  it('is watched right after the root part and answers with the boot', async () => {
    expect(P().inboxSummary).toEqual({ state: 'loading', answer: null, current: false })
    await store.initStore()
    // right after the root part, before it answered, and no part of an
    // organization comes after it
    expect(watched.slice(0, 2)).toEqual(['workspace:root', 'inbox:summary'])
    expect(watched).not.toContain('workspace:projects')
    expect(summaryWatches()).toBe(1)
    // its first answer came with the boot's transitions, before the store
    // held the workspace, and reached the store with it
    expect(P().inboxSummary).toMatchObject({
      state: 'ok',
      current: true,
      answer: { unread_count: 2, unread_more: false, complete: true },
    })
    expect(inboxBadge(P().inboxSummary)).toMatchObject({ chip: '2', tabName: 'Inbox, 2 unread' })
  })

  it('keeps the held answer after a reconnect, not current until it arrives again', async () => {
    await store.initStore()
    inboxEmits.length = 0
    // the socket is back, and only the root part arrived again yet
    live().reconnect(['workspace:root'])
    expect(P().inboxSummary).toMatchObject({
      state: 'ok',
      current: false,
      answer: { unread_count: 2 },
    })
    // the badge heard of it, though the workspace held what it shows
    expect(inboxEmits).toEqual([{ state: 'ok', current: false }])
    expect(inboxBadge(P().inboxSummary)).toMatchObject({ chip: '2', refreshing: true })
    live().reconnect()
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: true })
    expect(inboxBadge(P().inboxSummary)).toMatchObject({ chip: '2', refreshing: false })
  })

  it('fails on its own, with no number, and runs again when the Inbox opens', async () => {
    await store.initStore()
    live().forceInbox('failed', 'inbox:summary')
    expect(P().inboxSummary).toEqual({ state: 'failed', answer: null, current: false })
    expect(inboxBadge(P().inboxSummary)).toMatchObject({
      chip: '…',
      tabName: 'Inbox, unread count unavailable',
    })
    // the workspace goes on
    expect(P().snapshotTrouble()).toBeNull()
    // opening the Inbox runs it again from a fresh subscription, which
    // fails again while the server still fails it
    P().retryInboxSummary()
    expect(summaryWatches()).toBe(2)
    expect(P().inboxSummary.state).toBe('loading')
    await tick()
    expect(P().inboxSummary.state).toBe('failed')
    // once the server answers, a press runs nothing again
    live().forceInbox(null)
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: true })
    P().retryInboxSummary()
    expect(summaryWatches()).toBe(2)
  })

  it("is watched again by a retry's registry and a re-init's, held until then", async () => {
    await store.initStore()
    // after a reconnect the root part stays silent and the workspace stalls
    liveParts.STALL.ms = 30
    live().reconnect([])
    await wait(80)
    expect(P().snapshotTrouble()?.kind).toBe('failed')
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: false })
    // Try again starts every part afresh, the summary with them
    P().retrySnapshot()
    for (let i = 0; i < 4; i++) await tick()
    expect(summaryWatches()).toBe(2)
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: true })
    // a re-init holds the answer as not current until the new registry's
    // arrives
    inboxEmits.length = 0
    await store.initStore()
    expect(summaryWatches()).toBe(3)
    expect(inboxEmits[0]).toEqual({ state: 'ok', current: false })
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: true })
  })

  it('answers while the tab is hidden, and the badge hears it', async () => {
    await store.initStore()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    inboxEmits.length = 0
    snapshot.messages = snapshot.messages.map((m) => ({ ...m, read_at: undefined }))
    deliver(snapshot)
    expect(P().inboxSummary).toMatchObject({ state: 'ok', answer: { unread_count: 3 } })
    expect(inboxEmits.length).toBeGreaterThan(0)
  })

  it('repaints once for a transition that brings the workspace and the summary', async () => {
    await store.initStore()
    let workspaceEmits = 0
    P().updates.workspace.subscribe(() => workspaceEmits++)
    inboxEmits.length = 0
    // the organization's rename and the messages arrive in one transition
    snapshot.orgs[0].name = 'Renamed Labs'
    snapshot.messages = snapshot.messages.map((m) => ({ ...m, read_at: undefined }))
    deliver(snapshot)
    // the workspace emit showed the summary's news too
    expect(workspaceEmits).toBe(1)
    expect(inboxEmits).toEqual([{ state: 'ok', current: true }])
    expect(P().inboxSummary.answer?.unread_count).toBe(3)
  })
})

describe("Mark all as read and Remove all read from the summary's seat flags", () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let deliver: (snap: Snapshot) => void

  const P = () => store.P
  const live = () => {
    if (!double.live) throw new Error('the live double is not set up')
    return double.live
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    window.showToast = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snapshot = fixture()
    network.query.mockResolvedValue(null)
    // the boot's seat claim answers, and every other write waits
    network.mutation.mockImplementation((ref) =>
      getFunctionName(ref) === 'identity:claimMySeats'
        ? Promise.resolve(null)
        : new Promise(() => {}),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        deliver = (snap) => receive(structuredClone(snap))
        deliver(snapshot)
      }
      return () => {}
    })
    store = await import('./planner')
  })

  afterEach(() => {
    live().forceInbox(null)
    vi.restoreAllMocks()
  })

  /** A second seat of the login, in a second organization, with nothing
      in its Inbox. */
  function secondSeat(snap: Snapshot) {
    const org = { ...snap.orgs[0], id: '00000000-0000-4000-8000-0000000000b2', slug: 'second' }
    const seat = { ...snap.profiles[0], id: 'profile-second', org_id: org.id }
    snap.orgs = [...snap.orgs, org]
    snap.profiles = [...snap.profiles, seat]
    snap.myProfileIds = [...snap.myProfileIds, seat.id]
  }

  it('follows the flags of the summary’s answer', async () => {
    await store.initStore()
    expect(P().canMarkAllRead).toBe(true)
    expect(P().canRemoveRead).toBe(true)
    // nothing unread anywhere, by the server's flags
    snapshot.messages = snapshot.messages.filter((m) => m.read_at)
    deliver(snapshot)
    expect(P().canMarkAllRead).toBe(false)
    expect(P().canRemoveRead).toBe(true)
    // an item marked unread is not the server's answer yet
    P().unreadItem({
      org: snapshot.orgs[0].id,
      task: snapshot.messages[0].issue_id,
      through: Date.parse(snapshot.messages[0].created_at),
    })
    expect(P().canMarkAllRead).toBe(false)
    // and an answer that says otherwise wins
    deliver({
      ...snapshot,
      messages: snapshot.messages.map((m, i) => (i === 0 ? { ...m, read_at: undefined } : m)),
    })
    expect(P().canMarkAllRead).toBe(true)
  })

  it('is true for both while the summary has no answer, loading or failed', async () => {
    live().forceInbox('loading', 'inbox:summary')
    snapshot.messages = []
    await store.initStore()
    expect(P().inboxSummary.state).toBe('loading')
    // the store holds no message, and the server may hold some
    expect(P().canMarkAllRead).toBe(true)
    expect(P().canRemoveRead).toBe(true)
    live().forceInbox(null)
    expect(P().inboxSummary.state).toBe('ok')
    expect(P().canMarkAllRead).toBe(false)
    expect(P().canRemoveRead).toBe(false)
    live().forceInbox('failed', 'inbox:summary')
    expect(P().inboxSummary.state).toBe('failed')
    expect(P().canMarkAllRead).toBe(true)
    expect(P().canRemoveRead).toBe(true)
  })

  it('is true for a seat an incomplete answer left out, and for none a complete one leaves', async () => {
    secondSeat(snapshot)
    snapshot.messages = []
    live().forceInbox('budget', 'inbox:summary')
    await store.initStore()
    // the budget stopped before the second seat, so its flags are unknown
    expect(P().inboxSummary.answer).toMatchObject({ complete: false })
    expect(P().inboxSummary.answer?.seats).toHaveLength(1)
    expect(P().canMarkAllRead).toBe(true)
    expect(P().canRemoveRead).toBe(true)
    // an incomplete answer that reached every seat says what each holds
    live().forceInbox('incomplete', 'inbox:summary')
    expect(P().inboxSummary.answer?.seats).toHaveLength(2)
    expect(P().canMarkAllRead).toBe(false)
    expect(P().canRemoveRead).toBe(false)
    // and a held answer that is not current still counts
    live().reconnect(['workspace:root'])
    expect(P().inboxSummary.current).toBe(false)
    expect(P().canMarkAllRead).toBe(false)
  })

  it('keeps the actions guarded by the flags', async () => {
    snapshot.messages = []
    await store.initStore()
    expect(P().canMarkAllRead).toBe(false)
    await P().markAllMessagesRead()
    await P().deleteReadMessages()
    // neither asked the server what it reaches
    expect(
      network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:bulkReach'),
    ).toEqual([])
    expect(network.mutation.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
      'identity:claimMySeats',
    ])
  })
})
