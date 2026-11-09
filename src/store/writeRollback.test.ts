import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shownOf } from './personShown.setup'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* A refused write rolls back to the server's rows (store/workspaceBase.ts),
   which stay at the last good delivery while the workspace is in trouble. The personal writes the server
   accepted in the meantime must stay on screen. The network double captures
   the snapshot subscription's callbacks, and every mutation stays pending
   until a test settles it. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

type Subscription = { deliver: (snap: Snapshot | null) => void; fail: (error: Error) => void }
type Sent = { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

const QUERY_FAILURE = '[CONVEX Q(workspace:whole)] Server Error'
const UNTIL = '2026-09-20T08:00:00.000Z'

describe('rollback during snapshot trouble', () => {
  let store: typeof import('./planner')
  let snapshot: Snapshot
  let subscriptions: Subscription[]
  // the boot's delivery, as the object the client handed over
  let booted: Snapshot
  let sent: Sent[]
  let showToast: ReturnType<typeof vi.fn>

  const live = () => subscriptions[subscriptions.length - 1]
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const P = () => store.P
  /* The mark of task `task`'s Inbox row (P.inboxMarks). */
  const markOf = (task: string) => P().inboxMarks.get(`${snapshot.orgs[0].id}:${task}`)
  /* The Inbox row of task `task`, as a row action names it. */
  const row = (task: string) => ({
    org: snapshot.orgs[0].id,
    task,
    through: Date.parse('2026-09-14T08:00:00.000Z'),
  })
  const me = () => snapshot.profiles[0].id

  /* Changes the person's message retention to 14 days, a write the server
     refuses, for a case whose own write marks every Inbox item read. */
  async function refuseRetention() {
    const before = P().user(me())?.messageRetentionDays
    P().setMessageRetention(14)
    expect(P().user(me())?.messageRetentionDays).toBe(14)
    sent.pop()!.reject(new ConvexError({ code: 'not_found', message: 'gone' }))
    await settle()
    expect(P().user(me())?.messageRetentionDays).toBe(before)
  }

  /* Answers every pending write with `value` in the order they were sent. */
  async function accept(value: unknown = null) {
    for (const request of sent.splice(0)) request.resolve(value)
    await settle()
  }

  /* Reads the Inbox item of the task named `task`, a personal write that
     still goes out during trouble and that the server refuses. Its own
     paint must go, and the rollback must not take anything else with it. */
  async function refuseRead(task = 'task-z') {
    P().readItem(row(task))
    expect(markOf(task)?.read).toBe(true)
    const request = sent.pop()!
    request.reject(new ConvexError({ code: 'not_found', message: 'issue not found' }))
    await settle()
    expect(markOf(task)?.read).toBeFalsy()
  }

  function addTask(id: string, title: string) {
    snapshot.issues.push({
      id,
      org_id: snapshot.orgs[0].id,
      project_id: snapshot.projects[0].id,
      num: snapshot.issues.length + 1,
      title,
      description: '',
      status: 'todo',
      priority: 'medium',
      created_at: '2026-09-14T08:00:00.000Z',
      updated_at: '2026-09-14T08:00:00.000Z',
      paused: false,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
  }

  function addMessage(id: string, issue: string, read: boolean) {
    snapshot.messages.push({
      id,
      org_id: snapshot.orgs[0].id,
      recipient_id: me(),
      issue_id: issue,
      issue_title: 'Fixture task',
      kind: 'change',
      detail: 'Status changed',
      created_at: '2026-09-14T08:00:00.000Z',
      ...(read ? { read_at: '2026-09-14T09:00:00.000Z' } : {}),
    })
  }

  /* The next good delivery: the last one with `change` applied, as the
     server holds it. */
  function deliverTruth(change: (snap: Snapshot) => void) {
    const next = structuredClone(snapshot)
    change(next)
    next.delivered_at = '2026-09-15T09:00:00.000Z'
    live().deliver(next)
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    showToast = vi.fn()
    vi.stubGlobal('window', { showToast, setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    snapshot = plannerFixture()
    addTask('task-a', 'Calibrate the sensor')
    addTask('task-b', 'Replace the gasket')
    snapshot.issues[1].assignee_id = 'profile-other'
    addTask('task-z', 'Order the brackets')
    addMessage('message-a', 'task-a', false)
    addMessage('message-b', 'task-b', true)
    addMessage('message-z', 'task-z', false)
    snapshot.issueSubs.push({
      issue_id: 'task-b',
      profile_id: me(),
      created_at: '2026-09-14T08:00:00.000Z',
    })
    snapshot.profiles.push({
      ...snapshot.profiles[0],
      id: 'profile-other',
      auth_user_id: undefined,
      name: 'Field tech',
      initials: 'FT',
      org_role: 'user',
      created_at: '2026-09-14T09:00:00.000Z',
    })
    subscriptions = []
    sent = []
    // bulkReach says each seat has one batch to do, so a bulk action
    // starts without the keep-open notice
    network.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === 'messages:bulkReach'
        ? { seats: snapshot.orgs.map((org) => ({ org_id: org.id, reach: 'one', before: 1 })) }
        : null,
    )
    network.onUpdate.mockImplementation((ref, _args, deliver, fail) => {
      if (getFunctionName(ref) === 'workspace:whole') {
        subscriptions.push({ deliver, fail })
        if (subscriptions.length === 1) {
          booted = structuredClone(snapshot)
          deliver(booted)
        }
      }
      return vi.fn()
    })
    network.mutation.mockImplementation((ref) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      return new Promise((resolve, reject) => sent.push({ name, resolve, reject }))
    })
    store = await import('./planner')
    await store.initStore()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /* Each personal write that still goes out during trouble: what it does,
     what the screen shows once it saved, and the server's copy of it. */
  const writes: {
    name: string
    act: () => Promise<void>
    shown: () => void
    truth: (snap: Snapshot) => void
    /** the refused write beside it, the read of task-z's item by default */
    refuse?: () => Promise<void>
  }[] = [
    {
      name: 'an item read',
      act: async () => {
        P().readItem(row('task-a'))
        await accept()
      },
      shown: () => expect(markOf('task-a')).toMatchObject({ read: true, settled: true }),
      truth: (snap) => {
        snap.messages[0].read_at = '2026-09-15T08:30:00.000Z'
      },
    },
    {
      name: 'mark all as read',
      refuse: () => refuseRetention(),
      act: async () => {
        const done = P().markAllMessagesRead()
        await settle()
        await accept({ marked: 1, ids: ['message-a'], hasMore: false, before: 1 })
        await done
      },
      shown: () => {
        // the action's availability follows the unread summary, which
        // fails with the whole, so it stays available until the summary
        // answers again, and then the server says nothing is unread
        expect(P().canMarkAllRead).toBe(P().inboxSummary.state !== 'ok')
      },
      truth: (snap) => {
        for (const message of snap.messages)
          if (!message.read_at) message.read_at = '2026-09-15T08:30:00.000Z'
      },
    },
    {
      name: 'an item back to unread',
      act: async () => {
        P().unreadItem(row('task-b'))
        await accept()
      },
      shown: () => expect(markOf('task-b')).toMatchObject({ read: false, settled: true }),
      truth: (snap) => {
        snap.messages[1].read_at = undefined
      },
    },
    {
      name: 'a snooze',
      act: async () => {
        P().snoozeItem(row('task-a'), UNTIL)
        await accept()
      },
      shown: () => expect(markOf('task-a')).toMatchObject({ snoozedUntil: UNTIL, settled: true }),
      truth: (snap) => {
        snap.messages[0].snoozed_until = UNTIL
      },
    },
    {
      name: 'a removed item',
      act: async () => {
        P().removeItem(row('task-a'))
        await accept()
      },
      shown: () => expect(markOf('task-a')).toMatchObject({ removed: true, settled: true }),
      truth: (snap) => {
        snap.messages.splice(0, 1)
      },
    },
    {
      name: 'remove all read',
      act: async () => {
        const done = P().deleteReadMessages()
        await settle()
        await accept({ removed: 1, ids: ['message-b'], hasMore: false })
        await done
      },
      shown: () => {
        // as for mark all as read, from the unread summary
        expect(P().canRemoveRead).toBe(P().inboxSummary.state !== 'ok')
      },
      truth: (snap) => {
        snap.messages.splice(1, 1)
      },
    },
    {
      name: 'a message retention change',
      act: async () => {
        P().setMessageRetention(30)
        await accept()
      },
      shown: () => expect(P().user(me())?.messageRetentionDays).toBe(30),
      truth: (snap) => {
        snap.profiles[0].message_retention_days = 30
      },
    },
  ]

  it.each(writes)(
    'keeps $name saved during trouble on screen after a refused write',
    async ({ act, shown, truth, refuse = () => refuseRead() }) => {
      live().fail(new Error(QUERY_FAILURE))
      await act()
      expect(sent).toEqual([])
      shown()
      await refuse()
      shown()
      deliverTruth(truth)
      expect(P().snapshotTrouble()).toBeNull()
      shown()
    },
  )

  it('keeps writes saved before a lost sign-in when a write in flight is refused', async () => {
    live().fail(new Error(QUERY_FAILURE))
    P().setMessageRetention(30)
    P().snoozeItem(row('task-b'), UNTIL)
    await accept()
    P().readItem(row('task-z'))
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    expect(P().snapshotTrouble()?.kind).toBe('signed_out')
    sent.pop()!.reject(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    await settle()
    // the refused write takes back only its own paint, and says why
    expect(markOf('task-z')?.read).toBeFalsy()
    expect(P().user(me())?.messageRetentionDays).toBe(30)
    expect(markOf('task-b')).toMatchObject({ snoozedUntil: UNTIL, settled: true })
    expect(showToast).toHaveBeenCalledWith(store.SIGNED_OUT_TEXT, 'error')
    expect(showToast).not.toHaveBeenCalledWith(
      "You don't have permission for that. Change reverted.",
      'error',
    )
  })

  it.each([
    {
      name: 'an appearance save',
      act: () =>
        void P()
          .setAppearance({ mode: 'dark', image_source: 'none' })
          .catch(() => {}),
    },
  ])('leaves the rows alone when $name, which painted nothing, is refused', async ({ act }) => {
    P().setMessageRetention(30)
    live().fail(new Error(QUERY_FAILURE))
    // saved after the last good delivery, which does not hold it
    await accept()
    act()
    expect(sent).toHaveLength(1)
    sent.pop()!.reject(new ConvexError({ code: 'not_found', message: 'gone' }))
    await settle()
    expect(P().user(me())?.messageRetentionDays).toBe(30)
    // nothing was painted, so nothing is said to be reverted
    expect(showToast).toHaveBeenCalledWith("Couldn't save.", 'error')
  })

  /* The generic cases below write the person's message retention, a write
     that still goes out during trouble and paints the workspace, beside the
     one refuseRead refuses. Days 30 stands for on, and the stored 7 for
     off. */
  const retention = () => P().user(me())?.messageRetentionDays === 30
  const follow = (on: boolean) => P().setMessageRetention(on ? 30 : 7)

  it('paints accepted writes again in the order the server took them', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    await accept()
    // the unfollow came second, so it must win
    follow(false)
    await accept()
    await refuseRead()
    expect(retention()).toBe(false)
  })

  it('forgets kept writes once a good delivery holds the newer truth', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    await accept()
    await refuseRead()
    expect(retention()).toBe(true)
    // the server took the follow, then another device unfollowed
    deliverTruth(() => {})
    expect(retention()).toBe(false)
    await refuseRead()
    expect(retention()).toBe(false)
  })

  it('keeps a pending write on screen when another write is refused first', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    // the refusal answers first and takes away only its own paint
    await refuseRead()
    expect(retention()).toBe(true)
    await accept()
    expect(retention()).toBe(true)
  })

  it('paints a write kept after a held delivery once the last write settles', async () => {
    follow(true)
    // another client's change arrives, then the query fails
    deliverTruth(() => {})
    live().fail(new Error(QUERY_FAILURE))
    await accept()
    expect(retention()).toBe(true)
  })

  it('keeps no paint of a write the newest delivery already holds once the trouble ended', async () => {
    live().fail(new Error(QUERY_FAILURE))
    deliverTruth(() => {})
    expect(P().snapshotTrouble()).toBeNull()
    follow(true)
    expect(retention()).toBe(true)
    // the delivery that holds the follow, which another device undid
    deliverTruth(() => {})
    await accept()
    expect(retention()).toBe(false)
    await refuseRead()
    expect(retention()).toBe(false)
  })

  it('keeps the paint of a write accepted after Try again replaced the subscription', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    // a held delivery from before the follow, then Try again
    deliverTruth(() => {})
    P().retrySnapshot()
    await accept()
    expect(retention()).toBe(true)
  })

  it('reverts only the refused write outside trouble', async () => {
    follow(true)
    // Convex delivers a write's own snapshot before its promise resolves
    deliverTruth((snap) => {
      snap.profiles[0].message_retention_days = 30
    })
    await accept()
    await refuseRead()
    expect(retention()).toBe(true)
    expect(P().snapshotTrouble()).toBeNull()
  })

  /* Three edits of the workspace's rows, each its own field: the
     organization's name, the person's message retention and the
     person's plannable hours. */
  const editThree = () => {
    void P().setOrg({ name: 'Renamed Labs' })
    P().setMessageRetention(30)
    P().updateUser(me(), { plannableHours: 30 }, {}, shownOf(snapshot, me()))
  }

  it('takes back only the refused edit of three waiting online, at every step', async () => {
    editThree()
    const [first, middle, last] = sent.splice(0)
    middle.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settle()
    expect(P().org.name).toBe('Renamed Labs')
    expect(retention()).toBe(false)
    expect(P().user(me())?.plannableHours).toBe(30)
    first.resolve(null)
    await settle()
    expect(P().org.name).toBe('Renamed Labs')
    expect(P().user(me())?.plannableHours).toBe(30)
    last.resolve(null)
    await settle()
    expect(P().org.name).toBe('Renamed Labs')
    expect(P().user(me())?.plannableHours).toBe(30)
  })

  it('keeps a write a delivery holds and one still waiting when the one between is refused', async () => {
    editThree()
    const [a, b] = sent.splice(0, 2)
    // the delivery that holds A, then A's answer, then B's refusal
    deliverTruth((snap) => {
      snap.orgs[0].name = 'Renamed Labs'
    })
    a.resolve(null)
    await settle()
    b.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settle()
    expect(P().org.name).toBe('Renamed Labs')
    expect(retention()).toBe(false)
    expect(P().user(me())?.plannableHours).toBe(30)
  })

  it('keeps an accepted address and portrait change during trouble after a refused write', async () => {
    const me = snapshot.profiles[0]
    snapshot.profiles[0] = { ...me, avatar_storage_id: 'storage-1' as typeof me.avatar_storage_id }
    deliverTruth(() => {})
    const slug = P().setOrgSlug('new-address')
    const cleared = P().clearAvatar(me.id, P().user(me.id)?.avatarPath ?? null)
    live().fail(new Error(QUERY_FAILURE))
    await accept()
    await expect(slug).resolves.toBeNull()
    await expect(cleared).resolves.toBeNull()
    expect(P().orgs[0].slug).toBe('new-address')
    expect(P().user(me.id)?.avatarPath).toBeFalsy()
    await refuseRead()
    expect(P().orgs[0].slug).toBe('new-address')
    expect(P().user(me.id)?.avatarPath).toBeFalsy()
  })
})
