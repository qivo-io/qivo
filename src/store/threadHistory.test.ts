import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

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

/* One subscription the store made: the query, its arguments, the server's
   answers to it and whether it was unsubscribed. */
type Live = {
  name: string
  args: Record<string, unknown>
  deliver: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}
type Deferred<T> = { resolve: (value: T) => void; reject: (reason: unknown) => void }
// A threadHistory or historyBefore page.
type History = { events: Row<'activity_events'>[]; earlier: boolean; next: string | null }

const START = Date.parse('2026-09-14T08:00:00.000Z')

/* The task window's history in the store. Opening a task subscribes its
   comments alone (snapshot.threadComments), and the history
   (snapshot.threadHistory) subscribes only while a window shows All
   (P.showHistory). Deliveries, earlier pages and writes are answered by
   hand. change(n) moves the task n minutes after START. */
describe("the task's history in the store", () => {
  let store: typeof import('./planner')
  let snap: Snapshot
  let author: string
  let subs: Live[]
  let earlier: { before: string; answer: Deferred<History> }[]
  let writes: { name: string; answer: Deferred<unknown> }[]
  // the newest workspace subscription's answer, and while set, what each
  // new one waits for before it answers (a re-init that loads slowly)
  let publishWhole: (snap: Snapshot) => void
  let holdWhole: ((answer: () => void) => void) | null
  // two windows, such as the Inbox pane and its pop-out
  const pane = {}
  const popOut = {}

  const named = (name: string) => subs.filter((s) => s.name === name)
  const open = (name: string) => named(name).filter((s) => !s.closed)
  /* The open subscription of `name`, which the test expects to be the only one. */
  const one = (name: string) => {
    const live = open(name)
    expect(live).toHaveLength(1)
    return live[0]
  }
  const change = (n: number, task = 'task-a'): Row<'activity_events'> => ({
    id: `event-${n}`,
    org_id: snap.orgs[0].id,
    ts: new Date(START + n * 60_000).toISOString(),
    actor_id: author,
    verb: 'moved',
    target_type: 'issue',
    target_id: task,
    label: 'QN-1',
    detail: 'To Do → In Progress',
  })
  const comment = (n: number): Row<'comments'> => ({
    id: `comment-${n}`,
    issue_id: 'task-a',
    author,
    body: `#${n}`,
    created_at: new Date(START + n * 60_000).toISOString(),
  })
  const changes = () => store.P.threadEvents.map((e) => e.id)
  const bodies = () => store.P.comments.map((c) => c.body)
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  // after the timers queued so far
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = plannerFixture()
    author = snap.profiles[0].id
    for (const [id, num] of [
      ['task-a', 1],
      ['task-b', 2],
    ] as const)
      snap.issues.push({
        id,
        org_id: snap.orgs[0].id,
        project_id: snap.projects[0].id,
        num,
        title: `Task ${num}`,
        description: '',
        status: 'progress',
        priority: 'medium',
        paused: false,
        created_at: new Date(START).toISOString(),
        updated_at: new Date(START).toISOString(),
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      })
    subs = []
    earlier = []
    writes = []
    network.query.mockImplementation(
      (ref, args: { before?: string }) =>
        new Promise((resolve, reject) => {
          if (getFunctionName(ref) !== 'snapshot:historyBefore') return resolve(null)
          earlier.push({ before: args.before ?? '', answer: { resolve, reject } })
        }),
    )
    network.mutation.mockImplementation(
      (ref) =>
        new Promise((resolve, reject) => {
          const name = getFunctionName(ref)
          if (name === 'identity:claimMySeats') return resolve(null)
          writes.push({ name, answer: { resolve, reject } })
        }),
    )
    holdWhole = null
    network.onUpdate.mockImplementation((ref, args, receive, onError) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') {
        publishWhole = (value) => receive(structuredClone(value))
        if (holdWhole) holdWhole(() => receive(structuredClone(snap)))
        else receive(structuredClone(snap))
        return () => {}
      }
      const live: Live = { name, args, deliver: receive, fail: onError, closed: false }
      subs.push(live)
      return () => {
        live.closed = true
      }
    })
    store = await import('./planner')
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens a task with its comments and no history', () => {
    store.P.watchComments('task-a')
    expect(subs.map((s) => s.name)).toEqual(['snapshot:threadComments'])
    expect(named('snapshot:threadHistory')).toEqual([])
    expect(store.P.historyLoaded).toBe(false)
  })

  it('subscribes the history once while any window shows All, and drops it when the last leaves', () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    const history = one('snapshot:threadHistory')
    expect(history.args).toEqual({ org_id: snap.orgs[0].id, issue_id: 'task-a' })
    // a second window on the same task shares it
    P.showHistory(popOut, true)
    P.showHistory(pane, true)
    expect(named('snapshot:threadHistory')).toHaveLength(1)
    history.deliver({ events: [change(2), change(3)], earlier: true, next: 'event-2' })
    expect(P.historyLoaded).toBe(true)
    expect(changes()).toEqual(['event-2', 'event-3'])
    expect(P.historyEarlier).toBe('more')
    P.showHistory(pane, false)
    expect(history.closed).toBe(false)
    expect(changes()).toEqual(['event-2', 'event-3'])
    P.showHistory(popOut, false)
    expect(history.closed).toBe(true)
    expect(changes()).toEqual([])
    expect(P.historyLoaded).toBe(false)
    expect(P.historyEarlier).toBe('none')
    // the comments ride on, alone
    expect(open('snapshot:threadComments')).toHaveLength(1)
  })

  it('shows the changes the latest page holds, oldest first, beside comments on their own', () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    one('snapshot:threadHistory').deliver({
      events: [change(3), change(2)],
      earlier: false,
      next: null,
    })
    expect(changes()).toEqual(['event-2', 'event-3'])
    expect(P.threadEvents[0]).toMatchObject({ targetType: 'issue', targetId: 'QN-1' })
    // the comments have not arrived; the history does not wait for them
    expect(P.commentsLoaded).toBe(false)
    one('snapshot:threadHistory').deliver({ events: [], earlier: false, next: null })
    expect(changes()).toEqual([])
  })

  it('keeps the history when the comments fail, and the comments when the history fails', () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    one('snapshot:threadComments').deliver({ comments: [comment(1)], earlier: false })
    one('snapshot:threadHistory').deliver({ events: [change(2)], earlier: false, next: null })
    one('snapshot:threadComments').fail(new Error('Server Error'))
    expect(P.commentsFailure).toBe('failed')
    expect(P.historyFailure).toBe('none')
    expect(changes()).toEqual(['event-2'])
    P.retryComments()
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    one('snapshot:threadHistory').fail(new Error('Server Error'))
    expect(P.historyFailure).toBe('failed')
    expect(bodies()).toEqual(['#1'])
    expect(changes()).toEqual(['event-2'])
  })

  it('starts the history over for another task, for the windows still on All', async () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    const first = one('snapshot:threadHistory')
    first.deliver({ events: [change(2)], earlier: false, next: null })
    P.watchComments('task-b')
    expect(first.closed).toBe(true)
    expect(changes()).toEqual([])
    expect(P.historyLoaded).toBe(false)
    const second = one('snapshot:threadHistory')
    expect(second.args).toMatchObject({ issue_id: 'task-b' })
    // the old subscription's answers are gone with it
    first.deliver({ events: [change(4)], earlier: false, next: null })
    await later()
    expect(changes()).toEqual([])
    second.deliver({ events: [change(5, 'task-b')], earlier: false, next: null })
    expect(changes()).toEqual(['event-5'])
    // no window shows a task: nothing to subscribe
    P.watchComments(null)
    expect(open('snapshot:threadHistory')).toEqual([])
  })

  it('drops an earlier page that answers after the history stopped', async () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    one('snapshot:threadHistory').deliver({
      events: [change(10)],
      earlier: true,
      next: 'event-10',
    })
    void P.loadEarlierHistory()
    expect(earlier.map((e) => e.before)).toEqual(['event-10'])
    expect(P.historyEarlier).toBe('loading')
    P.showHistory(pane, false)
    expect(P.historyEarlier).toBe('none')
    // back on All, the new subscription answers the same page before the
    // old earlier page does
    P.showHistory(pane, true)
    one('snapshot:threadHistory').deliver({ events: [change(10)], earlier: true, next: 'event-10' })
    earlier[0].answer.resolve({ events: [change(1)], earlier: false, next: null })
    await settle()
    expect(changes()).toEqual(['event-10'])
    expect(P.historyEarlier).toBe('more')
    // the new history loads its own earlier page
    void P.loadEarlierHistory()
    expect(earlier).toHaveLength(2)
  })

  it('reads no earlier page before the live page arrives', () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    void P.loadEarlierHistory()
    expect(earlier).toEqual([])
  })

  it('shows a failed history, retries it until the server answers, and loads not_found empty', async () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    const first = one('snapshot:threadHistory')
    first.fail(new Error('Server Error'))
    expect(P.historyFailure).toBe('failed')
    expect(P.historyLoaded).toBe(false)
    // the comments are their own
    expect(P.commentsFailure).toBe('none')
    P.retryHistory()
    expect(first.closed).toBe(true)
    expect(P.historyFailure).toBe('retrying')
    await later()
    expect(P.historyFailure).toBe('retrying')
    one('snapshot:threadHistory').deliver({ events: [change(2)], earlier: false, next: null })
    expect(P.historyFailure).toBe('none')
    expect(changes()).toEqual(['event-2'])
    // a later failure keeps what was delivered
    one('snapshot:threadHistory').fail(new Error('Server Error'))
    expect(P.historyFailure).toBe('failed')
    expect(changes()).toEqual(['event-2'])
    P.retryHistory()
    await later()
    one('snapshot:threadHistory').fail(
      new ConvexError({ code: 'not_found', message: 'task not found' }),
    )
    expect(P.historyFailure).toBe('none')
    expect(P.historyLoaded).toBe(true)
    expect(changes()).toEqual([])
    expect(P.historyEarlier).toBe('none')
  })

  it('keeps an accepted comment on screen when the history arrives before the comments do', async () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    one('snapshot:threadComments').deliver({ comments: [comment(1)], earlier: false })
    const saved = P.addComment('task-a', 'Accepted')
    writes[0].answer.resolve(null)
    expect(await saved).toBe(true)
    expect(bodies()).toEqual(['#1', 'Accepted'])
    // the history is no thread delivery, so the comment's layer stays
    one('snapshot:threadHistory').deliver({ events: [change(2)], earlier: false, next: null })
    expect(bodies()).toEqual(['#1', 'Accepted'])
    expect(changes()).toEqual(['event-2'])
    one('snapshot:threadComments').deliver({
      comments: [comment(1), { ...comment(3), id: 'posted', body: 'Accepted' }],
      earlier: false,
    })
    await settle()
    expect(bodies()).toEqual(['#1', 'Accepted'])
    expect(store.__layerProbe?.layerCount()).toBe(0)
  })

  it('subscribes the history again for its windows after the parts start over', async () => {
    const { P } = store
    P.watchComments('task-a')
    P.showHistory(pane, true)
    const before = one('snapshot:threadHistory')
    before.deliver({ events: [change(2)], earlier: false, next: null })
    await store.initStore()
    await later()
    expect(before.closed).toBe(true)
    const again = one('snapshot:threadHistory')
    expect(again).not.toBe(before)
    expect(one('snapshot:threadComments').args).toMatchObject({ issue_id: 'task-a' })
    // what was delivered stays until the new subscription answers
    expect(changes()).toEqual(['event-2'])
    again.deliver({ events: [change(2), change(3)], earlier: false, next: null })
    expect(changes()).toEqual(['event-2', 'event-3'])
  })

  it('subscribes the history of a task created under All once a delivery holds it', async () => {
    const { P } = store
    P.showHistory(pane, true)
    const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' })
    if (!key) throw new Error('the task was not created')
    const task = P.issueById[key]
    P.watchComments(task.uuid)
    expect(P.historyLoaded).toBe(true)
    expect(P.historyEarlier).toBe('none')
    expect(named('snapshot:threadHistory')).toEqual([])
    // the server holds the task now, and the create answers
    snap.issues.push({
      ...snap.issues[0],
      id: task.uuid,
      num: snap.orgs[0].next_issue_num + 1,
      title: 'New task',
    })
    publishWhole(snap)
    const create = writes.find((w) => w.name === 'issues:create')
    create?.answer.resolve({ num: snap.orgs[0].next_issue_num + 1 })
    await later()
    const history = one('snapshot:threadHistory')
    expect(history.args).toEqual({ org_id: snap.orgs[0].id, issue_id: task.uuid })
    // its first page replaces the empty one, with what it says is earlier
    history.deliver({
      events: [change(2, task.uuid), change(3, task.uuid)],
      earlier: true,
      next: 'event-2',
    })
    await later()
    expect(changes()).toEqual(['event-2', 'event-3'])
    expect(P.historyEarlier).toBe('more')
    void P.loadEarlierHistory()
    expect(earlier.map((e) => e.before)).toEqual(['event-2'])
    // later deliveries keep the one subscription
    publishWhole(snap)
    await later()
    expect(named('snapshot:threadHistory')).toHaveLength(1)
  })

  it("hands on the history a re-init's boot heard before its workspace, and the newest wins", async () => {
    const { P } = store
    P.showHistory(pane, true)
    P.watchComments(null)
    let answerWhole = () => {}
    holdWhole = (answer) => {
      answerWhole = answer
    }
    const again = store.initStore()
    await settle()
    // watched while the boot waits for its workspace: the thread and its
    // history subscribe on the boot's parts and answer before it
    P.watchComments('task-a')
    const history = one('snapshot:threadHistory')
    history.deliver({ events: [change(1)], earlier: false, next: null })
    history.deliver({ events: [change(1), change(2)], earlier: false, next: null })
    await settle()
    expect(changes()).toEqual([])
    holdWhole = null
    answerWhole()
    await again
    await settle()
    expect(changes()).toEqual(['event-1', 'event-2'])
    expect(open('snapshot:threadHistory')).toHaveLength(1)
    history.deliver({ events: [change(1), change(2), change(3)], earlier: false, next: null })
    expect(changes()).toEqual(['event-1', 'event-2', 'event-3'])
  })

  it('gives a task whose create is on its way an empty history', () => {
    const { P } = store
    P.showHistory(pane, true)
    P.watchComments('task-new')
    expect(P.historyLoaded).toBe(true)
    expect(P.historyEarlier).toBe('none')
    expect(named('snapshot:threadHistory')).toEqual([])
    P.showHistory(pane, false)
    expect(P.historyLoaded).toBe(false)
    P.showHistory(pane, true)
    expect(P.historyLoaded).toBe(true)
  })
})
