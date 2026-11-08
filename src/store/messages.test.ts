import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Whole } from './guard/liveDouble.setup'

type Snapshot = Whole
type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'

function fixture(): Snapshot {
  const orgs: Snapshot['orgs'] = ['Testbed Labs', 'Guest workspace'].map((name, index) => ({
    id: crypto.randomUUID(),
    name,
    slug: `workspace-${index}`,
    created_at: NOW,
    next_issue_num: 4,
    date_format: 'iso',
    week_start: 1,
    week_one_rule: 'first4day',
    default_plannable_hours: 40,
  }))
  const profiles: Snapshot['profiles'] = orgs.map((org, index) => ({
    id: crypto.randomUUID(),
    org_id: org.id,
    auth_user_id: 'test-account',
    name: 'Planner',
    initials: 'PL',
    color: '#335577',
    org_role: index === 0 ? 'admin' : 'guest',
    active: true,
    kind: 'person',
    created_at: NOW,
  }))
  const tasks = Array.from({ length: 4 }, () => crypto.randomUUID())
  const notifications = [
    { seat: 0, task: 0, read: true },
    { seat: 0, task: 0, read: false },
    { seat: 0, task: 1, read: true },
    { seat: 1, task: 2, read: true },
    { seat: 1, task: 3, read: false },
  ]
  return {
    auth_user_id: 'test-account',
    myProfileIds: profiles.map((profile) => profile.id),
    orgs,
    profiles,
    // Archived/unavailable tasks still have inbox rows, so no task fixture is needed.
    projects: [],
    issues: [],
    teams: [],
    teamMembers: [],
    access: [],
    teamAccess: [],
    links: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    delivered_at: '2026-09-15T08:00:00.000Z',
    messages: notifications.map(({ seat, task, read }) => ({
      id: crypto.randomUUID(),
      org_id: orgs[seat].id,
      recipient_id: profiles[seat].id,
      issue_id: tasks[task],
      issue_title: `Notification task ${task + 1}`,
      kind: 'change',
      detail: 'Status changed',
      created_at: NOW,
      ...(read ? { read_at: NOW } : {}),
    })),
  }
}

type Pending = {
  name: string
  args: { org_id: string; before?: number }
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** One seat of messages.bulkReach's answer (convex/messages.ts). */
type SeatReach = { org_id: string; reach: 'none' | 'one' | 'many'; before?: number }

/** What messages.bulkReach answers for `action` over `snap`: per seat `one`
    when the seat holds an unsnoozed row the action walks, else `none`, and
    for Mark all as read a cutoff, as the server reads its own rows. A test
    that needs other answers sets them. */
function reachOf(snap: Snapshot, action: 'read' | 'remove'): { seats: SeatReach[] } {
  return {
    seats: snap.orgs.map((org) => {
      const walked = snap.messages.some(
        (m) => m.org_id === org.id && !m.snoozed_until && !!m.read_at === (action === 'remove'),
      )
      return {
        org_id: org.id,
        reach: walked ? 'one' : 'none',
        ...(action === 'read' ? { before: 1 } : {}),
      }
    }),
  }
}

/** How often the store asked messages.bulkReach. */
const reachAsked = () =>
  network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'messages:bulkReach').length

