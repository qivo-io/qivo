import { type FunctionReturnType, getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { api } from '../../convex/_generated/api'

type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
type Planner = typeof import('./planner')['P']

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
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
    gravatar_avatars: false,
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
    activity: [],
    labels: [],
    issueLabels: [],
    issueSubs: [],
    attachments: [],
    orgLoad: [],
    readMessageCount: notifications.filter((notification) => notification.read).length,
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

describe('bulk notification actions through the client store', () => {
  let P: Planner
  let snap: Snapshot
  let publish: (value: Snapshot) => void
  let requests: Pending[]
  let showToast: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = fixture()
    requests = []
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const ids = () => P.messages.map((message) => message.id).sort()

  it('marks all notifications read across seats, prunes groups, and waits for every write', async () => {
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    expect(P.unreadMessages).toBe(0)
    expect(P.messageGroups).toHaveLength(4)
    expect(P.messages).toHaveLength(4)
    expect(P.messages.every((message) => message.read)).toBe(true)
    expect(requests).toHaveLength(2)
    for (const org of snap.orgs) {
      expect(requests.find((request) => request.args.org_id === org.id)).toMatchObject({
        name: 'messages:markAllRead',
        args: { org_id: org.id },
      })
    }
    requests[0].resolve({ marked: 1, hasMore: false, before: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    requests[1].resolve({ marked: 1, hasMore: false, before: 25 })
    await marking
    expect(completed).toBe(true)
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
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    expect(P.unreadMessages).toBe(0)
    const firstOrg = snap.orgs[0].id
    const first = requests.find((request) => request.args.org_id === firstOrg)!
    const other = requests.find((request) => request.args.org_id !== firstOrg)!
    first.resolve({ marked: 256, hasMore: true, before: 1234.5 })
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]).toMatchObject({
      name: 'messages:markAllRead',
      args: { org_id: firstOrg, before: 1234.5 },
    })
    other.resolve({ marked: 0, hasMore: false, before: 0 })
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
    requests[2].resolve({ marked: 256, hasMore: true, before: 1234.5 })
    await vi.waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3].args).toEqual({ org_id: firstOrg, before: 1234.5 })
    requests[3].resolve({ marked: 88, hasMore: false, before: 1234.5 })
    await marking
    expect(P.unreadMessages).toBe(1)
    expect(P.messages.find((message) => message.id === arrival.id)?.read).toBe(false)
    expect(P.readMessageCount).toBe(600)
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each(['empty', 'read only'])('does not mark notifications for an %s inbox', async (state) => {
    snap.messages = state === 'empty' ? [] : snap.messages.filter((message) => message.read_at)
    publish(structuredClone(snap))
    await expect(P.markAllMessagesRead()).resolves.toBeUndefined()
    expect(requests).toEqual([])
  })

  it('restores refused reads and keeps another seat’s completed reads from the latest snapshot', async () => {
    const firstOrg = snap.orgs[0].id
    const secondOrg = snap.orgs[1].id
    let completed = false
    const marking = P.markAllMessagesRead().then(() => {
      completed = true
    })
    expect(P.unreadMessages).toBe(0)
    const refused = requests.find((request) => request.args.org_id === firstOrg)!
    const successful = requests.find((request) => request.args.org_id === secondOrg)!
    refused.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce())
    expect(completed).toBe(false)
    expect(P.unreadMessages).toBe(2)
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
    expect(showToast).toHaveBeenCalledWith("You don't have permission for that — reverted")
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
    expect(requests).toHaveLength(2)
    store.disposeDemoStore()
    for (const request of requests) request.resolve({ marked: 256, hasMore: true, before: 200 })
    await marking
    expect(requests).toHaveLength(2)
    expect(P.messages).toEqual([])
    expect(P.unreadMessages).toBe(0)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removes read messages from mixed groups across seats and waits for every write', async () => {
    const unread = snap.messages.filter((message) => !message.read_at)
    const mixedTask = snap.messages[0].issue_id
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })

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

    // A new arrival is recorded while the optimistic deletion owns the paint.
    const incoming = { ...unread[0], id: crypto.randomUUID(), detail: 'Another update' }
    snap.messages = [...unread, incoming]
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    expect(ids()).not.toContain(incoming.id)
    requests[0].resolve({ removed: 2, hasMore: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(false)
    expect(ids()).not.toContain(incoming.id)

    requests[1].resolve({ removed: 1, hasMore: false })
    await removal
    expect(completed).toBe(true)
    expect(ids()).toEqual(snap.messages.map((message) => message.id).sort())
    expect(P.unreadMessages).toBe(2)
    expect(showToast).not.toHaveBeenCalled()
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
    const before = structuredClone(P.messages)
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
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
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    next.resolve({ removed: 256, hasMore: false })
    await removal

    expect(completed).toBe(true)
    expect(requests).toHaveLength(3)
    expect(P.readMessageCount).toBe(0)
    expect(P.messages).toEqual(before)
    expect(showToast).not.toHaveBeenCalled()
  })

  it.each(['empty', 'unread only'])('does not write for an %s inbox', async (state) => {
    snap.messages = state === 'empty' ? [] : snap.messages.filter((message) => !message.read_at)
    snap.readMessageCount = 0
    publish(structuredClone(snap))
    const before = structuredClone(P.messages)

    await expect(P.deleteReadMessages()).resolves.toBeUndefined()

    expect(requests).toEqual([])
    expect(P.messages).toEqual(before)
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
    expect(P.messages).toHaveLength(1)
    expect(requests).toHaveLength(1)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await expect(removal).resolves.toBeUndefined()

    expect(P.messages).toEqual(before)
    expect(P.readMessageCount).toBe(2)
    expect(P.unreadMessages).toBe(1)
    expect(showToast).toHaveBeenCalledWith("You don't have permission for that — reverted")
  })

  it('restores the cleanup count after a refusal when all read messages are outside the cap', async () => {
    const unread = snap.messages.find((message) => !message.read_at)!
    snap.messages = Array.from({ length: 500 }, () => ({ ...unread, id: crypto.randomUUID() }))
    snap.readMessageCount = 600
    publish(structuredClone(snap))
    const before = structuredClone(P.messages)
    const removal = P.deleteReadMessages()
    expect(P.readMessageCount).toBe(0)
    expect(requests).toHaveLength(2)

    requests[0].reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    requests[1].resolve({ removed: 0, hasMore: false })
    await expect(removal).resolves.toBeUndefined()

    expect(P.messages).toEqual(before)
    expect(P.readMessageCount).toBe(600)
    expect(showToast).toHaveBeenCalledWith("You don't have permission for that — reverted")
  })

  it('waits for another seat after a refusal and reconciles partial success from the latest snapshot', async () => {
    const firstOrg = snap.orgs[0].id
    const secondOrg = snap.orgs[1].id
    let completed = false
    const removal = P.deleteReadMessages().then(() => {
      completed = true
    })
    const refused = requests.find((operation) => operation.args.org_id === firstOrg)!
    const successful = requests.find((operation) => operation.args.org_id === secondOrg)!

    refused.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledOnce())
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
    network.query.mockResolvedValue(null)
    network.onUpdate.mockImplementation((_ref, _args, next) => {
      publish = next
      next(structuredClone(snap))
      return () => {}
    })
    network.mutation.mockImplementation((ref, args) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => requests.push({ name, args, resolve, reject }))
    })
    const store = await import('./planner')
    P = store.P
    await store.initStore()
  })

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

  it('mark all as read and remove all read leave a snoozed item alone', async () => {
    const task1 = group('Notification task 1')
    P.snoozeMessages(task1.ids, UNTIL)
    requests[0].resolve(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    requests.length = 0

    const marking = P.markAllMessagesRead()
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
})
