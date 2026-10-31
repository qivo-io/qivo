import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELD_CHANGED } from '../../convex/lib/fieldPrints'
import { COMMENTS_COUNTING } from '../../convex/lib/limits'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { batch(step: () => void): void; hold(orgId: string | null): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
// a demo store, which disposeDemoStore clears, only where a test asks
const demo = vi.hoisted(() => ({ on: false }))
vi.mock('../lib/demoMode', async (original) => {
  const real = await original<typeof import('../lib/demoMode')>()
  return {
    ...real,
    get DEMO_MODE() {
      return demo.on
    },
  }
})

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

const AT = '2026-09-14T08:00:00.000Z'
const GUEST = 'org-guest'
const GUEST_PROJECT = 'guest-project'
// an image of a task's description, by its attachment id
const IMAGE = '0d9e4c5a-1b2c-4d3e-8f40-5a6b7c8d9e0f'

/* A task the workspace does not hold, in the store: its window names its
   organization (P.watchComments), and the store shows it from the task
   window's own read (convex/taskWindow.ts task, P.taskDetail), sends its
   comments and their reads through that organization, and mints the
   images its description names. task-a is held; far tasks (QN-40 on) and a
   guest seat's task are not. Deliveries and writes are answered by hand. */
describe('a task the workspace does not hold, in the store', () => {
  let store: typeof import('./planner')
  let snap: Snapshot
  let org: string
  let subs: Live[]
  let writes: { name: string; args: Record<string, unknown>; answer: Deferred<unknown> }[]
  let publishWhole: (snap: Snapshot) => void
  // two windows, such as a floating window and a pop-out
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
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const detail = (uuid: string) => store.P.taskDetail(uuid)

  const task = (id: string, num: number, extra: Partial<Snapshot['issues'][number]> = {}) => ({
    id,
    org_id: org,
    project_id: snap.projects[0].id,
    num,
    title: `Task ${num}`,
    description: '',
    status: 'todo' as const,
    priority: 'medium' as const,
    paused: false,
    created_at: AT,
    updated_at: AT,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...extra,
  })
  /* A short row of an answer (convex/lib/taskWindow.ts ShortRow). */
  const short = (
    id: string,
    num: number,
    extra: Record<string, unknown> = {},
    has_subtasks = false,
  ) => {
    const {
      description: _text,
      parent_id: _parent,
      has_hidden_subtasks: _hidden,
      has_hidden_parent: _hiddenParent,
      ...rest
    } = task(id, num)
    return { ...rest, has_subtasks, level: 'user', ...extra }
  }
  /* The task answer of task `id`, numbered `num`, as convex/lib/taskWindow.ts
     readWindowTask answers an active task. */
  const okAnswer = (
    id: string,
    num: number,
    extra: { task?: Record<string, unknown> } & Record<string, unknown> = {},
  ) => {
    const { task: row, ...rest } = extra
    return {
      state: 'ok',
      task: {
        ...task(id, num, { description: `Notes of ${num}` }),
        has_subtasks: false,
        ...row,
      },
      level: 'user',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
      ...rest,
    }
  }
  /* The archived answer of task `id` (convex/lib/taskWindow.ts). */
  const archivedAnswer = (id: string, num: number, extra: Record<string, unknown> = {}) => {
    const {
      description: _text,
      parent_id: _parent,
      has_hidden_subtasks: _hidden,
      has_hidden_parent: _hiddenParent,
      ...row
    } = task(id, num)
    return {
      state: 'archived',
      task: { ...row, archived_at: '2026-09-14T09:00:00.000Z', is_group: false },
      description: `Archived notes of ${num}`,
      labels: [],
      level: 'user',
      ...extra,
    }
  }
  const comment = (id: string, issue: string, author: string, extra: object = {}) => ({
    id,
    issue_id: issue,
    author,
    body: `Comment ${id}`,
    created_at: AT,
    ...extra,
  })

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    demo.on = false
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = plannerFixture()
    org = snap.orgs[0].id
    snap.orgs[0].next_issue_num = 50
    snap.issues.push(task('task-a', 1))
    // a guest seat in another organization, whose tasks the workspace does
    // not hold here
    snap.orgs.push({ ...snap.orgs[0], id: GUEST, name: 'Partner', slug: 'partner' })
    snap.profiles.push({ ...snap.profiles[0], id: 'me-guest', org_id: GUEST, org_role: 'guest' })
    snap.myProfileIds.push('me-guest')
    snap.projects.push({ ...snap.projects[0], id: GUEST_PROJECT, org_id: GUEST, key: 'PART' })
    snap.labels.push(
      {
        id: 'label-z',
        org_id: org,
        name: 'Zeta',
        name_lower: 'zeta',
        color: '#111',
        created_at: AT,
      },
      {
        id: 'label-a',
        org_id: org,
        name: 'alpha',
        name_lower: 'alpha',
        color: '#222',
        created_at: AT,
      },
    )
    subs = []
    writes = []
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation(
      (ref, args) =>
        new Promise((resolve, reject) => {
          const name = getFunctionName(ref)
          if (name === 'identity:claimMySeats') return resolve(null)
          writes.push({ name, args, answer: { resolve, reject } })
        }),
    )
    network.onUpdate.mockImplementation((ref, args, receive, onError) => {
      const name = getFunctionName(ref)
      if (name === 'workspace:whole') {
        publishWhole = (value) => receive(structuredClone(value))
        receive(structuredClone(snap))
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
    double.live?.hold(null)
    if (demo.on) store.disposeDemoStore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('subscriptions', () => {
    it('subscribes the thread and the task answer with the organization its window names, once each', () => {
      const { P } = store
      P.watchComments('guest-1', GUEST)
      expect(one('snapshot:threadComments').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
      expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: 'guest-1' })
      // links and attachments only for a window that shows the sections
      expect(named('taskWindow:links')).toEqual([])
      expect(named('taskWindow:attachments')).toEqual([])
      expect(detail('guest-1')).toMatchObject({ task: 'guest-1', org: GUEST, state: 'loading' })
      P.showSections(pane, true)
      expect(one('taskWindow:links').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
      expect(one('taskWindow:attachments').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
      // the Subtasks section and the detail read one task answer
      expect(named('taskWindow:task')).toHaveLength(1)
    })

    it('reads no task answer for a held task while no window shows the sections', () => {
      const { P } = store
      P.watchComments('task-a', org)
      expect(named('taskWindow:task')).toEqual([])
      expect(one('snapshot:threadComments').args).toEqual({ org_id: org, issue_id: 'task-a' })
      expect(detail('task-a')).toBeNull()
      // without an organization, a task the workspace does not hold has an
      // empty thread and no read, as before
      P.watchComments('far-1')
      expect(open('snapshot:threadComments')).toEqual([])
      expect(named('taskWindow:task')).toEqual([])
      expect(detail('far-1')).toBeNull()
      expect(P.commentsLoaded).toBe(true)
      // the organization a later call brings starts them
      P.watchComments('far-1', org)
      expect(one('snapshot:threadComments').args).toEqual({ org_id: org, issue_id: 'far-1' })
      expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'far-1' })
    })

    it('keeps the task answer when the last section owner leaves, as a phone switch or a closed pop-out does', () => {
      const { P } = store
      P.watchComments('far-1', org)
      P.showSections(pane, true)
      P.showSections(popOut, true)
      const read = one('taskWindow:task')
      read.deliver(okAnswer('far-1', 40))
      P.showSections(popOut, false)
      P.showSections(pane, false)
      // links and attachments go, the task answer stays, and so does the view
      expect(open('taskWindow:links')).toEqual([])
      expect(open('taskWindow:attachments')).toEqual([])
      expect(one('taskWindow:task')).toBe(read)
      expect(detail('far-1')?.view?.title).toBe('Task 40')
      // a window that shows the sections again subscribes only the others
      P.showSections(pane, true)
      expect(one('taskWindow:task')).toBe(read)
      expect(named('taskWindow:links')).toHaveLength(2)
    })
  })

  describe('the view', () => {
    it("gives a home task its key as handle, and a guest seat's its uuid", () => {
      const { P } = store
      P.watchComments('far-1', org)
      one('taskWindow:task').deliver(okAnswer('far-1', 40))
      expect(detail('far-1')).toMatchObject({
        state: 'ok',
        view: { id: 'QN-40', key: 'QN-40', uuid: 'far-1', org, description: 'Notes of 40' },
      })
      P.watchComments('guest-1', GUEST)
      one('taskWindow:task').deliver(
        okAnswer('guest-1', 7, { task: { org_id: GUEST, project_id: GUEST_PROJECT } }),
      )
      expect(detail('guest-1')?.view).toMatchObject({ id: 'guest-1', key: 'QN-7', org: GUEST })
      expect(detail('far-1')).toBeNull()
    })

    it('shows its labels in name order, its follow and its parent', () => {
      const { P } = store
      P.watchComments('far-1', org)
      const label = (id: string) => ({ issue_id: 'far-1', label_id: id })
      one('taskWindow:task').deliver(
        okAnswer('far-1', 40, {
          task: { parent_id: 'far-parent' },
          labels: [label('label-z'), label('label-a'), label('label-unknown')],
          follow: { issue_id: 'far-1', profile_id: snap.profiles[0].id, created_at: AT },
          parent: short('far-parent', 41, {}, true),
        }),
      )
      const shown = detail('far-1')
      // the task index's order, by name, then id, of labels the workspace holds
      expect(shown?.view?.labels).toEqual(['label-a', 'label-z'])
      expect(shown?.view?.subscribed).toBe(true)
      expect(shown?.view?.parent).toBe('QN-41')
      expect(shown?.parent).toMatchObject({
        uuid: 'far-parent',
        handle: 'QN-41',
        org,
        num: 41,
        held: false,
        isGroup: true,
      })
    })

    it("takes a group's dates and Done from a complete subtask list by the workspace's rules", () => {
      const { P } = store
      P.watchComments('far-1', org)
      const week = (w: number) => `2026-0${w}-01`
      const kids = [
        short('kid-1', 43, { status: 'done', start_week: week(3), end_week: week(4) }),
        short('kid-2', 42, { status: 'done', start_week: week(2), end_week: week(2) }),
      ]
      one('taskWindow:task').deliver(
        okAnswer('far-1', 40, {
          task: { has_subtasks: true },
          subtasks: { rows: kids, complete: true },
        }),
      )
      const whole = detail('far-1')
      // children by number, then id
      expect(whole?.view?.children).toEqual(['QN-42', 'QN-43'])
      expect(whole).toMatchObject({ datesKnown: true, partial: false, done: true })
      expect(whole?.view?.start).toBe(P.isoToWeek(week(2)))
      expect(whole?.view?.end).toBe(P.isoToWeek(week(4)))
      // one leaf not Done: not Done
      one('taskWindow:task').deliver(
        okAnswer('far-1', 40, {
          task: { has_subtasks: true },
          subtasks: { rows: [kids[0], { ...kids[1], status: 'todo' }], complete: true },
        }),
      )
      expect(detail('far-1')?.done).toBe(false)
      // a hidden subtask: the visible span, partial, and not Done
      one('taskWindow:task').deliver(
        okAnswer('far-1', 40, {
          task: { has_subtasks: true, has_hidden_subtasks: true },
          subtasks: { rows: kids, complete: true },
        }),
      )
      expect(detail('far-1')).toMatchObject({ datesKnown: true, partial: true, done: false })
      expect(detail('far-1')?.view?.end).toBe(P.isoToWeek(week(4)))
    })

    it('says a group has unknown dates for an incomplete list or a subtask that is a group', () => {
      const { P } = store
      P.watchComments('far-1', org)
      const leaf = short('kid-1', 43, { start_week: '2026-03-01', end_week: '2026-04-01' })
      for (const answer of [
        okAnswer('far-1', 40, {
          task: { has_subtasks: true, has_hidden_subtasks: true },
          subtasks: { rows: [leaf], complete: false },
        }),
        okAnswer('far-1', 40, {
          task: { has_subtasks: true },
          subtasks: { rows: [leaf, short('kid-2', 44, {}, true)], complete: true },
        }),
      ]) {
        one('taskWindow:task').deliver(answer)
        expect(detail('far-1')).toMatchObject({ datesKnown: false, done: false })
        expect(detail('far-1')?.view).toMatchObject({ start: null, end: null, isGroup: true })
      }
      // a leaf's dates are its own
      one('taskWindow:task').deliver(
        okAnswer('far-1', 40, { task: { start_week: '2026-03-01', end_week: '2026-03-01' } }),
      )
      expect(detail('far-1')).toMatchObject({ datesKnown: true, done: false })
      expect(detail('far-1')?.view?.start).toBe(P.isoToWeek('2026-03-01'))
    })

    it('shows an archived task with its text and labels, and an archived group with unknown dates', () => {
      const { P } = store
      P.watchComments('far-1', org)
      one('taskWindow:task').deliver(
        archivedAnswer('far-1', 40, { labels: [{ issue_id: 'far-1', label_id: 'label-a' }] }),
      )
      expect(detail('far-1')).toMatchObject({
        state: 'archived',
        textless: false,
        parent: null,
        archivedAt: Date.parse('2026-09-14T09:00:00.000Z'),
        level: 'user',
        view: { id: 'QN-40', description: 'Archived notes of 40', labels: ['label-a'] },
      })
      one('taskWindow:task').deliver({
        ...archivedAnswer('far-1', 40),
        task: { ...archivedAnswer('far-1', 40).task, is_group: true },
      })
      expect(detail('far-1')).toMatchObject({ datesKnown: false, done: false })
      expect(detail('far-1')?.view).toMatchObject({ isGroup: true, start: null, end: null })
      // an older backend answers the page row alone: the window says what
      // became of the task, and nothing more
      one('taskWindow:task').deliver({ state: 'archived', task: archivedAnswer('far-1', 40).task })
      expect(detail('far-1')).toMatchObject({ state: 'archived', textless: true, level: null })
    })
  })

  describe('lifecycle', () => {
    it('lets a late answer of the earlier task change nothing, and keeps nothing once released', () => {
      const { P } = store
      P.watchComments('far-1', org)
      const earlier = one('taskWindow:task')
      P.watchComments('far-2', org)
      expect(earlier.closed).toBe(true)
      earlier.deliver(okAnswer('far-1', 40))
      expect(detail('far-2')).toMatchObject({ state: 'loading', view: null })
      expect(detail('far-1')).toBeNull()
      one('taskWindow:task').deliver(okAnswer('far-2', 41))
      P.watchComments(null)
      for (const s of subs) expect(s.closed, s.name).toBe(true)
      expect(detail('far-2')).toBeNull()
      expect(P.detail).toBeNull()
    })

    it('starts a fresh read when a held task leaves, and stops it when a task arrives', () => {
      const { P } = store
      P.watchComments('task-a', org)
      expect(named('taskWindow:task')).toEqual([])
      // someone archives it: the workspace leaves it out
      const held = snap.issues.splice(0, 1)
      publishWhole(snap)
      expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'task-a' })
      expect(detail('task-a')).toMatchObject({ state: 'loading', view: null })
      one('taskWindow:task').deliver(archivedAnswer('task-a', 1))
      expect(detail('task-a')?.state).toBe('archived')
      // restored, it arrives again: the read stops without a section owner
      snap.issues.push(...held)
      publishWhole(snap)
      expect(open('taskWindow:task')).toEqual([])
      expect(detail('task-a')).toBeNull()
      // with one, the read goes on for the Subtasks section
      P.showSections(pane, true)
      const read = one('taskWindow:task')
      snap.issues.splice(0, 1)
      publishWhole(snap)
      snap.issues.push(...held)
      publishWhole(snap)
      expect(one('taskWindow:task')).toBe(read)
      // and a task whose create is on its way reads nothing
      P.showSections(pane, false)
      const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' })
      if (!key) throw new Error('the task was not created')
      P.watchComments(P.issueById[key].uuid, org)
      expect(open('taskWindow:task')).toEqual([])
      expect(open('snapshot:threadComments')).toEqual([])
    })

    it('subscribes again with the kept organization after the parts start over, and keeps the view meanwhile', async () => {
      const { P } = store
      P.watchComments('guest-1', GUEST)
      const before = one('taskWindow:task')
      before.deliver(okAnswer('guest-1', 7, { task: { org_id: GUEST } }))
      await store.initStore()
      await later()
      expect(before.closed).toBe(true)
      expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: 'guest-1' })
      expect(one('snapshot:threadComments').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
      expect(detail('guest-1')).toMatchObject({ state: 'ok', view: { title: 'Task 7' } })
      one('taskWindow:task').deliver(
        okAnswer('guest-1', 7, { task: { org_id: GUEST, title: 'Renamed' } }),
      )
      expect(detail('guest-1')?.view?.title).toBe('Renamed')
    })

    it('forgets the watched task and its organization with a demo store', async () => {
      demo.on = true
      const { P } = store
      P.watchComments('guest-1', GUEST)
      one('taskWindow:task').deliver(okAnswer('guest-1', 7, { task: { org_id: GUEST } }))
      store.disposeDemoStore()
      demo.on = false
      expect(P.detail).toBeNull()
      expect(detail('guest-1')).toBeNull()
    })
  })

  describe('states', () => {
    it('reads loading, ok, archived and unavailable, fails, and retries until the answer', () => {
      const { P } = store
      P.watchComments('far-1', org)
      expect(detail('far-1')?.state).toBe('loading')
      const read = one('taskWindow:task')
      read.deliver(okAnswer('far-1', 40))
      expect(detail('far-1')?.state).toBe('ok')
      read.deliver(archivedAnswer('far-1', 40))
      expect(detail('far-1')?.state).toBe('archived')
      read.deliver({ state: 'unavailable' })
      expect(detail('far-1')).toMatchObject({ state: 'unavailable', view: null })
      read.deliver(okAnswer('far-1', 40))
      // a failure keeps what the answer before it said
      read.fail(new Error('the connection dropped'))
      expect(detail('far-1')).toMatchObject({
        state: 'failed',
        answered: 'ok',
        view: { title: 'Task 40' },
      })
      P.retryTask()
      expect(read.closed).toBe(true)
      expect(detail('far-1')?.state).toBe('retrying')
      one('taskWindow:task').deliver(okAnswer('far-1', 40, { task: { title: 'Back' } }))
      expect(detail('far-1')).toMatchObject({ state: 'ok', view: { title: 'Back' } })
      // Retry does nothing while the read has not failed
      P.retryTask()
      expect(named('taskWindow:task')).toHaveLength(2)
    })
  })

  describe('the thread of a task shown from its answer', () => {
    /* Watches the guest seat's task, with a delivered thread holding my
       comment and, before it, one more page. */
    const watchGuest = () => {
      const { P } = store
      P.watchComments('guest-1', GUEST)
      one('taskWindow:task').deliver(okAnswer('guest-1', 7, { task: { org_id: GUEST } }))
      one('snapshot:threadComments').deliver({
        comments: [comment('c-2', 'guest-1', 'me-guest', { created_at: '2026-09-14T09:00:00Z' })],
        earlier: true,
      })
      return P
    }
    const write = (name: string) => {
      const found = writes.filter((w) => w.name === name)
      expect(found).toHaveLength(1)
      return found[0]
    }

    it("edits and deletes a comment through the task's organization, not the home one", () => {
      const P = watchGuest()
      void P.updateComment('c-2', 'Edited')
      expect(write('comments:update').args).toMatchObject({ org_id: GUEST, id: 'c-2' })
      P.deleteComment('c-2')
      expect(write('comments:remove').args).toMatchObject({ org_id: GUEST, id: 'c-2' })
    })

    it("posts a comment through the task's organization, which paints at once, stays with the delivery and goes on a refusal", async () => {
      const P = watchGuest()
      const saved = P.addComment('guest-1', 'Looks right')
      const post = write('comments:create')
      expect(post.args).toMatchObject({ org_id: GUEST, issue_id: 'guest-1', body: 'Looks right' })
      const mine = () => P.comments.find((c) => c.body === 'Looks right')
      // the guest seat is its author
      expect(mine()?.author).toBe('me-guest')
      one('snapshot:threadComments').deliver({
        comments: [
          comment('c-2', 'guest-1', 'me-guest', { created_at: '2026-09-14T09:00:00Z' }),
          { ...comment(String(post.args.id), 'guest-1', 'me-guest'), body: 'Looks right' },
        ],
        earlier: true,
      })
      post.answer.resolve(null)
      expect(await saved).toBe(true)
      expect(mine()).toBeDefined()
      // a refused one goes, and asks the server to start counting when it
      // said it was counting the task's comments
      const refused = P.addComment('guest-1', 'Second thought')
      const second = writes.find((w) => w.args.body === 'Second thought')
      expect(P.comments.some((c) => c.body === 'Second thought')).toBe(true)
      second?.answer.reject(
        new ConvexError({ code: 'rule', reason: COMMENTS_COUNTING, task_id: 'guest-1' }),
      )
      expect(await refused).toBe(false)
      expect(P.comments.some((c) => c.body === 'Second thought')).toBe(false)
      await later()
      expect(write('comments:countThread').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
    })

    it("retries and reads earlier comments and history through the task's organization", async () => {
      const P = watchGuest()
      network.query.mockImplementation(async (ref) => {
        const name = getFunctionName(ref)
        if (name === 'snapshot:commentsBefore')
          return {
            comments: [
              comment('c-1', 'guest-1', 'me-guest', { created_at: '2026-09-14T08:30:00Z' }),
            ],
            earlier: false,
          }
        if (name === 'snapshot:historyBefore') return { events: [], earlier: false, next: null }
        return null
      })
      await P.loadEarlierComments()
      const reads = (name: string) =>
        network.query.mock.calls
          .filter(([ref]) => getFunctionName(ref) === name)
          .map(([, args]) => args)
      expect(reads('snapshot:commentsBefore')).toEqual([
        { org_id: GUEST, issue_id: 'guest-1', before: 'c-2' },
      ])
      expect(P.comments.map((c) => c.id)).toEqual(['c-1', 'c-2'])
      // an older comment's refused edit reads it again
      void P.updateComment('c-1', 'Edited')
      write('comments:update').answer.reject(
        new ConvexError({ code: 'conflict', reason: FIELD_CHANGED }),
      )
      await later()
      expect(reads('snapshot:commentsBefore').at(-1)).toEqual({
        org_id: GUEST,
        issue_id: 'guest-1',
        before: 'c-2',
      })
      expect(reads('snapshot:commentsBefore')).toHaveLength(2)
      // the history under All, and its earlier page
      P.showHistory(pane, true)
      expect(one('snapshot:threadHistory').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
      one('snapshot:threadHistory').deliver({ events: [], earlier: true, next: 'ev-1' })
      await P.loadEarlierHistory()
      expect(reads('snapshot:historyBefore')).toEqual([
        { org_id: GUEST, issue_id: 'guest-1', before: 'ev-1' },
      ])
      // a failed thread subscribes again with it
      one('snapshot:threadComments').fail(new Error('the connection dropped'))
      expect(P.commentsFailure).toBe('failed')
      P.retryComments()
      expect(one('snapshot:threadComments').args).toEqual({ org_id: GUEST, issue_id: 'guest-1' })
    })

    it("keeps a held task's comments in its own organization, and the home one only for a task neither held nor watched", async () => {
      const { P } = store
      P.watchComments('task-a', org)
      one('snapshot:threadComments').deliver({
        comments: [comment('c-9', 'task-a', snap.profiles[0].id)],
        earlier: false,
      })
      void P.updateComment('c-9', 'Edited')
      expect(write('comments:update').args).toMatchObject({ org_id: org, id: 'c-9' })
      // a task nobody watches and the workspace does not hold takes no comment
      await expect(P.addComment('far-9', 'Hello')).resolves.toBe(false)
      expect(writes.filter((w) => w.name === 'comments:create')).toEqual([])
    })
  })

  describe('files of a task shown from its answer', () => {
    const mintAnswer = (id: string) => ({
      attachments: {
        [id]: { url: `https://files.test/files/${id}?t=1`, exp: Date.now() / 1000 + 600 },
      },
      avatars: {},
    })

    it('mints an image its description names through its organization, and nothing else', async () => {
      const { P } = store
      P.watchComments('guest-1', GUEST)
      one('taskWindow:task').deliver(
        okAnswer('guest-1', 7, {
          task: { org_id: GUEST, description: `A photo ![board](att:${IMAGE.toUpperCase()})` },
        }),
      )
      network.query.mockImplementation(async (ref, args: { attachment_ids?: string[] }) =>
        getFunctionName(ref) === 'files:mintUrls'
          ? mintAnswer(args.attachment_ids?.[0] ?? '')
          : null,
      )
      expect(await P.attachmentUrl(IMAGE)).toContain(IMAGE)
      const mints = network.query.mock.calls.filter(
        ([ref]) => getFunctionName(ref) === 'files:mintUrls',
      )
      expect(mints.map(([, args]) => args)).toEqual([{ org_id: GUEST, attachment_ids: [IMAGE] }])
      // an id the description does not name gets no URL
      expect(await P.attachmentUrl('5d9e4c5a-1b2c-4d3e-8f40-5a6b7c8d9e0f')).toBeNull()
      // and nothing once the window lets the task go
      P.watchComments(null)
      expect(await P.attachmentUrl('1d9e4c5a-1b2c-4d3e-8f40-5a6b7c8d9e0f')).toBeNull()
      expect(
        network.query.mock.calls.filter(([ref]) => getFunctionName(ref) === 'files:mintUrls'),
      ).toHaveLength(1)
    })

    it("mints a held task's file as before", async () => {
      const { P } = store
      snap.attachments.push({
        id: 'file-1',
        issue_id: 'task-a',
        name: 'spec.pdf',
        size_bytes: 1200,
        mime: 'application/pdf',
        storage_id: 'storage-file-1',
        uploaded_by: snap.profiles[0].id,
        created_at: AT,
      } as Snapshot['attachments'][number])
      publishWhole(snap)
      network.query.mockImplementation(async (ref) =>
        getFunctionName(ref) === 'files:mintUrls' ? mintAnswer('file-1') : null,
      )
      expect(await P.attachmentUrl('file-1')).toContain('file-1')
      const mints = network.query.mock.calls.filter(
        ([ref]) => getFunctionName(ref) === 'files:mintUrls',
      )
      expect(mints.map(([, args]) => args)).toEqual([{ org_id: org, attachment_ids: ['file-1'] }])
    })
  })
})
