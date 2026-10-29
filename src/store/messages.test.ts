import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../convex/lib/workspaceJoin'

type Snapshot = Workspace
type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
/* A paint fault on demand: the next read-mark paint throws once. */
const paintFault = vi.hoisted(() => ({ next: false }))
vi.mock('./viewModels', async (importOriginal) => {
  const real = await importOriginal<typeof import('./viewModels')>()
  return {
    ...real,
    isNewer: (...args: Parameters<typeof real.isNewer>) => {
      if (paintFault.next) {
        paintFault.next = false
        throw new Error('a paint fault')
      }
      return real.isNewer(...args)
    },
  }
})
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
    next_project_num: 1,
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
    milestones: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    readMessageCount: notifications.filter((notification) => notification.read).length,
    unreadTruncated: false,
    readTruncated: false,
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
    paintFault.next = false
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

  const ids = () => P.messages.map((message) => message.id).sort()
  const orgName = (id: string) => snap.orgs.find((org) => org.id === id)?.name

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
    snap.readMessageCount += 1
    publish(structuredClone(snap))
    return org.id
  }

  it('marks all notifications read across seats, prunes groups, and waits for every write', async () => {
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    // nothing changes before bulkReach answers
    expect(P.unreadMessages).toBe(2)
    expect(P.inboxBulk).toMatchObject({ action: 'read', state: 'asking' })
    await asked()
    expect(reachAsked()).toBe(1)
    expect(network.query).toHaveBeenCalledWith(expect.anything(), { action: 'read' })
    expect(P.unreadMessages).toBe(0)
    expect(P.messageGroups).toHaveLength(4)
    expect(P.messages).toHaveLength(4)
    expect(P.messages.every((message) => message.read)).toBe(true)
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
    // Convex delivers the last seat's reads before it answers. Its paint and
    // the flags then end in one repaint, so the screen renders once for them
    const org = requests[1].args.org_id
    for (const message of snap.messages) if (message.org_id === org) message.read_at ??= NOW
    publish(structuredClone(snap))
    let emits = 0
    const stop = P.updates.workspace.subscribe(() => emits++)
    requests[1].resolve({ marked: 1, hasMore: false, before: 25 })
    await marking
    stop()
    expect(emits).toBe(1)
    expect(completed).toBe(true)
    expect(P.inboxBulk).toMatchObject({ state: 'finished', long: false, done: 2, seatsDone: 2 })
    // a short action says nothing: its rows show it
    expect(showToast).not.toHaveBeenCalled()
  })

  it('continues beyond the displayed 500 rows with each seat’s fixed cutoff and adopts new unread arrivals', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    snap.messages = Array.from({ length: 500 }, () => ({
      ...unread,
      id: crypto.randomUUID(),
      issue_id: crypto.randomUUID(),
    }))
    snap.readMessageCount = 0
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
    expect(P.unreadMessages).toBe(0)
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
    snap.readMessageCount = 600
    publish(structuredClone(snap))
    expect(P.unreadMessages).toBe(0)
    requests[2].resolve({ marked: 244, ids: loaded.slice(256), hasMore: true, before: 1234.5 })
    await vi.waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3].args).toEqual({ org_id: firstOrg, before: 1234.5 })
    expect(P.inboxBulk).toMatchObject({ state: 'running', long: true, done: 500, seatsDone: 1 })
    requests[3].resolve({ marked: 88, ids: [], hasMore: false, before: 1234.5 })
    await marking
    expect(P.unreadMessages).toBe(1)
    expect(P.messages.find((message) => message.id === arrival.id)?.read).toBe(false)
    expect(P.readMessageCount).toBe(600)
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

  it('keeps Mark all as read available while the server left unread rows unexamined', async () => {
    // hidden rows used up the server's unread walk, so nothing unread is loaded
    snap.messages = snap.messages.filter((message) => message.read_at)
    snap.unreadTruncated = true
    publish(structuredClone(snap))
    expect(P.unreadMessages).toBe(0)
    expect(P.canMarkAllRead).toBe(true)
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'one', before: 7 })) }

    const marking = P.markAllMessagesRead()
    await asked()
    expect(P.canMarkAllRead).toBe(false)
    expect(requests.map((request) => request.name)).toEqual([
      'messages:markAllRead',
      'messages:markAllRead',
    ])
    // a refused seat restores the server's view, flag included
    const refused = requests[0].args.org_id
    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await vi.waitFor(() => expect(P.canMarkAllRead).toBe(true))
    expect(P.inboxBulk).toMatchObject({ state: 'running', stops: [{ org: refused, done: 0 }] })
    // the stop says so once the action ends
    expect(showToast).not.toHaveBeenCalled()
    requests[1].resolve({ marked: 3, hasMore: false, before: 20 })
    await marking
    expect(P.inboxBulk?.state).toBe('stopped')
    expect(showToast).toHaveBeenCalledWith(
      `Mark all as read stopped in ${orgName(refused)} before it marked any message. They stay unread. You don't have permission for that.`,
      'error',
      expect.objectContaining({ sticky: true, key: `inbox-bulk:read:${refused}` }),
    )

    // once the walk reaches every row, the action has nothing left to do
    snap.unreadTruncated = false
    publish(structuredClone(snap))
    expect(P.canMarkAllRead).toBe(false)
  })

  it('shows a new arrival within a task while mark all as read still runs', async () => {
    const unread = snap.messages.filter((message) => !message.read_at)
    const marking = P.markAllMessagesRead()
    await asked()
    expect(P.unreadMessages).toBe(0)
    const arrival = { ...snap.messages[1], id: crypto.randomUUID(), issue_id: crypto.randomUUID() }
    snap.messages = [...snap.messages, arrival]
    publish(structuredClone(snap))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(P.messages.find((message) => message.id === arrival.id)?.read).toBe(false)
    expect(P.unreadMessages).toBe(1)
    // each seat marks its rows before its cutoff, never the arrival, and
    // Convex delivers that before it answers
    snap.messages = snap.messages.map((m) => (m.id === arrival.id ? m : { ...m, read_at: NOW }))
    publish(structuredClone(snap))
    for (const request of requests) {
      const ids = unread.filter((m) => m.org_id === request.args.org_id).map((m) => m.id)
      request.resolve({ marked: ids.length, ids, hasMore: false, before: 1 })
    }
    await marking
    expect(P.unreadMessages).toBe(1)
  })

  it('restores refused reads and keeps another seat’s completed reads from the latest snapshot', async () => {
    const firstOrg = snap.orgs[0].id
    const secondOrg = snap.orgs[1].id
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    await asked()
    expect(P.unreadMessages).toBe(0)
    const refused = requests.find((request) => request.args.org_id === firstOrg)!
    const successful = requests.find((request) => request.args.org_id === secondOrg)!
    refused.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    // only the refused seat's reads go back; the other seat's still wait
    await vi.waitFor(() => expect(P.unreadMessages).toBe(1))
    expect(completed).toBe(false)
    snap.messages = snap.messages.map((message) =>
      message.org_id === secondOrg ? { ...message, read_at: NOW } : message,
    )
    snap.readMessageCount = 4
    publish(structuredClone(snap))
    successful.resolve({ marked: 1, hasMore: false, before: 200 })
    await marking
    expect(completed).toBe(true)
    expect(P.unreadMessages).toBe(1)
    expect(P.messages.filter((message) => message.read)).toHaveLength(4)
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith(
      "Mark all as read stopped in Testbed Labs before it marked any message. They stay unread. You don't have permission for that.",
      'error',
      expect.objectContaining({ sticky: true, key: `inbox-bulk:read:${firstOrg}` }),
    )
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
    expect(P.unreadMessages).toBe(0)
    const first = () => requests.filter((request) => request.args.org_id === firstOrg)
    first()[0].resolve({ marked: 2, ids: confirmed, hasMore: true, before: 5 })
    await vi.waitFor(() => expect(first()).toHaveLength(2))
    expect(P.inboxBulk).toMatchObject({ done: 2, seatsDone: 0, long: true })
    first()[1].reject(new ConvexError({ code: 'rule', message: 'the organization is read-only' }))
    await vi.waitFor(() => expect(P.inboxBulk?.stops).toHaveLength(1))
    // the rows no batch confirmed are unread again; the confirmed ones stay read
    const seatRows = new Set(snap.messages.filter((m) => m.org_id === firstOrg).map((m) => m.id))
    expect(
      P.messages
        .filter((m) => seatRows.has(m.id) && !m.read)
        .map((m) => m.id)
        .sort(),
    ).toEqual(
      more
        .slice(1)
        .map((m) => m.id)
        .sort(),
    )
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

    // nothing anywhere ends the press without a write
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'none', before: 0 })) }
    requests = []
    snap.messages = snap.messages.map((m) => ({ ...m, read_at: m.read_at ?? NOW }))
    snap.unreadTruncated = true
    publish(structuredClone(snap))
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
    expect(P.unreadMessages).toBeGreaterThan(0)
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
    const before = structuredClone(P.messages)
    P.answerInboxNotice(false)
    // the buttons are back at once
    expect(P.inboxBulk).toBeNull()
    await removal
    expect(requests).toEqual([])
    expect(P.messages).toEqual(before)
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
    expect(P.messages).toEqual([])
    expect(P.unreadMessages).toBe(0)
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
    P.markMessagesRead([unread.id])
    await asked()
    // the read mark goes out and is never answered
    expect(requests.map((r) => r.name)).toEqual(['messages:markRead'])
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
    const mixedTask = snap.messages[0].issue_id
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    await asked()

    expect(ids()).toEqual(unread.map((message) => message.id).sort())
    expect(P.unreadMessages).toBe(2)
    expect(P.messageGroups.find((group) => group.id === mixedTask)).toMatchObject({
      ids: [snap.messages[1].id],
      read: false,
      unreadCount: 1,
    })
    expect(requests).toHaveLength(2)
    for (const org of snap.orgs) {
      const request = requests.find((operation) => operation.args.org_id === org.id)!
      expect(request.name).toBe('messages:removeRead')
      expect(request.args).toEqual({ org_id: org.id })
    }
    expect(P.readMessageCount).toBe(0)

    // A new arrival waits for the deletion's answer or a 0 ms timer.
    const incoming = { ...unread[0], id: crypto.randomUUID(), detail: 'Another update' }
    snap.messages = [...unread, incoming]
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    expect(ids()).not.toContain(incoming.id)
    requests[0].resolve({ removed: 2, hasMore: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    // the arrival shows within a task, while the other seat still waits
    expect(ids()).toContain(incoming.id)

    requests[1].resolve({ removed: 1, hasMore: false })
    await removal
    expect(completed).toBe(true)
    expect(ids()).toEqual(snap.messages.map((message) => message.id).sort())
    expect(P.unreadMessages).toBe(2)
    expect(P.inboxBulk).toMatchObject({ action: 'remove', state: 'finished', done: 3 })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('shows a message reopened elsewhere while Remove all read waits', async () => {
    const reopened = snap.messages.find((message) => message.read_at)!
    const removal = P.deleteReadMessages()
    await asked()
    expect(ids()).not.toContain(reopened.id)
    // another device marks it unread before the server's batch reaches it
    snap.messages = snap.messages.map((m) =>
      m.id === reopened.id ? { ...m, read_at: undefined } : m,
    )
    snap.readMessageCount -= 1
    publish(structuredClone(snap))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(P.messages.find((m) => m.id === reopened.id)?.read).toBe(false)
    for (const request of requests) request.resolve({ removed: 0, ids: [], hasMore: false })
    await removal
    expect(P.messages.find((m) => m.id === reopened.id)?.read).toBe(false)
  })

  it('removes unseen read notifications in repeated batches across every seat', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    snap.messages = Array.from({ length: 500 }, () => ({
      ...unread,
      id: crypto.randomUUID(),
    }))
    // The capped snapshot contains no read rows, but 600 remain on the server.
    snap.readMessageCount = 600
    publish(structuredClone(snap))
    expect(P.messages.every((message) => !message.read)).toBe(true)
    expect(P.readMessageCount).toBe(600)
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many' })) }
    const before = structuredClone(P.messages)
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    await asked()
    expect(P.readMessageCount).toBe(0)
    expect(P.messages).toEqual(before)
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
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    next.resolve({ removed: 256, hasMore: false })
    await removal

    expect(completed).toBe(true)
    expect(requests).toHaveLength(3)
    expect(P.readMessageCount).toBe(0)
    expect(P.messages).toEqual(before)
    expect(showToast).toHaveBeenCalledWith('Removed 600 read notifications.', 'success')
  })

  it.each(['empty', 'unread only'])('does not write for an %s inbox', async (state) => {
    snap.messages = state === 'empty' ? [] : snap.messages.filter((message) => !message.read_at)
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    expect(P.canRemoveRead).toBe(false)
    const before = structuredClone(P.messages)

    await expect(P.deleteReadMessages()).resolves.toBeUndefined()

    expect(requests).toEqual([])
    expect(P.messages).toEqual(before)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('keeps Remove all read available while the server left read rows unexamined', async () => {
    snap.messages = snap.messages.filter((message) => !message.read_at)
    snap.readMessageCount = 0
    snap.readTruncated = true
    publish(structuredClone(snap))
    expect(P.readMessageCount).toBe(0)
    expect(P.canRemoveRead).toBe(true)
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'one' })) }

    const removal = P.deleteReadMessages()
    await asked()
    expect(P.canRemoveRead).toBe(false)
    expect(requests.map((request) => request.name)).toEqual([
      'messages:removeRead',
      'messages:removeRead',
    ])
    for (const request of requests) request.resolve({ removed: 0, hasMore: false })
    await removal
    expect(showToast).not.toHaveBeenCalled()
  })

  it('restores a refused deletion without requiring another snapshot', async () => {
    snap.messages = snap.messages.filter((message) => message.org_id === snap.orgs[0].id)
    snap.orgs = snap.orgs.slice(0, 1)
    snap.profiles = snap.profiles.slice(0, 1)
    snap.myProfileIds = snap.profiles.map((profile) => profile.id)
    snap.readMessageCount = 2
    publish(structuredClone(snap))
    const before = structuredClone(P.messages)
    const removal = P.deleteReadMessages()
    await asked()
    expect(P.messages).toHaveLength(1)
    expect(requests).toHaveLength(1)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await expect(removal).resolves.toBeUndefined()

    expect(P.messages).toEqual(before)
    expect(P.readMessageCount).toBe(2)
    expect(P.unreadMessages).toBe(1)
    expect(showToast).toHaveBeenCalledWith(
      "Remove all read notifications stopped in Testbed Labs before it removed any notification. They stay in the Inbox. You don't have permission for that.",
      'error',
      expect.objectContaining({ sticky: true, key: `inbox-bulk:remove:${snap.orgs[0].id}` }),
    )
  })

  it('restores the cleanup count after a refusal when all read messages are outside the cap', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    snap.messages = Array.from({ length: 500 }, () => ({ ...unread, id: crypto.randomUUID() }))
    snap.readMessageCount = 600
    publish(structuredClone(snap))
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many' })) }
    const before = structuredClone(P.messages)
    const removal = P.deleteReadMessages()
    await asked()
    expect(P.readMessageCount).toBe(0)
    expect(requests).toHaveLength(2)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    requests[1].resolve({ removed: 0, hasMore: false })
    await expect(removal).resolves.toBeUndefined()

    expect(P.messages).toEqual(before)
    expect(P.readMessageCount).toBe(600)
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith(
      `Remove all read notifications stopped in ${orgName(requests[0].args.org_id)} before it removed any notification. They stay in the Inbox. You don't have permission for that.`,
      'error',
      expect.objectContaining({
        sticky: true,
        key: `inbox-bulk:remove:${requests[0].args.org_id}`,
      }),
    )
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
    snap.readMessageCount = 2
    publish(structuredClone(snap))
    successful.resolve({ removed: 1, hasMore: false })
    await removal

    expect(completed).toBe(true)
    expect(ids()).toEqual(snap.messages.map((message) => message.id).sort())
    expect(P.messages.filter((message) => message.read)).toHaveLength(2)
    expect(P.readMessageCount).toBe(2)
    expect(P.unreadMessages).toBe(2)
    expect(showToast).toHaveBeenCalledOnce()
  })

  it('refuses a press while an action runs, and keeps its state for an Inbox mounted later', async () => {
    const marking = P.markAllMessagesRead()
    await asked()
    // the store holds the state, not a component: any later reader sees it
    expect(P.inboxBulk).toMatchObject({ action: 'read', state: 'running', seats: 2 })
    snap.readTruncated = true
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
        const unread = P.unreadMessages
        expect(unread).toBe(3)
        const marking = P.markAllMessagesRead(true)
        await vi.advanceTimersByTimeAsync(answer === 'fail' ? 1 : 9_999)
        if (answer === 'never') {
          expect(P.inboxBulk?.state).toBe('asking')
          await vi.advanceTimersByTimeAsync(1)
        }
        await marking
        expect(P.inboxBulk).toBeNull()
        expect(requests).toEqual([])
        expect(P.unreadMessages).toBe(unread)
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

  it('paints read only the rows loaded at the press, not those that arrive while the notice is open', async () => {
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    const marking = P.markAllMessagesRead(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('notice')
    const arrival = { ...snap.messages[1], id: crypto.randomUUID(), issue_id: crypto.randomUUID() }
    snap.messages = [...snap.messages, arrival]
    publish(structuredClone(snap))
    P.answerInboxNotice(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('running')
    // the press's cutoff leaves the arrival out, and so does the paint
    expect(P.messages.find((m) => m.id === arrival.id)?.read).toBe(false)
    expect(P.unreadMessages).toBe(1)
    await answerAll((r) => ({ marked: 1, ids: [], hasMore: false, before: r.args.before }))
    await marking
  })

  it('waits for a pending read mark before it asks, so Remove all read removes that message', async () => {
    const seat = snap.orgs[1].id
    // the seat's only read message goes, so the server holds none read there
    snap.messages = snap.messages.filter((m) => m.org_id !== seat || !m.read_at)
    snap.readMessageCount = 2
    publish(structuredClone(snap))
    const unread = snap.messages.find((m) => m.org_id === seat && !m.read_at)!
    P.markMessagesRead([unread.id])
    const removal = P.deleteReadMessages()
    await asked()
    // bulkReach waits for the read mark, which the server has not taken yet
    expect(reachAsked()).toBe(0)
    expect(requests.map((r) => r.name)).toEqual(['messages:markRead'])
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
    P.markMessagesUnread([newer.id])
    const marking = P.markAllMessagesRead()
    await asked()
    expect(reachAsked()).toBe(0)
    snap.messages = snap.messages.map((m) => (m.id === newer.id ? { ...m, read_at: undefined } : m))
    requests[0].resolve(null)
    await asked()
    // the seat's cutoff includes the reopened message, which the paint marks
    const mark = requests.find((r) => r.name === 'messages:markAllRead' && r.args.org_id === seat)
    expect(mark?.args.before).toBe(Date.parse(newer.created_at))
    expect(P.messages.find((m) => m.id === newer.id)?.read).toBe(true)
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

  it('ends the action, its paints and its notice when a paint throws after the notice', async () => {
    reach = { seats: snap.orgs.map((org) => ({ org_id: org.id, reach: 'many', before: 5 })) }
    const marking = P.markAllMessagesRead(true)
    await asked()
    expect(P.inboxBulk?.state).toBe('notice')
    paintFault.next = true
    P.answerInboxNotice(true)
    await marking
    expect(paintFault.next).toBe(false)
    // nothing was sent, nothing stays painted, and both buttons are back
    expect(requests).toEqual([])
    expect(P.inboxBulk).toBeNull()
    expect(P.unreadMessages).toBe(2)
    expect(P.canMarkAllRead).toBe(true)
    expect(showToast).toHaveBeenCalledWith(
      'Mark all as read stopped after a fault in Qivo. What it already did stays done.',
      'error',
    )
    // a later press works again
    reach = null
    const again = P.markAllMessagesRead()
    await asked()
    expect(requests).toHaveLength(2)
    await answerAll((r) => ({ marked: 1, hasMore: false, before: r.args.before }))
    await again
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
    snap.unreadTruncated = true
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

describe('snooze through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>
  const UNTIL = '2026-09-15T08:00:00.000Z'

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    requests = []
    network.query.mockImplementation(async (ref, args) =>
      getFunctionName(ref) === 'messages:bulkReach' ? reachOf(snap, args.action) : null,
    )
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
  })

  /* A bulk batch's answer names the rows it changed (convex/messages.ts):
     the seat's unread rows for Mark all as read, its read rows for Remove
     all read, as the server holds them when it answers, snoozed rows left
     out. Answers that name them already stay as they are. */
  function naming(name: string, args: Pending['args'], value: unknown) {
    if (!value || typeof value !== 'object' || 'ids' in value) return value
    const read = name === 'messages:removeRead'
    if (!read && name !== 'messages:markAllRead') return value
    const ids = snap.messages
      .filter((m) => m.org_id === args.org_id && !m.snoozed_until && !!m.read_at === read)
      .map((m) => m.id)
    return { ...value, ids }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  // the fixture's seat-0 task 1 holds one READ row; seat-0 task 0 holds a read and an unread row
  const group = (title: string) => P.messageGroups.find((g) => g.issueTitle === title)!

  it('snoozing a read item marks it unread, hides it from the badge and sends the item to its seat', () => {
    expect(P.unreadMessages).toBe(2)
    expect(P.readMessageCount).toBe(3)
    const item = group('Notification task 2')
    expect(item.read).toBe(true)

    P.snoozeMessages(item.ids, UNTIL)

    const snoozed = group('Notification task 2')
    expect(snoozed.snoozed).toBe(true)
    expect(snoozed.snoozedUntil).toBe(new Date(UNTIL).getTime())
    expect(snoozed.read).toBe(false) // unread again, so it returns bold
    expect(P.unreadMessages).toBe(2) // hidden, so not counted
    expect(P.readMessageCount).toBe(2)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      name: 'messages:snooze',
      args: { org_id: snap.orgs[0].id, ids: item.ids, until: UNTIL },
    })
  })

  it('snoozing an unread item takes it off the badge; null brings it back unread and visible', () => {
    const item = group('Notification task 1')
    expect(item.read).toBe(false)
    P.snoozeMessages(item.ids, UNTIL)
    expect(P.unreadMessages).toBe(1)
    expect(group('Notification task 1').items.every((m) => !m.read)).toBe(true)

    P.snoozeMessages(item.ids, null)
    const back = group('Notification task 1')
    expect(back.snoozed).toBe(false)
    expect(back.read).toBe(false)
    expect(back.wokeAt).toBeNull()
    expect(P.unreadMessages).toBe(2)
    expect(requests.map((r) => r.args)).toMatchObject([
      { ids: item.ids, until: UNTIL },
      { ids: item.ids, until: null },
    ])
  })

  it('a refused snooze restores the row from the server snapshot', async () => {
    const item = group('Notification task 2')
    P.snoozeMessages(item.ids, UNTIL)
    expect(group('Notification task 2').snoozed).toBe(true)
    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce())
    const restored = group('Notification task 2')
    expect(restored.snoozed).toBe(false)
    expect(restored.read).toBe(true)
  })

  it.each([
    ['marking it unread', (ids: string[]) => P.markMessagesUnread(ids)],
    ['snoozing it', (ids: string[]) => P.snoozeMessages(ids, UNTIL)],
  ])(
    'an item whose task is archived elsewhere while on screen: %s shows the refusal and the item leaves',
    async (_, act) => {
      const item = group('Notification task 2')
      act(item.ids)
      expect(requests).toHaveLength(1)
      // the archive's delivery arrives while the write is in flight, without
      // the task's messages, and the server refuses the write
      snap.messages = snap.messages.filter((m) => !item.ids.includes(m.id))
      snap.readMessageCount -= item.ids.length
      publish(structuredClone(snap))
      requests[0].reject(
        new ConvexError({ code: 'rule', message: 'QN-2 is archived and must be restored first' }),
      )
      await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce())
      expect(showToast).toHaveBeenCalledWith(
        'QN-2 is archived and must be restored first. Change reverted.',
        'error',
      )
      expect(P.messageGroups.find((g) => g.issueTitle === 'Notification task 2')).toBeUndefined()
      expect(P.unreadMessages).toBe(2)
    },
  )

  it('mark all as read and remove all read leave a snoozed item alone', async () => {
    const task1 = group('Notification task 1')
    P.snoozeMessages(task1.ids, UNTIL)
    requests[0].resolve(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests.length = 0

    const marking = P.markAllMessagesRead()
    await asked()
    expect(group('Notification task 1').items.every((m) => !m.read)).toBe(true)
    expect(group('Notification task 4').read).toBe(true)
    expect(requests.map((r) => r.name)).toEqual(['messages:markAllRead', 'messages:markAllRead'])
    for (const r of requests) r.resolve({ marked: 1, hasMore: false, before: 1 })
    await marking

    // the server's view after those acts, plus a snoozed row that was read
    // meanwhile: a pending reminder, not clutter
    snap.messages = snap.messages.map((m) => {
      if (task1.ids.includes(m.id)) return { ...m, read_at: undefined, snoozed_until: UNTIL }
      if (m.issue_title === 'Notification task 3') return { ...m, snoozed_until: UNTIL }
      return { ...m, read_at: NOW }
    })
    snap.readMessageCount = 2 // tasks 2 and 4; the server's count skips snoozed rows too
    publish(structuredClone(snap))
    expect(group('Notification task 3').snoozed).toBe(true)
    expect(P.readMessageCount).toBe(2)
    requests.length = 0

    const removing = P.deleteReadMessages()
    await asked()
    expect(group('Notification task 3')).toBeDefined()
    expect(group('Notification task 1')).toBeDefined()
    expect(group('Notification task 2')).toBeUndefined()
    expect(group('Notification task 4')).toBeUndefined()
    expect(P.messages.filter((m) => m.read && m.snoozedUntil === null)).toHaveLength(0)
    expect(requests.map((r) => r.name)).toEqual(['messages:removeRead', 'messages:removeRead'])
    for (const r of requests) r.resolve({ removed: 1, hasMore: false })
    await removing
  })

  it('a delivery that ends a snooze announces the item once, as unread, floated by its wake', () => {
    const task1 = group('Notification task 1')
    const wokeAt = '2026-09-15T08:00:01.000Z'
    snap.messages = snap.messages.map((m) =>
      task1.ids.includes(m.id) ? { ...m, read_at: undefined, woke_at: wokeAt } : m,
    )
    publish(structuredClone(snap))
    const back = group('Notification task 1')
    expect(back.snoozed).toBe(false)
    expect(back.read).toBe(false)
    expect(back.wokeAt).toBe(new Date(wokeAt).getTime())
    expect(back.ts).toBe(new Date(wokeAt).getTime())
    expect(P.messageGroups[0].id).toBe(back.id)
    const notes = (window as { __qivoNotes?: { tag: string; title: string }[] }).__qivoNotes ?? []
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Back from snooze, Notification task 1')
    expect(notes[0].tag).toBe(`${back.id}:${wokeAt}`)

    // the same stamp again is not news
    publish(structuredClone(snap))
    expect(((window as { __qivoNotes?: unknown[] }).__qivoNotes ?? []).length).toBe(1)
  })

  it('opens the inbox through the app on a notification click, and writes no history itself', async () => {
    // the desktop app's bridge, whose click names the notification's tag
    let click: ((tag: string) => void) | undefined
    Object.assign(window, {
      qivoDesktop: {
        notifications: {
          supported: true,
          permission: 'granted',
          show: async () => true,
          onClick: (listener: (tag: string) => void) => {
            click = listener
            return () => {}
          },
        },
      },
    })
    const pushState = vi.fn()
    vi.stubGlobal('history', { pushState })
    const openInbox = vi.fn()
    P.setInboxOpener(openInbox)
    const task1 = group('Notification task 1')
    const wokeAt = '2026-09-15T08:00:01.000Z'
    snap.messages = snap.messages.map((m) =>
      task1.ids.includes(m.id) ? { ...m, read_at: undefined, woke_at: wokeAt } : m,
    )
    publish(structuredClone(snap))
    await new Promise((resolve) => setTimeout(resolve, 0))
    click?.(`${task1.id}:${wokeAt}`)
    // App's openInbox asks before closing a window with unsent text and
    // moves the address only once it goes ahead
    expect(openInbox).toHaveBeenCalledTimes(1)
    expect(pushState).not.toHaveBeenCalled()
  })

  it('a task that comes back into view brings its older unread messages without notifying', () => {
    // the server stamps every delivery; messages up to the previous one are history
    const notes = () => (window as { __qivoNotes?: { title: string }[] }).__qivoNotes ?? []
    const org = snap.orgs[0]
    const seat = snap.profiles[0]
    const task = crypto.randomUUID()
    const message = (title: string, created_at: string) => ({
      id: crypto.randomUUID(),
      org_id: org.id,
      recipient_id: seat.id,
      issue_id: task,
      issue_title: title,
      kind: 'change' as const,
      detail: 'Status changed',
      created_at,
    })
    // access returns: the task and its stored unread message arrive together
    snap.issues = [
      {
        id: task,
        org_id: org.id,
        project_id: crypto.randomUUID(),
        num: 9,
        title: 'Returning task',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    const old = message('Old news', NOW)
    snap.messages = [...snap.messages, old]
    publish(structuredClone(snap))
    expect(notes()).toHaveLength(0)
    expect(P.messages.some((m) => m.id === old.id)).toBe(true)
    // a new message on a task that enters the view still notifies
    const later = crypto.randomUUID()
    snap.issues = [...snap.issues, { ...snap.issues[0], id: later, num: 10, title: 'New task' }]
    snap.messages = [
      ...snap.messages,
      { ...message('Fresh news', '2099-01-01T00:00:00.000Z'), issue_id: later },
    ]
    publish(structuredClone(snap))
    expect(notes().map((n) => n.title)).toEqual([expect.stringContaining('New task')])
  })

  it('silences only a restored task and the parent restored with it among the tasks a delivery brings', () => {
    const notes = () => (window as { __qivoNotes?: { title: string }[] }).__qivoNotes ?? []
    const org = snap.orgs[0]
    const seat = snap.profiles[0]
    const [parent, child, other] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const task = (id: string, num: number, title: string, parent_id?: string) => ({
      id,
      org_id: org.id,
      project_id: crypto.randomUUID(),
      num,
      title,
      description: '',
      status: 'todo' as const,
      priority: 'medium' as const,
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
      ...(parent_id ? { parent_id } : {}),
    })
    // a restore of the subtask from Archived tasks, still on its way
    void P.unarchiveIssue(child, 'Restored subtask', undefined, org.id)
    // one delivery brings it with the parent the server restored with it,
    // and another task, as the delivery that ends a large workspace's load does
    snap.issues = [
      ...snap.issues,
      task(parent, 11, 'Restored parent'),
      task(child, 12, 'Restored subtask', parent),
      task(other, 13, 'Arriving task'),
    ]
    const fresh = (issue_id: string, title: string) => ({
      id: crypto.randomUUID(),
      org_id: org.id,
      recipient_id: seat.id,
      issue_id,
      issue_title: title,
      kind: 'change' as const,
      detail: 'Status changed',
      created_at: '2099-01-01T00:00:00.000Z',
    })
    snap.messages = [
      ...snap.messages,
      fresh(child, 'Restored subtask'),
      fresh(parent, 'Restored parent'),
      fresh(other, 'Arriving task'),
    ]
    snap.delivered_at = '2099-01-01T00:00:01.000Z'
    publish(structuredClone(snap))
    expect(notes().map((n) => n.title)).toEqual([expect.stringContaining('Arriving task')])
  })

  it('judges new messages by the server delivery time, not the browser clock', () => {
    const notes = () => (window as { __qivoNotes?: { title: string }[] }).__qivoNotes ?? []
    const org = snap.orgs[0]
    const task = crypto.randomUUID()
    // the browser clock runs far ahead of the server
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))
    snap.issues = [
      {
        id: task,
        org_id: org.id,
        project_id: crypto.randomUUID(),
        num: 9,
        title: 'Brand new task',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
    ]
    snap.messages = [
      ...snap.messages,
      {
        id: crypto.randomUUID(),
        org_id: org.id,
        recipient_id: snap.profiles[0].id,
        issue_id: task,
        issue_title: 'Brand new task',
        kind: 'change',
        detail: 'Assigned to you',
        // written after the previous delivery, which the server stamped
        created_at: '2026-09-15T08:00:05.000Z',
      },
    ]
    snap.delivered_at = '2026-09-15T08:00:06.000Z'
    publish(structuredClone(snap))
    vi.useRealTimers()
    expect(notes().map((n) => n.title)).toEqual([expect.stringContaining('Brand new task')])
  })

  it('counts read rows like the server, leaving out read rows that are snoozed', () => {
    const [first] = snap.messages
    snap.messages = snap.messages.map((m) =>
      m.id === first.id ? { ...m, read_at: NOW, snoozed_until: '2099-01-01T00:00:00.000Z' } : m,
    )
    snap.readMessageCount = 600
    publish(structuredClone(snap))
    expect(P.readMessageCount).toBe(600)
  })
})
