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

// A commentThread delivery. Its changes default to none.
type Page = { comments: Row<'comments'>[]; earlier: boolean; events?: Row<'activity_events'>[] }
type Deferred = { resolve: (value: null) => void; reject: (reason: unknown) => void }
/* One commentThread subscription: the server's answers to it and whether
   it was unsubscribed. */
type Thread = {
  deliver: (page: Page) => void
  fail: (e: unknown) => void
  /** Hands over the object last delivered again, as Convex does to a new
      listener on a result it still holds. */
  replay: (value: unknown) => void
  closed: boolean
}

const START = Date.parse('2026-09-14T08:00:00.000Z')
// The server's sentence for the 401st comment (convex/model/commentCounts.ts).
const CAP = 'this task has 400 comments, the most a task can have; start a new task to continue'

/* What a comment's writer learns from the store, and what the thread shows
   when its subscription fails. Writes and thread deliveries are answered by
   hand. The server answers a new subscription after a round trip (`later`).
   Comment #n is posted n minutes after START, and change(n) moves the task
   n minutes after START. */
describe('comment drafts and a failed thread in the store', () => {
  let store: typeof import('./planner')
  let author: string
  let org: string
  let threads: Thread[]
  let writes: { name: string; answer: Deferred }[]
  let toast: ReturnType<typeof vi.fn>
  // The failure the client still holds for the thread. ConvexClient keeps a
  // query's last result until the server answers the next subscription to
  // it, and hands it to a new listener on a 0 ms timer unless the server
  // answered that listener first.
  let held: unknown
  // the thread value the double handed over last
  let delivered: unknown

  const comment = (n: number): Row<'comments'> => ({
    id: `comment-${n}`,
    issue_id: 'task-a',
    author,
    body: `#${n}`,
    created_at: new Date(START + n * 60_000).toISOString(),
  })
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, n) => comment(from + n))
  const change = (n: number): Row<'activity_events'> => ({
    id: `event-${n}`,
    org_id: org,
    ts: new Date(START + n * 60_000).toISOString(),
    actor_id: author,
    verb: 'moved',
    target_type: 'issue',
    target_id: 'task-a',
    label: 'QN-1',
    detail: 'To Do → In Progress',
  })
  const bodies = () => store.P.comments.map((c) => c.body)
  const changes = () => store.P.threadEvents.map((e) => e.id)
  const live = () => threads[threads.length - 1]
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  // after the timers queued so far, such as a held result's redelivery
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    toast = vi.fn()
    vi.stubGlobal('window', { showToast: toast })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const snap: Snapshot = plannerFixture()
    author = snap.profiles[0].id
    org = snap.orgs[0].id
    for (const [id, num, title] of [
      ['task-a', 1, 'Soak test'],
      ['task-b', 2, 'Load test'],
    ] as const) {
      snap.issues.push({
        id,
        org_id: org,
        project_id: snap.projects[0].id,
        num,
        title,
        description: '',
        status: 'progress',
        priority: 'medium',
        paused: false,
        created_at: new Date(START).toISOString(),
        updated_at: new Date(START).toISOString(),
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      })
    }
    threads = []
    writes = []
    held = null
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(
      (ref) =>
        new Promise((resolve, reject) => {
          const name = getFunctionName(ref)
          if (name === 'identity:claimMySeats') return resolve(null)
          writes.push({ name, answer: { resolve, reject } })
        }),
    )
    network.onUpdate.mockImplementation((ref, _args, receive, onError) => {
      if (getFunctionName(ref) === 'snapshot:forMe') receive(structuredClone(snap))
      else if (getFunctionName(ref) === 'snapshot:commentThread') {
        let answered = false
        const thread: Thread = {
          deliver: (page) => {
            held = null
            answered = true
            delivered = { events: [], ...page }
            receive(delivered)
          },
          replay: (value) => receive(value),
          fail: (e) => {
            held = e
            answered = true
            onError(e)
          },
          closed: false,
        }
        threads.push(thread)
        const cached = held
        if (cached !== null)
          setTimeout(() => {
            if (!thread.closed && !answered) onError(cached)
          }, 0)
        return () => {
          thread.closed = true
        }
      }
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
    store.P.watchComments('task-a')
    await later()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('posting and editing', () => {
    it('resolves true once the server saves a comment', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      let saved: boolean | undefined
      void P.addComment('task-a', 'Soak run finished').then((v) => {
        saved = v
      })
      expect(bodies()).toEqual(['#1', '#2', '#3', 'Soak run finished'])
      await settle()
      expect(saved).toBeUndefined() // the server has not answered yet
      writes[0].answer.resolve(null)
      await settle()
      expect(saved).toBe(true)
      expect(toast).not.toHaveBeenCalled()
    })

    it('resolves false on a refusal, toasts its sentence and drops the comment', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      const saved = P.addComment('task-a', 'The 401st comment')
      expect(bodies()).toContain('The 401st comment')
      writes[0].answer.reject(new ConvexError({ code: 'rule', message: CAP }))
      expect(await saved).toBe(false)
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining('This task has 400 comments'),
        'error',
      )
      expect(bodies()).toEqual(['#1', '#2', '#3'])
    })

    it('drops a refused comment posted before the thread arrived', async () => {
      const { P } = store
      const saved = P.addComment('task-a', 'Posted while the thread loads')
      expect(bodies()).toEqual(['Posted while the thread loads'])
      writes[0].answer.reject(new ConvexError({ code: 'not_found', message: 'task not found' }))
      expect(await saved).toBe(false)
      expect(bodies()).toEqual([])
    })

    it('resolves whether an edit was saved, and true for the same text without a write', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      expect(await P.updateComment('comment-2', ' #2 ')).toBe(true)
      expect(writes).toHaveLength(0)
      const refused = P.updateComment('comment-2', 'Edited')
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
      writes[0].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' }))
      expect(await refused).toBe(false)
      expect(bodies()).toEqual(['#1', '#2', '#3'])
      const accepted = P.updateComment('comment-2', 'Edited')
      writes[1].answer.resolve(null)
      expect(await accepted).toBe(true)
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
    })
  })

  describe('while the thread fails', () => {
    it('takes a held thread Convex hands Retry for a replay, which ends no failure', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      const old = delivered
      const edited = P.updateComment('comment-2', 'Edited')
      live().fail(new Error('[CONVEX Q(snapshot:commentThread)] Server Error'))
      writes[0].answer.resolve(null)
      expect(await edited).toBe(true)
      P.retryComments()
      live().replay(old)
      await settle()
      expect(P.commentsFailure).toBe('retrying')
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
      // another write's refusal still leaves the saved edit
      const refused = P.updateComment('comment-3', 'Refused')
      writes[1].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' }))
      expect(await refused).toBe(false)
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
    })

    it('keeps a comment waiting for task A off task B, and shows it again on A', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 3), earlier: false })
      const saved = P.addComment('task-a', 'Waiting on A')
      expect(bodies()).toContain('Waiting on A')
      P.watchComments('task-b')
      live().deliver({ comments: [], earlier: false })
      expect(bodies()).toEqual([])
      writes[0].answer.resolve(null)
      expect(await saved).toBe(true)
      expect(bodies()).toEqual([])
      // back on A, the thread shows what the server holds
      P.watchComments('task-a')
      live().deliver({
        comments: [...range(1, 3), { ...comment(3), id: 'posted', body: 'Waiting on A' }],
        earlier: false,
      })
      await settle()
      expect(bodies()).toEqual(['#1', '#2', 'Waiting on A'])
      expect(store.__layerProbe?.layerCount()).toBe(0)
    })

    it('takes back a refused comment for task A while task B is open', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 3), earlier: false })
      const saved = P.addComment('task-a', 'Refused on A')
      P.watchComments('task-b')
      live().deliver({ comments: range(5, 7), earlier: false })
      writes[0].answer.reject(new ConvexError({ code: 'rule', message: CAP }))
      expect(await saved).toBe(false)
      expect(bodies()).toEqual(['#5', '#6'])
      P.watchComments('task-a')
      live().deliver({ comments: range(1, 3), earlier: false })
      expect(bodies()).toEqual(['#1', '#2'])
      expect(store.__layerProbe?.layerCount()).toBe(0)
    })

    it('keeps an edit saved meanwhile when another comment write is refused', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      const edited = P.updateComment('comment-2', 'Edited')
      live().fail(new Error('[CONVEX Q(snapshot:commentThread)] Server Error'))
      writes[0].answer.resolve(null)
      expect(await edited).toBe(true)
      const refused = P.updateComment('comment-3', 'Refused')
      writes[1].answer.reject(new ConvexError({ code: 'forbidden', message: 'not yours' }))
      expect(await refused).toBe(false)
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
      // the next delivery holds the edit
      live().deliver({
        comments: [comment(1), { ...comment(2), body: 'Edited' }, comment(3)],
        earlier: false,
      })
      expect(bodies()).toEqual(['#1', 'Edited', '#3'])
    })
  })

  describe("the task's changes beside the thread", () => {
    it('shows the changes the latest delivery holds, oldest first', () => {
      expect(changes()).toEqual([])
      live().deliver({ comments: range(1, 4), earlier: false, events: [change(3), change(2)] })
      expect(changes()).toEqual(['event-2', 'event-3'])
      expect(store.P.threadEvents[0]).toMatchObject({ targetType: 'issue', targetId: 'QN-1' })
      live().deliver({ comments: range(1, 4), earlier: false })
      expect(changes()).toEqual([])
    })

    it('keeps the delivered changes when the thread fails', () => {
      live().deliver({ comments: range(1, 4), earlier: false, events: [change(2)] })
      live().fail(new Error('Server Error'))
      expect(store.P.commentsFailure).toBe('failed')
      expect(changes()).toEqual(['event-2'])
    })

    it('drops the delivered changes for a task that is gone or hidden', () => {
      live().deliver({ comments: range(1, 4), earlier: false, events: [change(2)] })
      live().fail(new ConvexError({ code: 'not_found', message: 'task not found' }))
      expect(store.P.commentsLoaded).toBe(true)
      expect(changes()).toEqual([])
    })

    it("drops the changes when the window moves to another task, and ignores the old thread's", async () => {
      const { P } = store
      const first = live()
      first.deliver({ comments: range(1, 4), earlier: false, events: [change(2)] })
      P.watchComments('task-b')
      expect(changes()).toEqual([])
      // the old subscription answers once more before it is gone
      first.deliver({ comments: range(1, 4), earlier: false, events: [change(3)] })
      expect(changes()).toEqual([])
      await later()
      live().deliver({ comments: [], earlier: false, events: [change(4)] })
      expect(changes()).toEqual(['event-4'])
      P.watchComments(null)
      expect(changes()).toEqual([])
    })
  })

  describe('a failed thread', () => {
    it('keeps the delivered comments and says the thread failed', () => {
      const { P } = store
      live().deliver({ comments: range(1, 51), earlier: true })
      live().fail(new Error('Server Error'))
      expect(P.commentsFailure).toBe('failed')
      expect(P.commentsLoaded).toBe(true)
      expect(bodies()).toEqual(range(1, 51).map((c) => c.body))
      expect(P.commentsEarlier).toBe('more')
    })

    it('fails without loading when nothing was delivered', () => {
      const { P } = store
      live().fail(new Error('Server Error'))
      expect(P.commentsFailure).toBe('failed')
      expect(P.commentsLoaded).toBe(false)
      expect(bodies()).toEqual([])
    })

    it('ends the failure at the next delivery', () => {
      const { P } = store
      live().fail(new Error('Server Error'))
      live().deliver({ comments: range(1, 4), earlier: false })
      expect(P.commentsFailure).toBe('none')
      expect(bodies()).toEqual(['#1', '#2', '#3'])
    })

    it('loads an empty thread for a task that is gone or hidden', () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      live().fail(new ConvexError({ code: 'not_found', message: 'task not found' }))
      expect(P.commentsFailure).toBe('none')
      expect(P.commentsLoaded).toBe(true)
      expect(bodies()).toEqual([])
    })

    it('keeps the comments on screen when access is gone, and says it failed', () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      // the sign-in or every seat is gone, which the snapshot notice reports
      live().fail(
        new ConvexError({ code: 'forbidden', message: 'no profile in this organization' }),
      )
      expect(P.commentsFailure).toBe('failed')
      expect(P.commentsLoaded).toBe(true)
      expect(bodies()).toEqual(['#1', '#2', '#3'])
    })

    it('retries with a fresh subscription and keeps the comments meanwhile', async () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      const first = live()
      first.fail(new Error('Server Error'))
      P.retryComments()
      expect(first.closed).toBe(true)
      expect(threads).toHaveLength(2)
      expect(P.commentsFailure).toBe('retrying')
      // the client hands the new subscription the old failure first. It is
      // not the server's answer, so the retry goes on.
      await later()
      expect(P.commentsFailure).toBe('retrying')
      expect(bodies()).toEqual(['#1', '#2', '#3'])
      live().fail(new Error('Server Error'))
      expect(P.commentsFailure).toBe('failed')
      P.retryComments()
      await later()
      live().deliver({ comments: range(1, 5), earlier: false })
      expect(P.commentsFailure).toBe('none')
      expect(bodies()).toEqual(['#1', '#2', '#3', '#4'])
    })

    it('shows a failure the server sent before the old one could be replayed', () => {
      vi.useFakeTimers()
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      live().fail(new Error('Server Error'))
      P.retryComments()
      // the server answers the rerun before the store's own timer runs, so
      // the client replays nothing after it, and the answer is skipped
      live().fail(new Error('Server Error'))
      vi.advanceTimersByTime(0)
      expect(P.commentsFailure).toBe('retrying')
      vi.advanceTimersByTime(4999)
      expect(P.commentsFailure).toBe('retrying')
      vi.advanceTimersByTime(1)
      expect(P.commentsFailure).toBe('failed')
      expect(bodies()).toEqual(['#1', '#2', '#3'])
    })

    it('shows the old failure again when the server does not answer a retry', () => {
      vi.useFakeTimers()
      const { P } = store
      live().fail(new Error('Server Error'))
      P.retryComments()
      vi.advanceTimersByTime(4999)
      expect(P.commentsFailure).toBe('retrying')
      vi.advanceTimersByTime(1)
      expect(P.commentsFailure).toBe('failed')
      // the server's later answer still ends it
      live().deliver({ comments: range(1, 3), earlier: false })
      expect(P.commentsFailure).toBe('none')
      expect(bodies()).toEqual(['#1', '#2'])
    })

    it('retries only a failed thread, and ignores the subscription it replaced', () => {
      const { P } = store
      live().deliver({ comments: range(1, 4), earlier: false })
      P.retryComments()
      expect(threads).toHaveLength(1)
      const first = live()
      first.fail(new Error('Server Error'))
      P.retryComments()
      first.deliver({ comments: range(1, 9), earlier: false })
      first.fail(new ConvexError({ code: 'not_found', message: 'task not found' }))
      expect(P.commentsFailure).toBe('retrying')
      expect(bodies()).toEqual(['#1', '#2', '#3'])
    })

    it('forgets the failure when the window moves to another task', async () => {
      const { P } = store
      live().fail(new Error('Server Error'))
      P.watchComments(null)
      expect(P.commentsFailure).toBe('none')
      P.watchComments('task-a')
      expect(P.commentsFailure).toBe('none')
      // opened again at once, the task waits for the server, not the old run
      await later()
      expect(P.commentsFailure).toBe('none')
      expect(P.commentsLoaded).toBe(false)
      live().fail(new Error('Server Error'))
      expect(P.commentsFailure).toBe('failed')
    })
  })
})