/** Lets the store's press go on past its bulkReach question. */
const asked = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('bulk notification actions through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>
  let dismissToast: ReturnType<typeof vi.fn>
  // what bulkReach answers, 'fail' for a refused question or 'never' for
  // one that never answers; null answers from the snapshot (reachOf)
  let reach: { seats: SeatReach[] } | 'fail' | 'never' | null
  // the Inbox that shows the notice (P.hostInboxNotice), and whether it
  // lets the notice open now
  let unhost: () => void
  let hostReady: boolean
  // holds bulkReach's answer until the test opens it
  let reachGate: Promise<void> | null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    dismissToast = vi.fn()
    vi.stubGlobal('window', { showToast, dismissToast, setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    requests = []
    reach = null
    hostReady = true
    reachGate = null
    network.query.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) !== 'messages:bulkReach') return null
      if (reachGate) await reachGate
      if (reach === 'fail') throw new Error('offline')
      if (reach === 'never') return await new Promise(() => {})
      return structuredClone(reach ?? reachOf(snap, args.action))
    })
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) =>
        requests.push({
          name,
          args,
          resolve: (value) => resolve(naming(name, args, value)),
          reject,
        }),
      )
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    unhost = P.hostInboxNotice({ prepare: () => hostReady })
  })

  /* A bulk batch's answer names the rows it changed (convex/messages.ts):
     the seat's unread rows for Mark all as read, its read rows for Remove
     all read, as the server holds them when it answers, snoozed rows left
     out. Answers that name them already stay as they are, and an answer
     without its count counts the rows it names. */
  function naming(name: string, args: Pending['args'], value: unknown) {
    if (!value || typeof value !== 'object') return value
    const read = name === 'messages:removeRead'
    if (!read && name !== 'messages:markAllRead') return value
    const ids =
      'ids' in value
        ? (value.ids as string[])
        : snap.messages
            .filter((m) => m.org_id === args.org_id && !m.snoozed_until && !!m.read_at === read)
            .map((m) => m.id)
    const counted = read ? 'removed' : 'marked'
    return { [counted]: ids.length, ...value, ids }
  }

  afterEach(() => {
    // also after a test on fake timers that failed before it put them back
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  /** Adds a third seat of the login, in a third organization, with one
      unread and one read message. */
  function thirdSeat() {
    const org = { ...snap.orgs[0], id: crypto.randomUUID(), name: 'Northstar', slug: 'northstar' }
    const profile = { ...snap.profiles[0], id: crypto.randomUUID(), org_id: org.id }
    snap.orgs = [...snap.orgs, org]
    snap.profiles = [...snap.profiles, profile]
    snap.myProfileIds = [...snap.myProfileIds, profile.id]
    for (const read of [false, true])
      snap.messages = [
        ...snap.messages,
        {
          ...snap.messages[0],
          id: crypto.randomUUID(),
          org_id: org.id,
          recipient_id: profile.id,
          issue_id: crypto.randomUUID(),
          read_at: read ? NOW : undefined,
        },
      ]
    publish(structuredClone(snap))
    return org.id
  }

  it('marks all notifications read across seats and waits for every write', async () => {
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    // nothing changes before bulkReach answers
    expect(P.inboxBulk).toMatchObject({ action: 'read', state: 'asking' })
    await asked()
    expect(reachAsked()).toBe(1)
    expect(network.query).toHaveBeenCalledWith(expect.anything(), { action: 'read' })
    expect(requests).toHaveLength(2)
    for (const org of snap.orgs) {
      expect(requests.find((request) => request.args.org_id === org.id)).toMatchObject({
        name: 'messages:markAllRead',
        // the cutoff bulkReach answered at the press
        args: { org_id: org.id, before: 1 },
      })
    }
    requests[0].resolve({ marked: 1, hasMore: false, before: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    expect(P.inboxBulk).toMatchObject({ state: 'running', done: 1, seats: 2, seatsDone: 1 })
    requests[1].resolve({ marked: 1, hasMore: false, before: 25 })
    await marking
    expect(completed).toBe(true)
    expect(P.inboxBulk).toMatchObject({ state: 'finished', long: false, done: 2, seatsDone: 2 })
    // a short action says nothing: its rows show it
    expect(showToast).not.toHaveBeenCalled()
  })

  it('continues past one batch with each seat’s fixed cutoff', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    snap.messages = Array.from({ length: 500 }, () => ({
      ...unread,
      id: crypto.randomUUID(),
      issue_id: crypto.randomUUID(),
    }))
    publish(structuredClone(snap))
    const firstOrg = snap.orgs[0].id
    // the other seat's rows are past the snapshot's cap
    reach = {
      seats: [
        { org_id: firstOrg, reach: 'many', before: 1234.5 },
        { org_id: snap.orgs[1].id, reach: 'one', before: 99 },
      ],
    }
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    await asked()
    const first = requests.find((request) => request.args.org_id === firstOrg)!
    const other = requests.find((request) => request.args.org_id !== firstOrg)!
    expect(first.args.before).toBe(1234.5)
    expect(other.args.before).toBe(99)
    // the batches name the rows before the seat's cutoff, never a later arrival
    const loaded = snap.messages.map((message) => message.id)
    first.resolve({ marked: 256, ids: loaded.slice(0, 256), hasMore: true, before: 1234.5 })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]).toMatchObject({
      name: 'messages:markAllRead',
      args: { org_id: firstOrg, before: 1234.5 },
    })
    other.resolve({ marked: 0, hasMore: false, before: 99 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    const arrival = { ...unread, id: crypto.randomUUID(), issue_id: crypto.randomUUID() }
    snap.messages = [
      arrival,
      ...snap.messages.slice(0, 499).map((message) => ({ ...message, read_at: NOW })),
    ]
    publish(structuredClone(snap))
    requests[2].resolve({ marked: 244, ids: loaded.slice(256), hasMore: true, before: 1234.5 })
    await vi.waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3].args).toEqual({ org_id: firstOrg, before: 1234.5 })
    expect(P.inboxBulk).toMatchObject({ state: 'running', long: true, done: 500, seatsDone: 1 })
    requests[3].resolve({ marked: 88, ids: [], hasMore: false, before: 1234.5 })
    await marking
    // a long action ends with what it did, wherever the person is
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Marked 588 messages as read.', 'success')
  })

  it.each(['empty', 'read only'])('does not mark notifications for an %s inbox', async (state) => {
    snap.messages = state === 'empty' ? [] : snap.messages.filter((message) => message.read_at)
    publish(structuredClone(snap))
    expect(P.canMarkAllRead).toBe(false)
    await expect(P.markAllMessagesRead()).resolves.toBeUndefined()
    expect(requests).toEqual([])
    expect(reachAsked()).toBe(0)
  })

  it('stops a seat after the batches it confirmed, takes back the rest and lets the others finish', async () => {
    const firstOrg = snap.orgs[0].id
    const secondOrg = snap.orgs[1].id
    const unread = snap.messages.find((m) => !m.read_at && m.org_id === firstOrg)!
    const more = Array.from({ length: 3 }, () => ({
      ...unread,
      id: crypto.randomUUID(),
      issue_id: crypto.randomUUID(),
    }))
    snap.messages = [...snap.messages, ...more]
    publish(structuredClone(snap))
    const confirmed = [unread.id, more[0].id]
    reach = {
      seats: [
        { org_id: firstOrg, reach: 'many', before: 5 },
        { org_id: secondOrg, reach: 'one', before: 6 },
      ],
    }
    const marking = P.markAllMessagesRead()
    await asked()
    const first = () => requests.filter((request) => request.args.org_id === firstOrg)
    first()[0].resolve({ marked: 2, ids: confirmed, hasMore: true, before: 5 })
    await vi.waitFor(() => expect(first()).toHaveLength(2))
    expect(P.inboxBulk).toMatchObject({ done: 2, seatsDone: 0, long: true })
    first()[1].reject(new ConvexError({ code: 'rule', message: 'the organization is read-only' }))
    await vi.waitFor(() => expect(P.inboxBulk?.stops).toHaveLength(1))
    // the other seat still runs, and the action has not ended
    expect(P.inboxBulk?.state).toBe('running')
    expect(showToast).not.toHaveBeenCalled()
    requests
      .find((request) => request.args.org_id === secondOrg)
      ?.resolve({
        marked: 1,
        hasMore: false,
        before: 6,
      })
    await marking
    expect(P.inboxBulk).toMatchObject({
      state: 'stopped',
      done: 3,
      seats: 2,
      seatsDone: 1,
      stops: [{ org: firstOrg, done: 2 }],
    })
    // a stop reports what was done and what was not, and no success
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith(
      'Mark all as read stopped after 2 messages in Testbed Labs. The rest stay unread. The organization is read-only.',
      'error',
      expect.objectContaining({ sticky: true, key: `inbox-bulk:read:${firstOrg}` }),
    )
  })

  it('sends at most two seats at once, the third with the cutoff the press answered', async () => {
    const third = thirdSeat()
    reach = {
      seats: [
        { org_id: snap.orgs[0].id, reach: 'one', before: 10 },
        { org_id: snap.orgs[1].id, reach: 'one', before: 11 },
        { org_id: third, reach: 'one', before: 12 },
      ],
    }
    const marking = P.markAllMessagesRead()
    await asked()
    const inFlight = () =>
      requests.filter((r) => r.name === 'messages:markAllRead' && !answered.has(r))
    const answered = new Set<Pending>()
    expect(inFlight()).toHaveLength(2)
    expect(P.inboxBulk).toMatchObject({ state: 'running', long: true, seats: 3 })
    // the third seat goes once a slot is free, with the press's cutoff
    answered.add(requests[0])
    requests[0].resolve({ marked: 1, hasMore: false, before: 999 })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(inFlight()).toHaveLength(2)
    expect(requests[2].args).toEqual({ org_id: third, before: 12 })
    expect(P.inboxBulk).toMatchObject({ done: 1, seatsDone: 1 })
    for (const request of requests.slice(1)) {
      answered.add(request)
      request.resolve({ marked: 1, hasMore: false, before: 999 })
    }
    await marking
    expect(P.inboxBulk).toMatchObject({ state: 'finished', done: 3, seats: 3, seatsDone: 3 })
    expect(showToast).toHaveBeenCalledWith('Marked 3 messages as read.', 'success')
  })

  it('skips the seats with nothing to do', async () => {
    const [first, second] = snap.orgs.map((org) => org.id)
    // nothing loaded there is unread either
    snap.messages = snap.messages.filter((m) => m.org_id === first || m.read_at)
    publish(structuredClone(snap))
    reach = {
      seats: [
        { org_id: first, reach: 'one', before: 3 },
        { org_id: second, reach: 'none', before: 0 },
      ],
    }
    const marking = P.markAllMessagesRead()
    await asked()
    expect(requests.map((request) => request.args.org_id)).toEqual([first])
    requests[0].resolve({ marked: 1, hasMore: false, before: 3 })
    await marking
    expect(P.inboxBulk).toMatchObject({ state: 'finished', seats: 1, seatsDone: 1 })

    // nothing anywhere, by the server's answer at the press, ends the press
    // without a write
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'none', before: 0 })) }
    requests = []
    await P.markAllMessagesRead()
    expect(requests).toEqual([])
    expect(P.inboxBulk).toBeNull()
  })

  it.each([
    ['a seat with more than one batch', [['one'], ['many']], true],
    ['more seats with work than run at once', [['one'], ['one'], ['one']], true],
    ['two seats of one batch', [['one'], ['one']], false],
  ] as const)('shows the keep-open notice for %s: %s', async (_case, answer, notice) => {
    if (answer.length === 3) thirdSeat()
    reach = { seats: answer.map(([r], i) => ({ org_id: snap.orgs[i].id, reach: r, before: 4 })) }
    const marking = P.markAllMessagesRead(true)
    await asked()
    if (!notice) {
      expect(P.inboxBulk?.state).toBe('running')
      for (const request of requests) request.resolve({ marked: 1, hasMore: false, before: 4 })
      return await marking
    }
    // nothing is sent before the person answers
    expect(P.inboxBulk).toMatchObject({ state: 'notice', long: true })
    expect(requests).toEqual([])
    P.answerInboxNotice(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('running')
    expect(requests.map((request) => request.args.before)).toEqual([4, 4])
    // every seat's batch, the third once a slot is free
    const answered = new Set<Pending>()
    await vi.waitFor(() => {
      for (const request of requests.filter((r) => !answered.has(r))) {
        answered.add(request)
        request.resolve({ marked: 1, hasMore: false, before: 4 })
      }
      expect(P.inboxBulk?.state).toBe('finished')
    })
    await marking
  })

  it('sends nothing when the person cancels the notice, and a new press asks again', async () => {
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 8 })) }
    const removal = P.deleteReadMessages(true)
    await asked()
    expect(P.inboxBulk).toMatchObject({ action: 'remove', state: 'notice' })
    P.answerInboxNotice(false)
    // the buttons are back at once
    expect(P.inboxBulk).toBeNull()
    await removal
    expect(requests).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
    // the next press asks bulkReach again, never resuming the old plan
    const again = P.deleteReadMessages(true)
    await asked()
    expect(reachAsked()).toBe(2)
    P.answerInboxNotice(false)
    await again
  })

  it('does not continue a batch or restore notifications after the demo store is disposed', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubGlobal('window', { showToast, clearTimeout })
    requests = []
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    const marking = P.markAllMessagesRead()
    await asked()
    expect(requests).toHaveLength(2)
    store.disposeDemoStore()
    expect(P.inboxBulk).toBeNull()
    for (const request of requests) request.resolve({ marked: 256, hasMore: true, before: 200 })
    await marking
    expect(requests).toHaveLength(2)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('ends a notice that waits when the demo store is disposed', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubGlobal('window', { showToast, clearTimeout })
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    P.hostInboxNotice({ prepare: () => true })
    const marking = P.markAllMessagesRead(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('notice')
    store.disposeDemoStore()
    await marking
    expect(P.inboxBulk).toBeNull()
    expect(requests).toEqual([])
  })

  it('lets a press in the next demo ask at once though a write of the ended demo never answered', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_APP_MODE', 'demo')
    vi.stubGlobal('window', { showToast, clearTimeout })
    requests = []
    const store = await import('./planner')
    P = store.P
    await store.initStore()
    const unread = snap.messages.find((m) => !m.read_at)!
    P.readItem({
      org: unread.org_id,
      task: unread.issue_id,
      through: Date.parse(unread.created_at),
    })
    await asked()
    // the read goes out and is never answered
    expect(requests.map((r) => r.name)).toEqual(['messages:readItem'])
    store.disposeDemoStore()
    await store.initStore()
    const asks = reachAsked()
    const removal = P.deleteReadMessages()
    await asked()
    expect(reachAsked()).toBe(asks + 1)
    await answerAll(() => ({ removed: 1, hasMore: false }))
    await removal
  })

  it('removes read messages from mixed groups across seats and waits for every write', async () => {
    const unread = snap.messages.filter((message) => !message.read_at)
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    await asked()

    expect(requests).toHaveLength(2)
    for (const org of snap.orgs) {
      const request = requests.find((operation) => operation.args.org_id === org.id)!
      expect(request.name).toBe('messages:removeRead')
      expect(request.args).toEqual({ org_id: org.id })
    }

    // A new arrival waits for the deletion's answer or a 0 ms timer.
    const incoming = { ...unread[0], id: crypto.randomUUID(), detail: 'Another update' }
    snap.messages = [...unread, incoming]
    publish(structuredClone(snap))
    requests[0].resolve({ removed: 2, hasMore: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    // the arrival shows within a task, while the other seat still waits

    requests[1].resolve({ removed: 1, hasMore: false })
    await removal
    expect(completed).toBe(true)
    expect(P.inboxBulk).toMatchObject({ action: 'remove', state: 'finished', done: 3 })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removes unseen read notifications in repeated batches across every seat', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    // 500 unread rows and one read row, beyond which more read rows remain
    // on the server than one batch removes
    snap.messages = [
      ...Array.from({ length: 500 }, () => ({ ...unread, id: crypto.randomUUID() })),
      { ...unread, id: crypto.randomUUID(), read_at: NOW },
    ]
    publish(structuredClone(snap))
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many' })) }
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    await asked()
    expect(requests).toHaveLength(2)

    const firstOrg = snap.orgs[0].id
    const first = requests.find((operation) => operation.args.org_id === firstOrg)!
    const other = requests.find((operation) => operation.args.org_id !== firstOrg)!
    first.resolve({ removed: 256, hasMore: true })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    const next = requests[2]
    expect(next).toMatchObject({ name: 'messages:removeRead', args: { org_id: firstOrg } })

    other.resolve({ removed: 88, hasMore: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    expect(P.inboxBulk).toMatchObject({ state: 'running', done: 344, seatsDone: 1 })
    publish(structuredClone(snap))
    next.resolve({ removed: 256, hasMore: false })
    await removal

    expect(completed).toBe(true)
    expect(requests).toHaveLength(3)
    expect(showToast).toHaveBeenCalledWith('Removed 600 read notifications.', 'success')
  })

  it.each(['empty', 'unread only'])('does not write for an %s inbox', async (state) => {
    snap.messages = state === 'empty' ? [] : snap.messages.filter((message) => !message.read_at)
    publish(structuredClone(snap))
    expect(P.canRemoveRead).toBe(false)

    await expect(P.deleteReadMessages()).resolves.toBeUndefined()

    expect(requests).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('waits for another seat after a refusal and reconciles partial success from the latest snapshot', async () => {
    const firstOrg = snap.orgs[0].id
    const secondOrg = snap.orgs[1].id
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    await asked()
    const refused = requests.find((operation) => operation.args.org_id === firstOrg)!
    const successful = requests.find((operation) => operation.args.org_id === secondOrg)!

    refused.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await vi.waitFor(() => expect(P.inboxBulk?.stops).toHaveLength(1))
    expect(completed).toBe(false)

    // The successful seat's server deletion must survive the other seat's rollback.
    snap.messages = snap.messages.filter(
      (message) => message.org_id !== secondOrg || !message.read_at,
    )
    publish(structuredClone(snap))
    successful.resolve({ removed: 1, hasMore: false })
    await removal

    expect(completed).toBe(true)
    expect(showToast).toHaveBeenCalledOnce()
  })

  it('refuses a press while an action runs, and keeps its state for an Inbox mounted later', async () => {
    const marking = P.markAllMessagesRead()
    await asked()
    // the store holds the state, not a component: any later reader sees it
    expect(P.inboxBulk).toMatchObject({ action: 'read', state: 'running', seats: 2 })
    publish(structuredClone(snap))
    await P.deleteReadMessages()
    expect(requests.map((request) => request.name)).toEqual([
      'messages:markAllRead',
      'messages:markAllRead',
    ])
    for (const request of requests) request.resolve({ marked: 1, hasMore: false, before: 1 })
    await marking
  })

  /** Answers every Mark all as read or Remove all read request not answered
      yet with `answer`, until none is left, and answers how many it did. */
  async function answerAll(answer: (request: Pending) => unknown) {
    const answered = new Set<Pending>()
    for (let rounds = 0; rounds < 20; rounds++) {
      const open = requests.filter((r) => /markAllRead|removeRead/.test(r.name) && !answered.has(r))
      if (!open.length) break
      for (const request of open) {
        answered.add(request)
        request.resolve(answer(request))
      }
      await asked()
    }
    return answered.size
  }

  it.each(['fail', 'never'] as const)(
    'writes nothing and toasts once when bulkReach answers %s',
    async (answer) => {
      thirdSeat()
      await asked()
      vi.useFakeTimers()
      try {
        reach = answer
        const marking = P.markAllMessagesRead(true)
        await vi.advanceTimersByTimeAsync(answer === 'fail' ? 1 : 9_999)
        if (answer === 'never') {
          expect(P.inboxBulk?.state).toBe('asking')
          await vi.advanceTimersByTimeAsync(1)
        }
        await marking
        expect(P.inboxBulk).toBeNull()
        expect(requests).toEqual([])
        expect(showToast).toHaveBeenCalledOnce()
        expect(showToast).toHaveBeenCalledWith(
          "Couldn't check how many messages Mark all as read covers, so nothing changed. Try again.",
          'error',
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('keeps three seats to two batches in flight, each with its cutoff from the press', async () => {
    const third = thirdSeat()
    reach = {
      seats: snap.orgs.map((org, i) => ({ org_id: org.id, reach: 'many', before: 40 + i })),
    }
    const marking = P.markAllMessagesRead()
    await asked()
    const answered = new Set<Pending>()
    let most = 0
    for (let rounds = 0; rounds < 20 && answered.size < requests.length; rounds++) {
      const open = requests.filter((r) => !answered.has(r))
      most = Math.max(most, open.length)
      // each seat answers twice with more to do, then no more
      const request = open[0]
      answered.add(request)
      const seen = requests.filter((r) => r.args.org_id === request.args.org_id).length
      request.resolve({ marked: 1, hasMore: seen < 3, before: request.args.before })
      await asked()
    }
    await marking
    expect(most).toBe(2)
    expect(requests).toHaveLength(9)
    // every batch carries its seat's cutoff from the press
    for (const request of requests)
      expect(request.args.before).toBe(
        40 + snap.orgs.findIndex((org) => org.id === request.args.org_id),
      )
    expect(requests.map((r) => r.args.org_id)).toContain(third)
    expect(P.inboxBulk).toMatchObject({ state: 'finished', done: 9, seatsDone: 3 })
  })

  it('gives a seat past the server budget the cutoff of the press, also when it is queued', async () => {
    const third = thirdSeat()
    // bulkReach answers a cutoff for a seat it did not read
    reach = {
      seats: [
        { org_id: snap.orgs[0].id, reach: 'one', before: 21 },
        { org_id: snap.orgs[1].id, reach: 'one', before: 22 },
        { org_id: third, reach: 'many', before: 23 },
      ],
    }
    const marking = P.markAllMessagesRead()
    await asked()
    expect(requests.map((r) => r.args.before)).toEqual([21, 22])
    requests[0].resolve({ marked: 1, hasMore: false, before: 21 })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2].args).toEqual({ org_id: third, before: 23 })
    await answerAll((r) => ({ marked: 1, hasMore: false, before: r.args.before }))
    await marking
  })

  it('waits for a pending read mark before it asks, so Remove all read removes that message', async () => {
    const seat = snap.orgs[1].id
    // the seat's only read message goes, so the server holds none read there
    snap.messages = snap.messages.filter((m) => m.org_id !== seat || !m.read_at)
    publish(structuredClone(snap))
    const unread = snap.messages.find((m) => m.org_id === seat && !m.read_at)!
    P.readItem({
      org: seat,
      task: unread.issue_id,
      through: Date.parse(unread.created_at),
    })
    const removal = P.deleteReadMessages()
    await asked()
    // bulkReach waits for the read, which the server has not taken yet
    expect(reachAsked()).toBe(0)
    expect(requests.map((r) => r.name)).toEqual(['messages:readItem'])
    snap.messages = snap.messages.map((m) => (m.id === unread.id ? { ...m, read_at: NOW } : m))
    requests[0].resolve(null)
    await asked()
    expect(reachAsked()).toBe(1)
    expect(requests.slice(1).map((r) => [r.name, r.args.org_id])).toEqual([
      ['messages:removeRead', snap.orgs[0].id],
      ['messages:removeRead', seat],
    ])
    await answerAll(() => ({ removed: 1, hasMore: false }))
    await removal
  })

  it('waits for a pending unread mark before it asks, so Mark all as read marks that message read', async () => {
    const seat = snap.orgs[0].id
    // an older unread message, and a newer read one the person reopens
    const older = snap.messages.find((m) => m.org_id === seat && !m.read_at)!
    const newer = {
      ...older,
      id: crypto.randomUUID(),
      issue_id: crypto.randomUUID(),
      created_at: '2026-09-14T09:00:00.000Z',
      read_at: NOW,
    }
    snap.messages = [...snap.messages, newer]
    publish(structuredClone(snap))
    // bulkReach answers the newest unread message's time as the cutoff
    reach = null
    network.query.mockImplementation((ref) =>
      getFunctionName(ref) === 'messages:bulkReach'
        ? Promise.resolve({
            seats: snap.orgs.map((org) => {
              const times = snap.messages
                .filter((m) => m.org_id === org.id && !m.read_at)
                .map((m) => Date.parse(m.created_at))
              return {
                org_id: org.id,
                reach: times.length ? 'one' : 'none',
                before: Math.max(0, ...times),
              }
            }),
          })
        : Promise.resolve(null),
    )
    P.unreadItem({ org: seat, task: newer.issue_id, through: Date.parse(newer.created_at) })
    const marking = P.markAllMessagesRead()
    await asked()
    expect(reachAsked()).toBe(0)
    snap.messages = snap.messages.map((m) => (m.id === newer.id ? { ...m, read_at: undefined } : m))
    requests[0].resolve(null)
    await asked()
    // the seat's cutoff includes the reopened message
    const mark = requests.find((r) => r.name === 'messages:markAllRead' && r.args.org_id === seat)
    expect(mark?.args.before).toBe(Date.parse(newer.created_at))
    await answerAll((r) => ({ marked: 1, hasMore: false, before: r.args.before }))
    await marking
  })

  it('stops every seat at a pause with one toast, the queued one before it sends anything', async () => {
    const third = thirdSeat()
    reach = {
      seats: snap.orgs.map((org, i) => ({ org_id: org.id, reach: 'one', before: 30 + i })),
    }
    const marking = P.markAllMessagesRead()
    await asked()
    expect(requests).toHaveLength(2)
    const [first, second] = requests
    first.resolve({ marked: 4, hasMore: true, before: 30 })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    // the pause refuses the first seat's next batch
    requests[2].reject(
      new ConvexError({
        code: 'paused',
        message: 'Qivo is offline. Changes wait until it is back.',
      }),
    )
    await asked()
    // the second seat's answer comes, and it sends nothing more
    second.resolve({ marked: 2, hasMore: true, before: 31 })
    await marking
    expect(requests).toHaveLength(3)
    expect(requests.map((r) => r.args.org_id)).not.toContain(third)
    expect(P.inboxBulk).toMatchObject({ state: 'stopped', done: 6 })
    expect(P.inboxBulk?.stops.map((stop) => [stop.org, stop.done, stop.paused]).sort()).toEqual(
      [
        [snap.orgs[0].id, 4, true],
        [snap.orgs[1].id, 2, true],
        [third, 0, true],
      ].sort(),
    )
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith(
      'Mark all as read stopped after 4 messages in Testbed Labs and 2 messages in Guest workspace. The rest stay unread. Qivo is offline. Changes wait until it is back.',
      'error',
      expect.objectContaining({ sticky: true, key: 'inbox-bulk:read:pause' }),
    )
  })

  it('closes a notice that nothing waits on any more', () => {
    // as after a fault: the notice shows but its press no longer waits
    P.answerInboxNotice(false)
    expect(P.inboxBulk).toBeNull()
  })

  it('keys stop toasts by action and takes them away once a later run finishes there', async () => {
    const [first, second] = snap.orgs.map((org) => org.id)
    const marking = P.markAllMessagesRead()
    await asked()
    requests
      .find((r) => r.args.org_id === first)
      ?.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    requests
      .find((r) => r.args.org_id === second)
      ?.resolve({ marked: 1, hasMore: false, before: 1 })
    await marking
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Mark all as read stopped in Testbed Labs'),
      'error',
      expect.objectContaining({ key: `inbox-bulk:read:${first}` }),
    )
    // Remove all read in the same seat neither shares nor takes its key
    requests = []
    const removal = P.deleteReadMessages()
    await asked()
    await answerAll(() => ({ removed: 1, hasMore: false }))
    await removal
    expect(dismissToast).not.toHaveBeenCalled()
    // a later Mark all as read that finishes there takes the stop away
    requests = []
    publish(structuredClone(snap))
    reach = { seats: [{ org_id: first, reach: 'one', before: 2 }] }
    const again = P.markAllMessagesRead()
    await asked()
    await answerAll(() => ({ marked: 1, hasMore: false, before: 2 }))
    await again
    expect(dismissToast).toHaveBeenCalledOnce()
    expect(dismissToast).toHaveBeenCalledWith(`inbox-bulk:read:${first}`)
  })

  it('ends a press whose Inbox left while it asked, also when the Inbox shows again before the answer', async () => {
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    let open: () => void = () => {}
    reachGate = new Promise((resolve) => {
      open = resolve
    })
    const old = P.markAllMessagesRead(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('asking')
    // the Inbox hides, then shows again, before bulkReach answers
    unhost()
    expect(P.inboxBulk).toBeNull()
    unhost = P.hostInboxNotice({ prepare: () => true })
    open()
    await old
    // the old press opens no notice with its old plan, and sends nothing
    expect(P.inboxBulk).toBeNull()
    expect(requests).toEqual([])
    // a new press asks again and opens its own notice
    reachGate = null
    const fresh = P.markAllMessagesRead(true)
    await asked()
    expect(reachAsked()).toBe(2)
    expect(P.inboxBulk?.state).toBe('notice')
    P.answerInboxNotice(false)
    await fresh
  })

  it('opens the notice only while a shown Inbox lets it', async () => {
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    // the person types in a field when the notice would open
    hostReady = false
    await P.markAllMessagesRead(true)
    expect(P.inboxBulk).toBeNull()
    expect(requests).toEqual([])
    // the Inbox hides while the press waits for bulkReach
    hostReady = true
    reach = 'never'
    vi.useFakeTimers()
    try {
      const asking = P.markAllMessagesRead(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(P.inboxBulk?.state).toBe('asking')
      unhost()
      await vi.advanceTimersByTimeAsync(10_000)
      await asking
      expect(P.inboxBulk).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    // the Inbox hides while the notice waits
    unhost = P.hostInboxNotice({ prepare: () => true })
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    const waiting = P.markAllMessagesRead(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('notice')
    unhost()
    await waiting
    expect(P.inboxBulk).toBeNull()
    expect(requests).toEqual([])
    // a short action needs no Inbox to ask
    reach = null
    const short = P.markAllMessagesRead(true)
    await asked()
    expect(requests).toHaveLength(2)
    await answerAll((r) => ({ marked: 1, hasMore: false, before: r.args.before }))
    await short
  })
})
