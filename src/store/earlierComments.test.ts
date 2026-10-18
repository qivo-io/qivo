import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', () => ({ convex: network }))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

type Page = { comments: Row<'comments'>[]; earlier: boolean }
type Deferred<T> = { resolve: (value: T) => void; reject: (reason: unknown) => void }

const START = Date.parse('2026-09-14T08:00:00.000Z')

/* "Show earlier comments" in the store. The task window subscribes to the
   thread's live window (snapshot.commentThread) and reads earlier pages once
   (snapshot.commentsBefore). Comment #n is posted n minutes after START. */
describe('earlier comments in the store', () => {
  let store: typeof import('./planner')
  let author: string
  let publish: (page: Page) => void
  // each commentsBefore call, with the `before` it asked about
  let asked: { before: string; answer: Deferred<Page> }[]
  let writes: { name: string; answer: Deferred<null> }[]

  const comment = (n: number): Row<'comments'> => ({
    id: `comment-${n}`,
    issue_id: 'task-a',
    author,
    body: `#${n}`,
    created_at: new Date(START + n * 60_000).toISOString(),
  })
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, n) => comment(from + n))
  const bodies = () => store.P.comments.map((c) => c.body)
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  /* Starts loading the earlier page and returns its pending answer. */
  const load = () => {
    void store.P.loadEarlierComments()
    return asked[asked.length - 1]
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', { showToast: vi.fn() })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const snap: Snapshot = plannerFixture()
    author = snap.profiles[0].id
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Soak test',
      description: '',
      status: 'progress',
      priority: 'medium',
      paused: false,
      created_at: new Date(START).toISOString(),
      updated_at: new Date(START).toISOString(),
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    asked = []
    writes = []
    network.query.mockImplementation(
      (ref, args: { before?: string }) =>
        new Promise((resolve, reject) => {
          if (getFunctionName(ref) !== 'snapshot:commentsBefore') return resolve(null)
          asked.push({ before: args.before ?? '', answer: { resolve, reject } })
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
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'snapshot:forMe') receive(structuredClone(snap))
      else if (getFunctionName(ref) === 'snapshot:commentThread') publish = receive
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
    store.P.watchComments('task-a')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('offers earlier comments only while the thread holds some', () => {
    const { P } = store
    expect(P.commentsEarlier).toBe('none') // nothing loaded yet
    publish({ comments: range(50, 100), earlier: true })
    expect(P.commentsEarlier).toBe('more')
    publish({ comments: range(0, 30), earlier: false })
    expect(P.commentsEarlier).toBe('none')
  })

  it('loads the page before the oldest comment, above it, until the start of the thread', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    const first = load()
    expect(first.before).toBe('comment-100')
    expect(P.commentsEarlier).toBe('loading')
    // one load at a time
    void P.loadEarlierComments()
    expect(asked).toHaveLength(1)
    first.answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    expect(bodies()).toEqual(range(50, 150).map((c) => c.body))
    expect(P.commentsEarlier).toBe('more')
    const second = load()
    expect(second.before).toBe('comment-50')
    second.answer.resolve({ comments: range(0, 50), earlier: false })
    await settle()
    expect(bodies()).toEqual(range(0, 150).map((c) => c.body))
    expect(P.commentsEarlier).toBe('none')
    // nothing is asked once the start is loaded
    void P.loadEarlierComments()
    expect(asked).toHaveLength(2)
  })

  it('asks before the first comment in thread order, not the one with the oldest time', () => {
    publish({ comments: [comment(60), comment(55), ...range(61, 70)], earlier: true })
    expect(load().before).toBe('comment-60')
  })

  it('shows a failed load and retries it', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    load().answer.reject(new Error('offline'))
    await settle()
    expect(P.commentsEarlier).toBe('failed')
    expect(bodies()).toEqual(range(100, 150).map((c) => c.body))
    const retry = load()
    expect(retry.before).toBe('comment-100')
    expect(P.commentsEarlier).toBe('loading')
    retry.answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    expect(bodies()).toHaveLength(100)
    expect(P.commentsEarlier).toBe('more')
  })

  it('keeps what was loaded while new comments arrive and the live window moves on', async () => {
    publish({ comments: range(100, 150), earlier: true })
    const page = load()
    // two comments arrive while the page loads
    publish({ comments: range(102, 152), earlier: true })
    page.answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    expect(bodies()).toEqual(range(50, 152).map((c) => c.body))
    publish({ comments: range(110, 160), earlier: true })
    expect(bodies()).toEqual(range(50, 160).map((c) => c.body))
    expect(load().before).toBe('comment-50')
  })

  it('keeps comments that leave the live window even before any earlier page loads', () => {
    publish({ comments: range(0, 50), earlier: false })
    publish({ comments: range(5, 55), earlier: true })
    expect(bodies()).toEqual(range(0, 55).map((c) => c.body))
    expect(store.P.commentsEarlier).toBe('none')
  })

  it("drops a short thread's first comment that someone else deleted", () => {
    publish({ comments: range(0, 30), earlier: false })
    publish({ comments: range(1, 30), earlier: false })
    expect(bodies()).toEqual(range(1, 30).map((c) => c.body))
    expect(store.P.commentsEarlier).toBe('none')
  })

  it('drops a loaded first comment that someone else deleted', async () => {
    publish({ comments: range(1, 51), earlier: true })
    load().answer.resolve({ comments: [comment(0)], earlier: false })
    await settle()
    expect(bodies()).toEqual(range(0, 51).map((c) => c.body))
    // the live window now starts the thread
    publish({ comments: range(1, 51), earlier: false })
    expect(bodies()).toEqual(range(1, 51).map((c) => c.body))
  })

  it('starts over from the live window when it no longer meets what was loaded', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    const page = load()
    page.answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    // more comments arrived between two deliveries than the window holds
    publish({ comments: range(160, 210), earlier: true })
    expect(bodies()).toEqual(range(160, 210).map((c) => c.body))
    expect(P.commentsEarlier).toBe('more')
    expect(load().before).toBe('comment-160')
  })

  it('drops a page that would leave a hole after the thread started over', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    const page = load()
    publish({ comments: range(160, 210), earlier: true })
    page.answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    expect(bodies()).toEqual(range(160, 210).map((c) => c.body))
    expect(P.commentsEarlier).toBe('more')
  })

  it('drops an oldest comment deleted meanwhile and asks before the next one', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    const first = load()
    first.answer.reject(
      new ConvexError({
        code: 'bad_request',
        message: 'before must be the id of a comment on this task',
      }),
    )
    await settle()
    const next = asked[1]
    expect(next.before).toBe('comment-101')
    next.answer.resolve({ comments: range(50, 100), earlier: false })
    await settle()
    expect(bodies()).toEqual([...range(50, 100), ...range(101, 150)].map((c) => c.body))
    expect(P.commentsEarlier).toBe('none')
  })

  it('asks before the next comment when my delete of the oldest one settles first', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    load().answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    P.deleteComment('comment-50')
    const page = load()
    expect(page.before).toBe('comment-50')
    writes[0].answer.resolve(null)
    await settle()
    page.answer.reject(
      new ConvexError({
        code: 'bad_request',
        message: 'before must be the id of a comment on this task',
      }),
    )
    await settle()
    expect(asked[2].before).toBe('comment-51')
    expect(P.commentsEarlier).toBe('loading')
  })

  it('keeps my saved edit and delete of an earlier comment through later deliveries', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    load().answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    P.updateComment('comment-60', 'Edited')
    P.deleteComment('comment-61')
    for (const write of writes) write.answer.resolve(null)
    await settle()
    // a later delivery re-adopts the thread from the server's rows
    publish({ comments: range(101, 151), earlier: true })
    const shown = new Map(P.comments.map((c) => [c.id, c.body]))
    expect(shown.get('comment-60')).toBe('Edited')
    expect(shown.has('comment-61')).toBe(false)
    expect(shown.get('comment-100')).toBe('#100')
  })

  it('shows my saved edit and delete of an earlier comment after another write is refused', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    load().answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    P.updateComment('comment-60', 'Edited')
    P.deleteComment('comment-61')
    P.updateComment('comment-120', 'Refused')
    // the refusal repaints the thread from the server's rows, which the two
    // earlier writes have not reached yet
    writes[2].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' }))
    await settle()
    writes[0].answer.resolve(null)
    writes[1].answer.resolve(null)
    await settle()
    const shown = new Map(P.comments.map((c) => [c.id, c.body]))
    expect(shown.get('comment-60')).toBe('Edited')
    expect(shown.has('comment-61')).toBe(false)
    expect(shown.get('comment-120')).toBe('#120')
  })

  it('a refused edit of an earlier comment restores its text', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    load().answer.resolve({ comments: range(50, 100), earlier: true })
    await settle()
    P.updateComment('comment-60', 'Refused')
    writes[0].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' }))
    await settle()
    expect(P.comments.find((c) => c.id === 'comment-60')?.body).toBe('#60')
  })

  it('ignores a page that arrives after the task window moved on', async () => {
    const { P } = store
    publish({ comments: range(100, 150), earlier: true })
    const page = load()
    P.watchComments(null)
    P.watchComments('task-a')
    publish({ comments: range(100, 150), earlier: true })
    page.answer.resolve({ comments: range(50, 100), earlier: false })
    await settle()
    expect(bodies()).toHaveLength(50)
    expect(P.commentsEarlier).toBe('more')
  })
})
