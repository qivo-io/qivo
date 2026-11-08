import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    latestAt: '2026-09-14T08:00:00.000Z',
  })
  const task = (title: string) => P().issues.find((issue) => issue.title === title)!
  const user = (name: string) => P().users.find((u) => u.name === name)
  const me = () => snapshot.profiles[0].id

  /* Answers every pending write with `value` in the order they were sent. */
  async function accept(value: unknown = null) {
    for (const request of sent.splice(0)) request.resolve(value)
    await settle()
  }

  /* Follows the task named `title`, a write the server refuses. Its own
     paint must go, and the rollback must not take anything else with it. */
  async function refuseFollow(title = 'Order the brackets') {
    P().setIssueSubscribed(task(title).id, true)
    expect(task(title).subscribed).toBe(true)
    const request = sent.pop()!
    request.reject(new ConvexError({ code: 'not_found', message: 'issue not found' }))
    await settle()
    expect(task(title).subscribed).toBe(false)
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
        snap.messages[0].read_at = '2026-09-15T08:30:00.000Z'
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
      name: 'a follow',
      act: async () => {
        P().setIssueSubscribed(task('Calibrate the sensor').id, true)
        await accept()
      },
      shown: () => expect(task('Calibrate the sensor').subscribed).toBe(true),
      truth: (snap) => {
        snap.issueSubs.push({ issue_id: 'task-a', profile_id: me(), created_at: UNTIL })
      },
    },
    {
      name: 'an unfollow',
      act: async () => {
        P().setIssueSubscribed(task('Replace the gasket').id, false)
        await accept()
      },
      shown: () => expect(task('Replace the gasket').subscribed).toBe(false),
      truth: (snap) => {
        snap.issueSubs = []
      },
    },
    {
      name: 'a message retention change',
      act: async () => {
        P().setMessageRetention(30)
        await accept()
      },
      shown: () => expect(user('Planner')?.messageRetentionDays).toBe(30),
      truth: (snap) => {
        snap.profiles[0].message_retention_days = 30
      },
    },
    {
      // the store holds nobody but the signed-in person, so the removal
      // paints the person's tasks the workspace holds, which the server
      // clears with them
      name: 'a removed seat',
      act: async () => {
        P().removeUser('profile-other', { orgId: P().homeOrg })
        await accept()
      },
      shown: () => expect(task('Replace the gasket').assignee).toBeFalsy(),
      truth: (snap) => {
        snap.profiles.splice(1, 1)
        const gasket = snap.issues.find((t) => t.id === 'task-b')
        if (gasket) delete gasket.assignee_id
      },
    },
  ]

  it.each(writes)(
    'keeps $name saved during trouble on screen after a refused write',
    async ({ act, shown, truth }) => {
      live().fail(new Error(QUERY_FAILURE))
      await act()
      expect(sent).toEqual([])
      shown()
      await refuseFollow()
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
    P().setIssueSubscribed(task('Order the brackets').id, true)
    live().fail(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    expect(P().snapshotTrouble()?.kind).toBe('signed_out')
    sent.pop()!.reject(new ConvexError({ code: 'forbidden', message: 'not signed in' }))
    await settle()
    // the refused write takes back only its own paint, and says why
    expect(task('Order the brackets').subscribed).toBe(false)
    expect(user('Planner')?.messageRetentionDays).toBe(30)
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
    {
      name: 'a follower change',
      act: () =>
        P().setIssueSubscriber(task('Calibrate the sensor').id, 'profile-other', true, () => {}),
    },
  ])('leaves the board alone when $name, which painted nothing, is refused', async ({ act }) => {
    P().updateIssue(task('Calibrate the sensor').id, { status: 'progress' })
    live().fail(new Error(QUERY_FAILURE))
    // saved after the last good delivery, which does not hold it
    await accept()
    act()
    expect(sent).toHaveLength(1)
    sent.pop()!.reject(new ConvexError({ code: 'not_found', message: 'gone' }))
    await settle()
    expect(task('Calibrate the sensor').status).toBe('progress')
    // nothing was painted, so nothing is said to be reverted
    expect(showToast).toHaveBeenCalledWith("Couldn't save.", 'error')
  })

  /* The generic cases below write a follow of the sensor task, a write that
     still goes out during trouble and paints the workspace, beside the one
     refuseFollow refuses. */
  const sensor = () => task('Calibrate the sensor')
  const follow = (on: boolean) => P().setIssueSubscribed(sensor().id, on)

  it('paints accepted writes again in the order the server took them', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    await accept()
    // the unfollow came second, so it must win
    follow(false)
    await accept()
    await refuseFollow()
    expect(sensor().subscribed).toBe(false)
  })

  it('forgets kept writes once a good delivery holds the newer truth', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    await accept()
    await refuseFollow()
    expect(sensor().subscribed).toBe(true)
    // the server took the follow, then another device unfollowed
    deliverTruth(() => {})
    expect(sensor().subscribed).toBe(false)
    await refuseFollow()
    expect(sensor().subscribed).toBe(false)
  })

  it('keeps a pending write on screen when another write is refused first', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    // the refusal answers first and takes away only its own paint
    await refuseFollow()
    expect(sensor().subscribed).toBe(true)
    await accept()
    expect(sensor().subscribed).toBe(true)
  })

  it('paints a write kept after a held delivery once the last write settles', async () => {
    follow(true)
    // another client's change arrives, then the query fails
    deliverTruth(() => {})
    live().fail(new Error(QUERY_FAILURE))
    await accept()
    expect(sensor().subscribed).toBe(true)
  })

  it('keeps no paint of a write the newest delivery already holds once the trouble ended', async () => {
    live().fail(new Error(QUERY_FAILURE))
    deliverTruth(() => {})
    expect(P().snapshotTrouble()).toBeNull()
    follow(true)
    expect(sensor().subscribed).toBe(true)
    // the delivery that holds the follow, which another device undid
    deliverTruth(() => {})
    await accept()
    expect(sensor().subscribed).toBe(false)
    await refuseFollow()
    expect(sensor().subscribed).toBe(false)
  })

  it('keeps the paint of a write accepted after Try again replaced the subscription', async () => {
    live().fail(new Error(QUERY_FAILURE))
    follow(true)
    // a held delivery from before the follow, then Try again
    deliverTruth(() => {})
    P().retrySnapshot()
    await accept()
    expect(sensor().subscribed).toBe(true)
  })

  it('reverts only the refused write outside trouble', async () => {
    follow(true)
    // Convex delivers a write's own snapshot before its promise resolves
    deliverTruth((snap) => {
      snap.issueSubs.push({ issue_id: 'task-a', profile_id: me(), created_at: UNTIL })
    })
    await accept()
    await refuseFollow()
    expect(sensor().subscribed).toBe(true)
    expect(P().snapshotTrouble()).toBeNull()
  })

  it('takes back only the refused edit of three waiting online, at every step', async () => {
    P().updateIssue(task('Calibrate the sensor').id, { title: 'Calibrate sensor A' })
    P().updateIssue(task('Replace the gasket').id, { title: 'Replace gasket B' })
    P().updateIssue(task('Order the brackets').id, { status: 'progress' })
    const [first, middle, last] = sent.splice(0)
    middle.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settle()
    expect(task('Calibrate sensor A')).toBeDefined()
    expect(task('Replace the gasket')).toBeDefined()
    expect(task('Order the brackets').status).toBe('progress')
    first.resolve(null)
    await settle()
    expect(task('Calibrate sensor A')).toBeDefined()
    expect(task('Order the brackets').status).toBe('progress')
    last.resolve(null)
    await settle()
    expect(task('Calibrate sensor A')).toBeDefined()
    expect(task('Order the brackets').status).toBe('progress')
  })

  it('keeps a write a delivery holds and one still waiting when the one between is refused', async () => {
    P().updateIssue(task('Calibrate the sensor').id, { title: 'Calibrate sensor A' })
    P().updateIssue(task('Replace the gasket').id, { title: 'Replace gasket B' })
    P().updateIssue(task('Order the brackets').id, { status: 'progress' })
    const [a, b] = sent.splice(0, 2)
    // the delivery that holds A, then A's answer, then B's refusal
    deliverTruth((snap) => {
      snap.issues[0].title = 'Calibrate sensor A'
    })
    a.resolve(null)
    await settle()
    b.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await settle()
    expect(task('Calibrate sensor A')).toBeDefined()
    expect(task('Replace the gasket')).toBeDefined()
    expect(task('Order the brackets').status).toBe('progress')
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
    await refuseFollow()
    expect(P().orgs[0].slug).toBe('new-address')
    expect(P().user(me.id)?.avatarPath).toBeFalsy()
  })

  it('shows a task archived during trouble and restored elsewhere once the trouble ends', async () => {
    const archived = P().archiveIssue(task('Replace the gasket').id)
    live().fail(new Error(QUERY_FAILURE))
    await accept()
    await expect(archived).resolves.toBe(true)
    expect(P().issues.some((issue) => issue.title === 'Replace the gasket')).toBe(false)
    // someone restored it before the snapshot loaded again
    deliverTruth(() => {})
    expect(P().snapshotTrouble()).toBeNull()
    expect(task('Replace the gasket')).toBeDefined()
    await refuseFollow()
    expect(task('Replace the gasket')).toBeDefined()
  })
})
