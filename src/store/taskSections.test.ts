import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

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
const SECTIONS = ['taskWindow:task', 'taskWindow:links', 'taskWindow:attachments']

/* The task window's Subtasks, Linked tasks and Attachments in the store.
   They subscribe their own side queries (convex/taskWindow.ts task, links
   and attachments) only while a window shows them (P.showSections), follow
   the watched task, and show the answers merged with the person's own
   writes on their way. task-a is the open task, with subtasks kid-1 (To
   Do, 3 h) and kid-2 (Done, 2 h), a link blocking task-c and a file;
   task-b stands apart. Deliveries and writes are answered by hand. */
describe("the task window's sections in the store", () => {
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
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
  /* Workspace task `row` as a short row of an answer (convex/lib/taskWindow.ts
     ShortRow). */
  const short = (row: Snapshot['issues'][number], has_subtasks = false) => {
    const {
      description: _text,
      parent_id: _parent,
      has_hidden_subtasks: _hidden,
      has_hidden_parent: _hiddenParent,
      ...rest
    } = row
    return { ...rest, has_subtasks, level: 'lead' }
  }
  const row = (id: string) => {
    const found = snap.issues.find((i) => i.id === id)
    if (!found) throw new Error(`missing ${id}`)
    return found
  }
  /* The task answer of task-a with these subtasks. */
  const taskAnswer = (kids: unknown[], complete = true, hidden = !complete) => ({
    state: 'ok',
    task: { ...row('task-a'), has_subtasks: kids.length > 0, has_hidden_subtasks: hidden },
    level: 'lead',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: kids, complete },
  })
  const link = (id: string, source: string, target: string, type = 'blocks') => ({
    id,
    source_id: source,
    target_id: target,
    type,
    created_at: AT,
  })
  const linksAnswer = (links: unknown[], tasks: unknown[], complete = true) => ({
    state: 'ok',
    links,
    tasks,
    complete,
  })
  const file = (id: string, extra: Partial<Row<'issue_attachments'>> = {}) => ({
    id,
    issue_id: 'task-a',
    name: `${id}.pdf`,
    size_bytes: 1200,
    mime: 'application/pdf',
    storage_id: `storage-${id}`,
    uploaded_by: snap.profiles[0].id,
    created_at: AT,
    ...extra,
  })
  const filesAnswer = (rows: unknown[], complete = true) => ({
    state: 'ok',
    rows,
    count: rows.length,
    complete,
  })
  /* Delivers what the server holds now to the three lists. */
  const deliverAll = () => {
    one('taskWindow:task').deliver(taskAnswer([short(row('kid-1')), short(row('kid-2'))]))
    one('taskWindow:links').deliver(
      linksAnswer([link('link-ac', 'task-a', 'task-c')], [short(row('task-c'))]),
    )
    one('taskWindow:attachments').deliver(filesAnswer([file('file-1')]))
  }
  const sections = () => store.P.sections
  const subtaskIds = () => sections()?.subtasks.rows.map((r) => r.uuid)
  const linkIds = () => sections()?.links.rows.map((r) => r.uuid)
  const fileIds = () => sections()?.attachments.rows.map((r) => r.id)
  /* Opens task-a in a window that shows its sections, with the lists the
     server holds delivered. */
  const opened = () => {
    store.P.watchComments('task-a')
    store.P.showSections(pane, true)
    deliverAll()
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    demo.on = false
    vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    snap = plannerFixture()
    org = snap.orgs[0].id
    snap.orgs[0].next_issue_num = 5
    snap.issues.push(
      task('task-a', 1),
      task('kid-1', 2, { parent_id: 'task-a', remaining_hours: 3 }),
      task('kid-2', 3, { parent_id: 'task-a', status: 'done', remaining_hours: 2 }),
      task('task-b', 4),
      task('task-c', 5),
    )
    snap.links.push(link('link-ac', 'task-a', 'task-c') as Snapshot['links'][number])
    snap.attachments.push(file('file-1') as Snapshot['attachments'][number])
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

  describe('owners', () => {
    it('asks for no list while no window shows the sections', () => {
      store.P.watchComments('task-a')
      expect(subs.map((s) => s.name)).toEqual(['snapshot:threadComments'])
      expect(sections()).toBeNull()
    })

    it("subscribes the three lists once each with the task's organization while a window shows them", () => {
      const { P } = store
      P.watchComments('task-a')
      P.showSections(pane, true)
      expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'task-a' })
      expect(one('taskWindow:links').args).toEqual({ org_id: org, issue_id: 'task-a' })
      expect(one('taskWindow:attachments').args).toEqual({ org_id: org, issue_id: 'task-a' })
      // a second window on the task subscribes nothing more
      P.showSections(popOut, true)
      P.showSections(pane, true)
      for (const name of SECTIONS) expect(named(name)).toHaveLength(1)
      // the thread rides on, and the history waits for All
      expect(one('snapshot:threadComments').args).toEqual({ org_id: org, issue_id: 'task-a' })
      expect(named('snapshot:threadHistory')).toEqual([])
      P.showHistory(pane, true)
      expect(one('snapshot:threadHistory')).toBeDefined()
      for (const name of SECTIONS) expect(named(name)).toHaveLength(1)
    })

    it('stops the three and drops their rows when the last window leaves', () => {
      const { P } = store
      opened()
      P.showSections(popOut, true)
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      P.showSections(pane, false)
      for (const name of SECTIONS) expect(one(name).closed).toBe(false)
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      P.showSections(popOut, false)
      for (const name of SECTIONS) expect(open(name)).toEqual([])
      expect(sections()).toBeNull()
      // the thread keeps its subscription
      expect(one('snapshot:threadComments').closed).toBe(false)
      // back again, the lists ask afresh, showing the workspace's meanwhile
      P.showSections(pane, true)
      expect(sections()?.subtasks).toMatchObject({ source: 'workspace', delivered: false })
      for (const name of SECTIONS) expect(named(name)).toHaveLength(2)
    })

    it('follows the watched task, and a late answer for the task before changes nothing', () => {
      const { P } = store
      opened()
      const before = SECTIONS.map(one)
      P.watchComments('task-b')
      for (const live of before) expect(live.closed).toBe(true)
      expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'task-b' })
      expect(one('taskWindow:links').args).toEqual({ org_id: org, issue_id: 'task-b' })
      // task-b's own lists, as the workspace holds them, until its answers
      const own = {
        task: 'task-b',
        subtasks: { source: 'workspace', rows: [] },
        links: { source: 'workspace', rows: [] },
      }
      expect(sections()).toMatchObject(own)
      before[0].deliver(taskAnswer([short(row('kid-1'))]))
      before[1].deliver(linksAnswer([], []))
      expect(sections()).toMatchObject(own)
    })

    it('gives a task whose create is on its way complete empty lists, and subscribes once a delivery holds it', async () => {
      const { P } = store
      P.showSections(pane, true)
      const key = P.addIssue({ project: snap.projects[0].id, title: 'New task' })
      if (!key) throw new Error('the task was not created')
      const created = P.issueById[key]
      P.watchComments(created.uuid)
      expect(sections()).toMatchObject({
        task: created.uuid,
        subtasks: { state: 'ready', complete: true, rows: [] },
        links: { state: 'ready', complete: true, rows: [] },
        attachments: { state: 'ready', complete: true, rows: [] },
      })
      for (const name of SECTIONS) expect(named(name)).toEqual([])
      // the server holds the task now, and the create answers
      snap.issues.push(task(created.uuid, 6, { title: 'New task' }))
      publishWhole(snap)
      writes.find((w) => w.name === 'issues:create')?.answer.resolve({ num: 6 })
      await later()
      expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: created.uuid })
      // the empty lists stay until the answers arrive
      expect(sections()?.links).toMatchObject({ state: 'ready', complete: true })
      one('taskWindow:links').deliver(linksAnswer([], [], false))
      expect(sections()?.links).toMatchObject({ state: 'ready', complete: false })
    })

    it('subscribes again after the parts start over, and keeps the rows until the new answers', async () => {
      const { P } = store
      opened()
      const before = SECTIONS.map(one)
      await store.initStore()
      await later()
      for (const live of before) expect(live.closed).toBe(true)
      expect(one('taskWindow:task')).not.toBe(before[0])
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      expect(linkIds()).toEqual(['task-c'])
      expect(fileIds()).toEqual(['file-1'])
      one('taskWindow:task').deliver(taskAnswer([short(row('kid-2'))]))
      expect(subtaskIds()).toEqual(['kid-2'])
      expect(P.sections?.subtasks.state).toBe('ready')
    })

    it('clears the owners, the answers and their states with a demo store', async () => {
      vi.resetModules()
      demo.on = true
      store = await import('./planner')
      await store.initStore()
      opened()
      one('taskWindow:links').fail(new Error('Server Error'))
      expect(sections()?.links.state).toBe('failed')
      store.disposeDemoStore()
      expect(sections()).toBeNull()
      for (const name of SECTIONS) expect(open(name)).toEqual([])
    })
  })

  describe('states', () => {
    it("lists a complete workspace's rows until an answer, then whole or incomplete as the answer says", () => {
      const { P } = store
      P.watchComments('task-a')
      P.showSections(pane, true)
      // the workspace is complete, so it lists what it holds meanwhile
      const fromWorkspace = {
        state: 'ready',
        complete: true,
        delivered: false,
        source: 'workspace',
      }
      expect(sections()).toMatchObject({
        task: 'task-a',
        subtasks: { ...fromWorkspace, hidden: false },
        links: fromWorkspace,
        attachments: { ...fromWorkspace, count: 1 },
      })
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      expect(linkIds()).toEqual(['task-c'])
      expect(fileIds()).toEqual(['file-1'])
      // an answer that agrees changes nothing but where the list comes from
      const before = sections()?.subtasks.rows
      one('taskWindow:task').deliver(taskAnswer([short(row('kid-1')), short(row('kid-2'))]))
      expect(sections()?.subtasks).toMatchObject({
        state: 'ready',
        complete: true,
        source: 'answer',
      })
      expect(sections()?.subtasks.rows).toEqual(before)
      one('taskWindow:task').deliver(taskAnswer([short(row('kid-1'))]))
      expect(subtaskIds()).toEqual(['kid-1'])
      one('taskWindow:links').deliver(linksAnswer([], [], false))
      expect(sections()?.links).toMatchObject({ state: 'ready', complete: false, rows: [] })
      // the other lists wait on their own
      expect(sections()?.attachments.source).toBe('workspace')
    })

    it('reads unavailable, with no rows, for an unavailable or archived answer', () => {
      opened()
      one('taskWindow:task').deliver({ state: 'archived', task: { id: 'task-a' } })
      one('taskWindow:links').deliver({ state: 'unavailable' })
      one('taskWindow:attachments').deliver({ state: 'unavailable' })
      expect(sections()).toMatchObject({
        subtasks: { state: 'unavailable', rows: [], complete: false },
        links: { state: 'unavailable', rows: [] },
        attachments: { state: 'unavailable', rows: [], count: 0 },
      })
    })

    it('fails, keeps the rows delivered before, and retries until the server answers', () => {
      const { P } = store
      opened()
      const first = one('taskWindow:links')
      first.fail(new Error('Server Error'))
      expect(sections()?.links).toMatchObject({ state: 'failed', delivered: true })
      expect(linkIds()).toEqual(['task-c'])
      P.retrySection('links')
      expect(first.closed).toBe(true)
      expect(sections()?.links.state).toBe('retrying')
      expect(linkIds()).toEqual(['task-c'])
      // the other lists stayed as they were
      expect(sections()?.subtasks.state).toBe('ready')
      one('taskWindow:links').deliver(linksAnswer([], []))
      expect(sections()?.links).toMatchObject({ state: 'ready', complete: true, rows: [] })
    })

    it("fails before any answer beside a complete workspace's rows", () => {
      const { P } = store
      P.watchComments('task-a')
      P.showSections(pane, true)
      one('taskWindow:task').fail(new ConvexError({ code: 'forbidden', message: 'No seat' }))
      expect(sections()?.subtasks).toMatchObject({
        state: 'failed',
        delivered: false,
        source: 'workspace',
      })
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      // Retry does nothing for a list that did not fail
      P.retrySection('attachments')
      expect(named('taskWindow:attachments')).toHaveLength(1)
    })
  })

  describe("the person's own writes", () => {
    /* What the sections showed of `pick` after each emit. */
    const watch = (pick: () => unknown) => {
      const seen: unknown[] = []
      store.P.subscribe(() => seen.push(pick()))
      return seen
    }
    const refuse = (name: string) =>
      writes
        .find((w) => w.name === name)
        ?.answer.reject(new ConvexError({ code: 'rule', message: 'Refused.' }))
    const accept = (name: string, value: unknown = null) =>
      writes.find((w) => w.name === name)?.answer.resolve(value)

    it('hides a removed link at once while the links answer still holds it, and a refusal brings it back', async () => {
      const { P } = store
      opened()
      P.removeLink(P.handleOf('task-a') ?? '', P.handleOf('task-c') ?? '')
      expect(linkIds()).toEqual([])
      refuse('issues:removeLink')
      await settle()
      expect(linkIds()).toEqual(['task-c'])
    })

    it('keeps a removed link hidden through its echo, without a flicker', async () => {
      const { P } = store
      opened()
      const seen = watch(linkIds)
      P.removeLink(P.handleOf('task-a') ?? '', P.handleOf('task-c') ?? '')
      // the server's echo: the workspace and the links answer without it
      snap.links = []
      double.live?.batch(() => {
        publishWhole(snap)
        one('taskWindow:links').deliver(linksAnswer([], []))
      })
      expect(linkIds()).toEqual([])
      await later()
      expect(linkIds()).toEqual([])
      accept('issues:removeLink')
      await settle()
      await later()
      expect(linkIds()).toEqual([])
      expect(seen.every((ids) => Array.isArray(ids) && ids.length === 0)).toBe(true)
    })

    it('shows a new link at once, keeps it through its echo, and takes it away on a refusal', async () => {
      const { P } = store
      opened()
      P.addLink(P.handleOf('task-a') ?? '', 'blocked_by', P.handleOf('task-b') ?? '')
      expect(sections()?.links.rows.map((r) => [r.uuid, r.type])).toEqual([
        ['task-c', 'blocks'],
        ['task-b', 'blocked_by'],
      ])
      refuse('issues:addLink')
      await settle()
      expect(linkIds()).toEqual(['task-c'])
      P.addLink(P.handleOf('task-a') ?? '', 'relates', P.handleOf('task-b') ?? '')
      const sent = writes.filter((w) => w.name === 'issues:addLink').at(-1)
      const id = String(sent?.args.id)
      const seen = watch(linkIds)
      // the server's row, made after the link to task-c
      const echo = {
        ...link(id, 'task-a', 'task-b', 'relates'),
        created_at: new Date().toISOString(),
      }
      snap.links.push(echo as Snapshot['links'][number])
      double.live?.batch(() => {
        publishWhole(snap)
        one('taskWindow:links').deliver(
          linksAnswer(
            [link('link-ac', 'task-a', 'task-c'), echo],
            [short(row('task-c')), short(row('task-b'))],
          ),
        )
      })
      expect(linkIds()).toEqual(['task-c', 'task-b'])
      await later()
      expect(linkIds()).toEqual(['task-c', 'task-b'])
      sent?.answer.resolve(null)
      await settle()
      await later()
      expect(linkIds()).toEqual(['task-c', 'task-b'])
      expect(seen.every((ids) => Array.isArray(ids) && ids.length === 2)).toBe(true)
    })

    it('hides a subtask whose parent a write clears, and a refusal brings it back', async () => {
      const { P } = store
      opened()
      P.updateIssue(P.handleOf('kid-1') ?? '', { parent: null })
      expect(subtaskIds()).toEqual(['kid-2'])
      refuse('issues:update')
      await settle()
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
    })

    it('keeps a detached subtask hidden through its echo', async () => {
      const { P } = store
      opened()
      const seen = watch(subtaskIds)
      P.updateIssue(P.handleOf('kid-1') ?? '', { parent: null })
      const kid = row('kid-1')
      delete kid.parent_id
      double.live?.batch(() => {
        publishWhole(snap)
        one('taskWindow:task').deliver(taskAnswer([short(row('kid-2'))]))
      })
      expect(subtaskIds()).toEqual(['kid-2'])
      await later()
      expect(subtaskIds()).toEqual(['kid-2'])
      accept('issues:update')
      await settle()
      await later()
      expect(subtaskIds()).toEqual(['kid-2'])
      expect(seen.every((ids) => JSON.stringify(ids) === '["kid-2"]')).toBe(true)
    })

    it('shows a task given the open task as parent at once, and a refusal takes it away', async () => {
      const { P } = store
      opened()
      P.updateIssue(P.handleOf('task-b') ?? '', { parent: P.handleOf('task-a') })
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2', 'task-b'])
      refuse('issues:update')
      await settle()
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
    })

    it('shows a subtask created under the open task at once, through its echo', async () => {
      const { P } = store
      opened()
      const key = P.addIssue({
        project: snap.projects[0].id,
        title: 'Calibrate',
        parent: P.handleOf('task-a'),
      })
      if (!key) throw new Error('the subtask was not created')
      const created = P.issueById[key].uuid
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2', created])
      const seen = watch(subtaskIds)
      snap.issues.push(task(created, 6, { title: 'Calibrate', parent_id: 'task-a' }))
      double.live?.batch(() => {
        publishWhole(snap)
        one('taskWindow:task').deliver(
          taskAnswer([short(row('kid-1')), short(row('kid-2')), short(row(created))]),
        )
      })
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2', created])
      await later()
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2', created])
      accept('issues:create', { num: 6, parent_num: 1 })
      await settle()
      await later()
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2', created])
      expect(seen.every((ids) => Array.isArray(ids) && ids.length === 3)).toBe(true)
    })

    it('takes a subtask create away when the server refuses it', async () => {
      const { P } = store
      opened()
      P.addIssue({ project: snap.projects[0].id, title: 'Calibrate', parent: P.handleOf('task-a') })
      expect(subtaskIds()).toHaveLength(3)
      refuse('issues:create')
      await settle()
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
    })

    it('hides a removed file at once, and a refusal brings it back', async () => {
      const { P } = store
      opened()
      P.removeAttachment('file-1')
      expect(fileIds()).toEqual([])
      refuse('files:removeAttachment')
      await settle()
      expect(fileIds()).toEqual(['file-1'])
    })

    it('hides a subtask whose archive the server accepted before its delivery', async () => {
      const { P } = store
      opened()
      const archived = P.archiveIssue(P.handleOf('kid-1') ?? '')
      // nothing paints while the archive is on its way
      expect(subtaskIds()).toEqual(['kid-1', 'kid-2'])
      accept('issues:archive', { archived: true })
      await archived
      await settle()
      expect(subtaskIds()).toEqual(['kid-2'])
    })

    it('marks a link the answer alone holds, between two held tasks, as not held', () => {
      opened()
      // the server has a link to task-b that no workspace delivery holds yet
      one('taskWindow:links').deliver(
        linksAnswer(
          [link('link-ac', 'task-a', 'task-c'), link('link-ab', 'task-b', 'task-a')],
          [short(row('task-c')), short(row('task-b'))],
        ),
      )
      expect(sections()?.links.rows.map((r) => [r.uuid, r.type, r.held, r.linkHeld])).toEqual([
        // the same creation time, so by id
        ['task-b', 'blocked_by', true, false],
        ['task-c', 'blocks', true, true],
      ])
    })

    it("shows another person's change when its answer arrives, also while the workspace is held", () => {
      opened()
      // a subtask the workspace does not hold, from its short row
      const elsewhere = { ...short(task('kid-3', 7, { title: 'Elsewhere' })), level: 'user' }
      one('taskWindow:task').deliver(
        taskAnswer([short(row('kid-1')), short(row('kid-2')), elsewhere]),
      )
      expect(sections()?.subtasks.rows.at(-1)).toMatchObject({
        uuid: 'kid-3',
        handle: 'QN-7',
        title: 'Elsewhere',
        held: false,
      })
      // a new seat's organization holds the workspace; the answers still show
      double.live?.hold('org-2')
      snap.orgs.push({ ...snap.orgs[0], id: 'org-2', name: 'Second' })
      snap.profiles.push({ ...snap.profiles[0], id: 'me-2', org_id: 'org-2' })
      snap.myProfileIds.push('me-2')
      publishWhole(snap)
      one('taskWindow:links').deliver(linksAnswer([], []))
      expect(linkIds()).toEqual([])
    })
  })

  describe('files the workspace does not hold', () => {
    const mintAnswer = (id: string) => ({
      attachments: {
        [id]: { url: `https://files.test/files/${id}?t=1`, exp: Date.now() / 1000 + 600 },
      },
      avatars: {},
    })

    it('mint through the organization the sections watch, until the sections stop', async () => {
      const { P } = store
      opened()
      one('taskWindow:attachments').deliver(filesAnswer([file('file-1'), file('file-2')]))
      expect(fileIds()).toEqual(['file-1', 'file-2'])
      expect(sections()?.attachments.rows.map((r) => r.held)).toEqual([true, false])
      network.query.mockImplementation(async (ref, args: { attachment_ids?: string[] }) =>
        getFunctionName(ref) === 'files:mintUrls'
          ? mintAnswer(args.attachment_ids?.[0] ?? '')
          : null,
      )
      const url = await P.attachmentUrl('file-2', true)
      expect(url).toContain('file-2')
      expect(url).toContain('&download=1')
      const mints = network.query.mock.calls.filter(
        ([ref]) => getFunctionName(ref) === 'files:mintUrls',
      )
      expect(mints.map(([, args]) => args)).toEqual([{ org_id: org, attachment_ids: ['file-2'] }])
      // a file the workspace holds mints as before
      expect(await P.attachmentUrl('file-1')).toContain('file-1')
      P.showSections(pane, false)
      expect(await P.attachmentUrl('file-2')).toBeNull()
      // an unknown file never mints
      expect(await P.attachmentUrl('file-9')).toBeNull()
    })
  })

  describe('the cap checks before a write', () => {
    it('count the larger of the workspace and the whole list', () => {
      const { P } = store
      opened()
      const it = () => P.issueById[P.handleOf('task-a') ?? '']
      expect(P.capInputs(it()).children).toHaveLength(2)
      // 100 subtasks listed, two held
      const listed = Array.from({ length: 100 }, (_, n) =>
        short(task(`far-${String(n).padStart(3, '0')}`, 100 + n, { parent_id: 'task-a' })),
      )
      one('taskWindow:task').deliver(taskAnswer(listed))
      expect(P.capInputs(it()).children).toHaveLength(100)
      // an incomplete list allows nothing more and takes nothing away
      one('taskWindow:task').deliver(taskAnswer(listed.slice(0, 50), false))
      expect(P.capInputs(it()).children).toHaveLength(2)
      expect(P.capInputs(it()).attachments).toBe(1)
    })
  })
})
