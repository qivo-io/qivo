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

type Comments = { comments: Row<'comments'>[]; earlier: boolean }
type History = { events: Row<'activity_events'>[]; earlier: boolean; next: string | null }
type Deferred<T> = { resolve: (value: T) => void; reject: (reason: unknown) => void }

const START = Date.parse('2026-09-14T08:00:00.000Z')
const PAGE = 50

/* The task window's thread past its budget in the store
   (lib/threadBudget.ts THREAD_KEEP, lowered here). The thread's live window
   (snapshot.threadComments) and history page (threadHistory) are delivered
   by hand. Each one-shot read (commentsBefore, historyBefore) waits in
   `asked` until a test answers it, or, with `serve`, the stand-in thread
   answers it at once as the server pages it. Comment #n is posted n
   minutes after START, change #n n minutes and a second after it. */
describe('the task window keeps a bounded thread', () => {
  let store: typeof import('./planner')
  let budget: typeof import('../lib/threadBudget')
  // the figure the module holds, which each test lowers and gives back
  let figure: number
  let snap: Snapshot
  let author: string
  let publish: (page: Comments) => void
  let publishHistory: (page: History) => void
  let failThread: (error: unknown) => void
  let asked: { name: string; before: string; answer: Deferred<unknown> }[]
  let writes: { name: string; answer: Deferred<unknown> }[]
  // with it set, the reads answer from this thread at once
  let serve: { comments: Row<'comments'>[]; history: Row<'activity_events'>[] } | null
  const pane = {}
  const popOut = {}

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
    org_id: snap.orgs[0].id,
    ts: new Date(START + n * 60_000 + 1000).toISOString(),
    actor_id: author,
    verb: 'moved',
    target_type: 'issue',
    target_id: 'task-a',
    label: 'QN-1',
    detail: 'To Do → In Progress',
  })
  const changes = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, n) => change(from + n))
  const ids = (from: number, to: number, kind = 'comment') =>
    Array.from({ length: to - from }, (_, n) => `${kind}-${from + n}`)
  const shown = () => store.P.comments.map((c) => c.id)
  const shownChanges = () => store.P.threadEvents.map((e) => e.id)
  const held = () => store.P.comments.length + store.P.threadEvents.length
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const last = (name = 'snapshot:commentsBefore') => asked.filter((a) => a.name === name).at(-1)
  const notAComment = () =>
    new ConvexError({
      code: 'bad_request',
      message: 'before must be the id of a comment on this task',
    })

  /* The page of `list` before the row `before`, as the server answers it. */
  function pageOf<T extends { id: string }>(list: T[], before: string) {
    const at = list.findIndex((row) => row.id === before)
    if (at === -1) throw notAComment()
    const from = Math.max(0, at - PAGE)
    return { rows: list.slice(from, at), earlier: from > 0 }
  }

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
    asked = []
    writes = []
    serve = null
    network.query.mockImplementation(
      (ref, args: { before?: string }) =>
        new Promise((resolve, reject) => {
          const name = getFunctionName(ref)
          if (name !== 'snapshot:commentsBefore' && name !== 'snapshot:historyBefore')
            return resolve(null)
          const before = args.before ?? ''
          if (serve) {
            try {
              if (name === 'snapshot:commentsBefore') {
                const page = pageOf(serve.comments, before)
                resolve({ comments: page.rows, earlier: page.earlier })
              } else {
                const page = pageOf(serve.history, before)
                resolve({
                  events: page.rows,
                  earlier: page.earlier,
                  next: page.earlier ? page.rows[0].id : null,
                })
              }
            } catch (e) {
              reject(e)
            }
            asked.push({ name, before, answer: { resolve: () => {}, reject: () => {} } })
            return
          }
          asked.push({ name, before, answer: { resolve, reject } })
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
    network.onUpdate.mockImplementation((ref, _args, receive, fail) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') receive(structuredClone(snap))
      else if (name === 'snapshot:threadComments') {
        publish = (page) => receive(structuredClone(page))
        failThread = fail
      } else if (name === 'snapshot:threadHistory')
        publishHistory = (page) => receive(structuredClone(page))
      return () => {}
    })
    store = await import('./planner')
    budget = await import('../lib/threadBudget')
    figure = budget.THREAD_KEEP.rows
    budget.THREAD_KEEP.rows = 120
    await store.initStore()
    store.P.watchComments('task-a')
  })

  afterEach(() => {
    budget.THREAD_KEEP.rows = figure
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /* Opens the thread at its newest 50 of `count` comments, served whole. */
  function openServed(count: number, history = 0) {
    serve = { comments: range(0, count), history: changes(0, history) }
    publish({ comments: range(count - PAGE, count), earlier: count > PAGE })
  }
  const earlier = async () => {
    await store.P.loadEarlierComments()
    await settle()
  }
  const newer = async () => {
    await store.P.loadNewerComments()
    await settle()
  }

  describe('comments', () => {
    it('lets the newer side go past the budget on Show earlier, and reads it back with Show newer', async () => {
      const { P } = store
      openServed(300)
      await earlier()
      expect(shown()).toEqual(ids(200, 300))
      expect(P.commentsNewer).toBe('none')
      // the third page passes 120: the rows just above the live window go,
      // the page and the live window stay
      await earlier()
      expect(shown()).toEqual([...ids(150, 220), ...ids(250, 300)])
      expect(P.commentsNewer).toBe('more')
      expect(P.threadGap?.comments?.above.has('comment-219')).toBe(true)
      await earlier()
      expect(shown()).toEqual([...ids(100, 170), ...ids(250, 300)])
      expect(held()).toBe(120)
      // Show newer asks before the 50th released id, adds the page above
      // the gap and lets the oldest rows go, so Show earlier is back
      await newer()
      expect(last()?.before).toBe('comment-219')
      // the page before it holds #169, the last kept above, and 49 released
      expect(shown()).toEqual([...ids(149, 219), ...ids(250, 300)])
      expect(P.commentsEarlier).toBe('more')
      expect(P.commentsNewer).toBe('more')
      // with fewer than 50 released it asks before the first row below
      await newer()
      expect(last()?.before).toBe('comment-250')
      expect(shown()).toEqual(ids(180, 300))
      expect(P.commentsNewer).toBe('none')
      expect(P.threadGap).toBeNull()
      // Show earlier then asks before the oldest kept comment
      void P.loadEarlierComments()
      expect(last()?.before).toBe('comment-180')
    })

    it('drops a newer answer that comes after the task changed, the thread started over or the gap moved', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      // another task
      void P.loadNewerComments()
      const changed = last()
      P.watchComments('task-b')
      P.watchComments('task-a')
      publish({ comments: range(250, 300), earlier: true })
      changed?.answer.resolve({ comments: range(169, 219), earlier: true })
      await settle()
      expect(shown()).toEqual(ids(250, 300))
      expect(P.commentsNewer).toBe('none')
      // the thread starting over
      serve = { comments: range(0, 300), history: [] }
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      void P.loadNewerComments()
      const over = last()
      publish({ comments: range(400, 450), earlier: true })
      over?.answer.resolve({ comments: range(169, 219), earlier: true })
      await settle()
      expect(shown()).toEqual(ids(400, 450))
      expect(P.commentsNewer).toBe('none')
    })

    it('drops a deleted anchor and asks before its neighbour, and keeps the place on any other failure', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      void P.loadNewerComments()
      expect(last()?.before).toBe('comment-219')
      last()?.answer.reject(notAComment())
      await settle()
      // G[48] keeps the page joinable
      expect(last()?.before).toBe('comment-218')
      last()?.answer.resolve({ comments: range(168, 218), earlier: true })
      await settle()
      expect(shown()).toContain('comment-217')
      expect(shown()).not.toContain('comment-219')
      // any other failure keeps the place, and Retry reads again
      const before = shown()
      void P.loadNewerComments()
      last()?.answer.reject(new Error('offline'))
      await settle()
      expect(P.commentsNewer).toBe('failed')
      expect(shown()).toEqual(before)
      void P.loadNewerComments()
      expect(P.commentsNewer).toBe('loading')
    })
  })

  describe('arrivals', () => {
    it('lets the oldest rows go with no place reported, and the newer side go from a reader far up', async () => {
      const { P } = store
      openServed(300)
      await earlier()
      await earlier()
      expect(shown()).toEqual([...ids(150, 220), ...ids(250, 300)])
      // no window reported: an arrival lets the oldest row go
      publish({ comments: range(251, 301), earlier: true })
      expect(shown()[0]).toBe('comment-151')
      expect(held()).toBe(120)
      // a reader up at #160: the newer run goes from the gap down and the
      // reported row and the 50 after it stay
      P.threadPlace(pane, 'comment-160')
      publish({ comments: range(252, 302), earlier: true })
      expect(shown()).toContain('comment-151')
      expect(shown()).toContain('comment-160')
      // #250 and #251 slid below the gap; the first goes, from the gap down
      expect(shown()).not.toContain('comment-250')
      expect(shown()).toContain('comment-251')
      expect(P.threadGap?.comments?.above.has('comment-219')).toBe(true)
      expect(held()).toBe(120)
      // a dropped report counts as the newest end again
      P.threadPlace(pane)
      publish({ comments: range(253, 303), earlier: true })
      expect(shown()).not.toContain('comment-151')
    })

    it('joins slid comments to the run below a gap, and finds a deleted one there', async () => {
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      // a reader near the gap keeps the rows after their place, the slid
      // ones among them, so the oldest go instead
      store.P.threadPlace(pane, 'comment-160')
      // #251 deleted while two comments arrived
      publish({ comments: range(252, 302), earlier: true })
      const check = last()
      expect(check?.before).toBe('comment-252')
      expect(shown()).toContain('comment-250')
      expect(shown()[0]).toBe('comment-102')
      check?.answer.resolve({ comments: [...range(201, 251)], earlier: true })
      await settle()
      expect(shown()).toContain('comment-250')
      expect(shown()).not.toContain('comment-251')
    })

    it('keeps the released ids before a live window that reaches into the gap, and starts over when it no longer meets the runs', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      // a delete in the live window moves it back into the gap by one
      publish({ comments: [comment(249), ...range(251, 300)], earlier: true })
      expect(shown()).toEqual([...ids(100, 170), ...ids(249, 250), ...ids(251, 300)])
      expect(P.commentsNewer).toBe('more')
      expect(P.commentsEarlier).toBe('more')
      // more arrived than the window holds: the thread starts over
      publish({ comments: range(400, 450), earlier: true })
      expect(shown()).toEqual(ids(400, 450))
      expect(P.commentsNewer).toBe('none')
      expect(P.threadGap).toBeNull()
    })
  })

  describe('drafts and edits', () => {
    it('holds the comment open in an editor apart through every release, until its editor closes', async () => {
      const { P } = store
      openServed(300)
      await earlier()
      P.holdComment(pane, 'comment-230')
      await earlier()
      // #230 went with the newer side, but stays for its editor
      expect(P.commentsNewer).toBe('more')
      expect(shown()).toContain('comment-230')
      expect(P.pinnedComments).toEqual(['comment-230'])
      expect(P.threadGap?.comments?.above.has('comment-230')).toBe(false)
      await earlier()
      expect(shown()).toContain('comment-230')
      // a page that holds it again takes it back into its run
      await newer()
      await newer()
      expect(P.pinnedComments).toEqual([])
      expect(shown()).toContain('comment-230')
      // released again, and its editor closes: it goes
      await earlier()
      expect(P.pinnedComments).toEqual(['comment-230'])
      P.holdComment(pane, null)
      expect(shown()).not.toContain('comment-230')
      expect(P.pinnedComments).toEqual([])
    })

    it('holds the comment open in an editor apart when the thread starts over', async () => {
      const { P } = store
      openServed(300)
      await earlier()
      P.holdComment(pane, 'comment-210')
      // more arrived than the window holds, so it meets nothing loaded
      publish({ comments: range(400, 450), earlier: true })
      expect(shown()).toEqual(['comment-210', ...ids(400, 450)])
      expect(P.pinnedComments).toEqual(['comment-210'])
      expect(P.commentsEarlier).toBe('more')
      // with a gap open, the one in the run below it stays too
      serve = { comments: range(0, 600), history: [] }
      P.holdComment(pane, null)
      publish({ comments: range(550, 600), earlier: true })
      for (let i = 0; i < 3; i++) await earlier()
      expect(P.commentsNewer).toBe('more')
      publish({ comments: range(551, 601), earlier: true })
      expect(shown()).toContain('comment-550')
      P.holdComment(pane, 'comment-550')
      publish({ comments: range(700, 750), earlier: true })
      expect(shown()).toEqual(['comment-550', ...ids(700, 750)])
      // its editor closes, and it goes
      P.holdComment(pane, null)
      expect(shown()).toEqual(ids(700, 750))
    })

    it("forgets my accepted edit of a released comment, which comes back with the server's text", async () => {
      const { P } = store
      openServed(300)
      await earlier()
      const saved = P.updateComment('comment-225', 'Edited')
      writes[0].answer.resolve(null)
      expect(await saved).toBe(true)
      // a delivery after the write, which ends its painted part
      publish({ comments: range(250, 300), earlier: true })
      expect(P.comments.find((c) => c.id === 'comment-225')?.body).toBe('Edited')
      // someone else edits it after me
      serve?.comments.splice(225, 1, { ...comment(225), body: 'Edited on the server' })
      await earlier()
      expect(shown()).not.toContain('comment-225')
      await newer()
      expect(P.comments.find((c) => c.id === 'comment-225')?.body).toBe('Edited on the server')
    })

    it('reads a refused edit of the last comment above the gap again before the first released id', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      const edit = P.updateComment('comment-169', 'Mine')
      writes[0].answer.reject(
        new ConvexError({ code: 'conflict', reason: 'field_changed', message: 'changed' }),
      )
      await edit
      await settle()
      // the comment after #169 in thread order is the released #170
      expect(last()?.before).toBe('comment-170')
      // which was deleted: the read asks before the next released id
      last()?.answer.reject(notAComment())
      await settle()
      expect(last()?.before).toBe('comment-171')
      last()?.answer.resolve({
        comments: [...range(120, 169), { ...comment(169), body: 'Theirs' }],
        earlier: true,
      })
      await settle()
      expect(P.comments.find((c) => c.id === 'comment-169')?.body).toBe('Theirs')
    })

    it('reads a refused edit of a comment held apart after a release from the top let it go', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      P.holdComment(pane, 'comment-100')
      // two newer pages let the oldest rows go, #100 among them, which no
      // run, gap or window lists any more
      await newer()
      await newer()
      expect(P.pinnedComments).toEqual(['comment-100'])
      const oldest = shown().find((id) => id !== 'comment-100')
      expect(oldest).toBe('comment-180')
      serve?.comments.splice(100, 1, { ...comment(100), body: 'Theirs' })
      const reads = asked.length
      const edit = P.updateComment('comment-100', 'Mine')
      writes[0].answer.reject(
        new ConvexError({ code: 'conflict', reason: 'field_changed', message: 'changed' }),
      )
      await edit
      await settle()
      // the pages before the oldest kept comment, back until one holds it
      expect(asked.slice(reads).map((a) => a.before)).toEqual(['comment-180', 'comment-130'])
      expect(P.comments.find((c) => c.id === 'comment-100')?.body).toBe('Theirs')
      expect(P.pinnedComments).toEqual(['comment-100'])
    })
  })

  describe('deletes', () => {
    it('joins the gap to the start when every comment above it is deleted', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      serve = null
      // #100 to #169 were all deleted. Show earlier drops each anchor in
      // turn, and then reads back the released comments before the run
      // below the gap, here the live window, with no gap left
      void P.loadEarlierComments()
      for (let n = 100; n < 170; n++) {
        expect(last()?.before).toBe(`comment-${n}`)
        last()?.answer.reject(notAComment())
        await settle()
      }
      expect(last()?.before).toBe('comment-250')
      last()?.answer.resolve({ comments: range(200, 250), earlier: true })
      await settle()
      expect(shown()).toEqual(ids(200, 300))
      expect(P.commentsNewer).toBe('none')
      expect(P.threadGap).toBeNull()
      expect(P.commentsEarlier).toBe('more')
      void P.loadEarlierComments()
      expect(last()?.before).toBe('comment-200')
    })
  })

  const showAll = () => store.P.showHistory(pane, true)

  describe('changes', () => {
    it('lets changes go under All and reads them back with historyBefore, with the history reading on from its oldest kept change', async () => {
      const { P } = store
      // the live comments and page and one page kept are 130 rows
      budget.THREAD_KEEP.rows = 150
      serve = { comments: range(0, 30), history: changes(0, 300) }
      publish({ comments: range(0, 30), earlier: false })
      showAll()
      publishHistory({ events: changes(250, 300), earlier: true, next: 'event-250' })
      for (let i = 0; i < 3; i++) {
        await P.loadEarlierHistory()
        await settle()
      }
      expect(P.historyNewer).toBe('more')
      expect(held()).toBe(150)
      expect(shownChanges()).toContain('event-100')
      expect(shownChanges()).toContain('event-299')
      expect(shownChanges()).not.toContain('event-200')
      await P.loadNewerHistory()
      await settle()
      expect(last('snapshot:historyBefore')?.before).toBe('event-219')
      expect(shownChanges()).toContain('event-200')
      expect(held()).toBe(150)
      // the oldest rows went: Show earlier activity reads before the
      // oldest kept change
      expect(P.historyEarlier).toBe('more')
      const oldest = shownChanges()[0]
      void P.loadEarlierHistory()
      expect(last('snapshot:historyBefore')?.before).toBe(oldest)
    })

    it('lets changes go when the live page starts among the changes of one write', async () => {
      const { P } = store
      budget.THREAD_KEEP.rows = 150
      // 17 label changes a write, each write at one instant, as a PATCH of
      // 17 labels logs them, after the comments. The live page, the newest
      // 50 of 300, starts at #250, inside the write of #238 to #254
      const history = changes(0, 300).map((e, n) => ({
        ...e,
        ts: new Date(START + (1000 + Math.floor(n / 17)) * 60_000).toISOString(),
      }))
      serve = { comments: range(0, 30), history }
      publish({ comments: range(0, 30), earlier: false })
      showAll()
      publishHistory({ events: history.slice(250), earlier: true, next: 'event-250' })
      for (let i = 0; i < 2; i++) {
        await P.loadEarlierHistory()
        await settle()
      }
      // the writes of #204 to #220 and #221 to #237 went whole, and #238 to
      // #249 stay below the gap with the rest of their write
      expect(P.historyNewer).toBe('more')
      expect(held()).toBe(146)
      expect(shownChanges()).toEqual([...ids(150, 204, 'event'), ...ids(238, 300, 'event')])
      // Show newer activity reads them back before the first change below
      await P.loadNewerHistory()
      await settle()
      expect(last('snapshot:historyBefore')?.before).toBe('event-238')
      expect(P.historyNewer).toBe('none')
      expect(held()).toBeLessThanOrEqual(150)
      const shown = shownChanges()
      expect(shown).toEqual(ids(Number(shown[0].slice(6)), 300, 'event'))
    })

    it('starts the history over below the gap when a page cannot be shown to meet the run above', async () => {
      const { P } = store
      budget.THREAD_KEEP.rows = 150
      serve = { comments: range(0, 30), history: changes(0, 300) }
      publish({ comments: range(0, 30), earlier: false })
      showAll()
      publishHistory({ events: changes(250, 300), earlier: true, next: 'event-250' })
      for (let i = 0; i < 3; i++) {
        await P.loadEarlierHistory()
        await settle()
      }
      serve = null
      void P.loadNewerHistory()
      // a page with a change never loaded, and none of the run above
      last('snapshot:historyBefore')?.answer.resolve({
        events: [{ ...change(999), id: 'event-new' }, ...changes(180, 219)],
        earlier: true,
        next: 'event-new',
      })
      await settle()
      expect(P.historyNewer).toBe('none')
      expect(shownChanges()[0]).toBe('event-250')
      expect(shownChanges()).not.toContain('event-new')
      expect(P.historyEarlier).toBe('more')
    })

    it('closes the comments gap with the rows above it when the history starts or stops', async () => {
      const { P } = store
      openServed(300, 30)
      for (let i = 0; i < 3; i++) await earlier()
      expect(P.commentsNewer).toBe('more')
      P.holdComment(popOut, 'comment-120')
      showAll()
      // the window opens All at its newest end: the comments above the gap
      // went, but the one in an editor stays
      expect(shown()).toEqual(['comment-120', ...ids(250, 300)])
      expect(P.commentsNewer).toBe('none')
      expect(P.commentsEarlier).toBe('more')
      publishHistory({ events: changes(0, 30), earlier: false, next: null })
      // walking the comments back under All opens a gap in them again
      await earlier()
      await earlier()
      expect(P.commentsNewer).toBe('more')
      // and choosing Comments drops the history and the rows above the gap
      P.showHistory(pane, false)
      expect(P.commentsNewer).toBe('none')
      expect(P.threadGap).toBeNull()
      expect(shown()).toEqual(['comment-120', ...ids(250, 300)])
      expect(P.commentsEarlier).toBe('more')
    })

    it('drops a gap when its side says not_found', async () => {
      const { P } = store
      openServed(300)
      for (let i = 0; i < 3; i++) await earlier()
      failThread(new ConvexError({ code: 'not_found', message: 'gone' }))
      await settle()
      expect(shown()).toEqual([])
      expect(P.commentsNewer).toBe('none')
      expect(P.threadGap).toBeNull()
    })
  })

  describe('one figure raised to its design size', () => {
    it('walks a thread of 1,000 comments back to its start and forward again, meeting every comment once in order', async () => {
      const { P } = store
      budget.THREAD_KEEP.rows = 150
      openServed(1000)
      const met = new Set(shown())
      while (P.commentsEarlier === 'more') {
        await earlier()
        for (const id of shown()) met.add(id)
        expect(held()).toBeLessThanOrEqual(150)
      }
      expect(met.size).toBe(1000)
      expect(shown()[0]).toBe('comment-0')
      // Forward again, each page comes in right under the row above it, so
      // the rows above the gap and the pages that come in, in the order
      // they come, are every comment above the live window, each once
      const order = shown().filter((id) => P.threadGap?.comments?.above.has(id))
      while (P.commentsNewer === 'more') {
        const before = new Set(shown())
        await newer()
        order.push(...shown().filter((id) => !before.has(id)))
        expect(held()).toBeLessThanOrEqual(150)
      }
      expect(order.map((id) => Number(id.slice(8)))).toEqual(
        Array.from({ length: 950 }, (_, n) => n),
      )
      expect(shown()).toContain('comment-999')
    })

    it('walks a history of 1,000 changes with everyday comments back and forward again under the budget', async () => {
      const { P } = store
      budget.THREAD_KEEP.rows = 150
      serve = { comments: range(0, 30), history: changes(0, 1000) }
      publish({ comments: range(0, 30), earlier: false })
      showAll()
      publishHistory({ events: changes(950, 1000), earlier: true, next: 'event-950' })
      const met = new Set(shownChanges())
      while (P.historyEarlier === 'more') {
        await P.loadEarlierHistory()
        await settle()
        for (const id of shownChanges()) met.add(id)
        expect(held()).toBeLessThanOrEqual(150)
      }
      expect(met.size).toBe(1000)
      while (P.historyNewer === 'more') {
        await P.loadNewerHistory()
        await settle()
        expect(held()).toBeLessThanOrEqual(150)
      }
      expect(shownChanges()).toContain('event-999')
      expect(P.historyNewer).toBe('none')
    })
  })
})
