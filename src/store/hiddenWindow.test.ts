import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { liveOver } from './guard/liveDouble.setup'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'
import type { Row } from './rows'

/* The open task window's reads across a hidden page (store/planner.ts
   watchWindowVisibility). The page's visibility is the gate's, answered
   here by hand. The thread's live window and its history are delivered by
   hand, the task with its links and attachments and the inbox item by
   the live double's stand-ins from the published whole. Everyday values:
   one task, a few comments and one unread message. */

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
/* The page's visibility, which every reader of the gate hears. */
const gate = vi.hoisted(() => ({
  visible: true,
  listeners: new Set<(visibility: { visible: boolean; shownAt: number }) => void>(),
}))
vi.mock('../lib/viewVisibility', async (original) => ({
  ...(await original<typeof import('../lib/viewVisibility')>()),
  watchVisibility: (listener: (visibility: { visible: boolean; shownAt: number }) => void) => {
    gate.listeners.add(listener)
    listener({ visible: gate.visible, shownAt: 0 })
    return () => gate.listeners.delete(listener)
  },
}))

type Comments = { comments: Row<'comments'>[]; earlier: boolean }
type History = { events: Row<'activity_events'>[]; earlier: boolean; next: string | null }
const START = Date.parse('2026-09-14T08:00:00.000Z')
const PAGE = 50

describe('the task window while the page is hidden', () => {
  let store: typeof import('./planner')
  let live: ReturnType<typeof liveOver>
  let snap: Snapshot
  let org: string
  let me: string
  let republish: () => void
  // the store generation before this case's store started
  let floor: number
  // every comment the server holds, which its page before a comment
  // answers from (snapshot.commentsBefore)
  let served: Row<'comments'>[]
  // the thread's and the history's open subscriptions, newest last
  let threads: { publish: (page: Comments) => void; open: boolean }[]
  let histories: { publish: (page: History) => void; open: boolean }[]
  let sent: { name: string; args: Record<string, unknown>; resolve: (value: unknown) => void }[]
  const owner = {}

  const comment = (n: number): Row<'comments'> => ({
    id: `comment-${n}`,
    issue_id: 'task-a',
    author: me,
    body: `#${n}`,
    created_at: new Date(START + n * 60_000).toISOString(),
  })
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, n) => comment(from + n))
  const change = (n: number): Row<'activity_events'> => ({
    id: `event-${n}`,
    org_id: org,
    ts: new Date(START + n * 60_000 + 1000).toISOString(),
    actor_id: me,
    verb: 'moved',
    target_type: 'issue',
    target_id: 'task-a',
    label: 'QN-1',
    detail: 'To Do → In Progress',
  })
  const message = (id: string, minute: number) =>
    snap.messages.push({
      id,
      org_id: org,
      recipient_id: me,
      issue_id: 'task-a',
      issue_title: 'Task 1',
      kind: 'comment',
      detail: 'New comment',
      created_at: new Date(START + minute * 60_000).toISOString(),
    })
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const show = async (visible: boolean) => {
    gate.visible = visible
    for (const listener of gate.listeners) listener({ visible, shownAt: 0 })
    await settle()
  }
  const P = () => store.P
  const thread = () => threads.filter((t) => t.open).at(-1)
  const history = () => histories.filter((h) => h.open).at(-1)
  // the window's reads of task-a open now
  const standIns = () =>
    live
      .opened(floor)
      .filter((w) => w.args.issue_id === 'task-a' || w.args.ref === 'task-a')
      .map((w) => w.name)
      .sort()
  const VIEW_READS = [
    'inbox:item',
    'snapshot:threadComments',
    'snapshot:threadHistory',
    'taskWindow:attachments',
    'taskWindow:links',
    'taskWindow:task',
  ]
  const reads = () => sent.filter((w) => w.name === 'messages:readItem')

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    gate.visible = true
    gate.listeners.clear()
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = underProgram(plannerFixture())
    org = snap.orgs[0].id
    me = snap.profiles[0].id
    snap.issues.push({
      id: 'task-a',
      org_id: org,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Task 1',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: new Date(START).toISOString(),
      updated_at: new Date(START).toISOString(),
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    threads = []
    histories = []
    sent = []
    served = []
    network.query.mockImplementation(async (ref, args: { before?: string }) => {
      if (getFunctionName(ref) !== 'snapshot:commentsBefore') return null
      const at = served.findIndex((c) => c.id === args.before)
      const from = Math.max(0, at - PAGE)
      return { comments: served.slice(from, Math.max(at, 0)), earlier: from > 0 }
    })
    network.mutation.mockImplementation(
      (ref, args) =>
        new Promise((resolve) => {
          const name = getFunctionName(ref)
          if (name === 'identity:claimMySeats') return resolve(null)
          sent.push({ name, args, resolve })
        }),
    )
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') {
        republish = () => receive(structuredClone(snap))
        republish()
        return () => {}
      }
      if (name === 'snapshot:threadComments') {
        const sub = { publish: (page: Comments) => receive(structuredClone(page)), open: true }
        threads.push(sub)
        return () => {
          sub.open = false
        }
      }
      if (name === 'snapshot:threadHistory') {
        const sub = { publish: (page: History) => receive(structuredClone(page)), open: true }
        histories.push(sub)
        return () => {
          sub.open = false
        }
      }
      return () => {}
    })
    store = await import('./planner')
    live = (await import('../lib/convex')).live as unknown as ReturnType<typeof liveOver>
    floor = live.generation()
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /* Opens task-a under All with its details, its thread at `comments`
     comments (the newest 50 delivered) and its history at `changes`. */
  async function open(comments = 3, changes = 2) {
    served = range(0, comments)
    P().watchComments('task-a', org)
    P().showHistory(owner, true)
    P().showSections(owner, true)
    await settle()
    thread()?.publish({
      comments: range(Math.max(0, comments - PAGE), comments),
      earlier: comments > PAGE,
    })
    history()?.publish({
      events: Array.from({ length: changes }, (_, n) => change(n)),
      earlier: false,
      next: null,
    })
    await settle()
  }

  it('stops every view side while hidden, keeps their answers, and reads each afresh on return', async () => {
    message('m-1', 2)
    republish()
    await open()
    expect(standIns()).toEqual(VIEW_READS)
    expect(P().windowRefreshing()).toBe(false)
    const comments = P().comments.map((c) => c.id)
    const changes = P().threadEvents.map((e) => e.id)
    await show(false)
    expect(thread()).toBeUndefined()
    expect(history()).toBeUndefined()
    expect(standIns()).toEqual([])
    // everything loaded stays, none of it current
    expect(P().comments.map((c) => c.id)).toEqual(comments)
    expect(P().threadEvents.map((e) => e.id)).toEqual(changes)
    expect(P().sections?.links.state).toBe('ready')
    expect(P().inboxItem).toMatchObject({ state: 'ok', current: false })
    expect(P().windowRefreshing()).toBe(true)
    await show(true)
    expect(thread()).toBeDefined()
    expect(history()).toBeDefined()
    expect(standIns()).toEqual(VIEW_READS)
    // the double's stand-ins answered; the thread and history still wait
    expect(P().windowRefreshing()).toBe(true)
    thread()?.publish({ comments: range(0, 3), earlier: false })
    await settle()
    expect(P().windowRefreshing()).toBe(true)
    history()?.publish({ events: [change(0), change(1)], earlier: false, next: null })
    await settle()
    expect(P().windowRefreshing()).toBe(false)
    expect(P().inboxItem).toMatchObject({ state: 'ok', current: true })
  })

  it('keeps the unread summary running while hidden', async () => {
    await open()
    await show(false)
    expect(live.opened(floor).map((w) => w.name)).toContain('inbox:summary')
    message('m-2', 3)
    republish()
    await settle()
    expect(P().inboxSummary).toMatchObject({ state: 'ok', current: true })
    expect(P().inboxSummary.answer?.unread_count).toBe(1)
  })

  it('ends refreshing when a side fails on return', async () => {
    await open()
    await show(false)
    live.forceTaskWindow('failed', 'taskWindow:links')
    await show(true)
    thread()?.publish({ comments: range(0, 3), earlier: false })
    history()?.publish({ events: [change(0), change(1)], earlier: false, next: null })
    await settle()
    expect(P().sections?.links.state).toBe('failed')
    expect(P().windowRefreshing()).toBe(false)
    live.forceTaskWindow(null)
  })

  it('sends no read on open while hidden, and reads once from the first answer after the return', async () => {
    await open()
    await show(false)
    // a mention while nobody looks
    message('m-3', 4)
    republish()
    await settle()
    expect(P().readOnOpen('task-a')).toBe(false)
    expect(reads()).toEqual([])
    await show(true)
    await settle()
    expect(P().inboxItem).toMatchObject({ state: 'ok', current: true })
    expect(P().inboxItem?.item?.unread_count).toBe(1)
    expect(P().readOnOpen('task-a')).toBe(true)
    expect(P().readOnOpen('task-a')).toBe(false)
    expect(reads()).toHaveLength(1)
  })

  it("sends nothing from a confirmation's run again that lands while hidden", async () => {
    message('m-4', 2)
    republish()
    await open()
    expect(P().readOnOpen('task-a')).toBe(true)
    await show(false)
    // news past the read's cutoff arrives meanwhile, and the read confirms
    message('m-5', 5)
    republish()
    reads()[0].resolve(null)
    await settle()
    expect(reads()).toHaveLength(1)
    await show(true)
    await settle()
    expect(P().readOnOpen('task-a')).toBe(true)
    expect(reads()).toHaveLength(2)
  })

  it('keeps a comment write accepted while hidden saved until the first fresh delivery holds it', async () => {
    await open()
    void P().addComment('task-a', 'Sent before the hide')
    await settle()
    const write = sent.find((w) => w.name === 'comments:create')
    expect(write).toBeDefined()
    const id = String(write?.args.id)
    await show(false)
    write?.resolve(null)
    await settle()
    // saved, shown once, and not sent again
    expect(P().comments.filter((c) => c.body === 'Sent before the hide')).toHaveLength(1)
    await show(true)
    thread()?.publish({
      comments: [...range(0, 3), { ...comment(10), id, body: 'Sent before the hide' }],
      earlier: false,
    })
    await settle()
    expect(P().comments.filter((c) => c.body === 'Sent before the hide')).toHaveLength(1)
    expect(sent.filter((w) => w.name === 'comments:create')).toHaveLength(1)
  })

  it('keeps the gap when fewer comments than the live window arrive while hidden', async () => {
    await open(PAGE + 20)
    expect(P().commentsEarlier).toBe('more')
    await show(false)
    await show(true)
    // ten new comments, so the live window still starts at a comment it held
    served = range(0, PAGE + 30)
    thread()?.publish({ comments: range(30, PAGE + 30), earlier: true })
    await settle()
    expect(P().comments.at(0)?.id).toBe('comment-20')
    expect(P().comments.at(-1)?.id).toBe(`comment-${PAGE + 29}`)
    expect(P().commentsEarlier).toBe('more')
  })

  it('starts the thread over when more comments than the live window arrive while hidden', async () => {
    await open(PAGE + 20)
    await show(false)
    await show(true)
    // sixty new comments, so the live window meets nothing it held
    served = range(0, PAGE + 80)
    thread()?.publish({ comments: range(PAGE + 80 - PAGE, PAGE + 80), earlier: true })
    await settle()
    expect(P().comments.map((c) => c.id)).toEqual(range(80, PAGE + 80).map((c) => c.id))
  })

  it('starts paused when the store starts again while hidden', async () => {
    await open()
    await show(false)
    await store.initStore()
    await settle()
    P().watchComments('task-a', org)
    await settle()
    expect(thread()).toBeUndefined()
    expect(standIns()).toEqual([])
    // the summary is no view side
    expect(live.opened(floor).map((w) => w.name)).toContain('inbox:summary')
    await show(true)
    expect(thread()).toBeDefined()
    expect(standIns()).toContain('inbox:item')
  })
})
