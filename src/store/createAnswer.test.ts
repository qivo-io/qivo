import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { RoadmapAnswer } from '../../convex/lib/roadmap'
import type { ViewRow } from '../../convex/lib/viewReads'
import { MIN_BYTES } from '../lib/images'
import { refParts } from '../lib/taskReference'
import { fixture, ME, ORG, PAT, type Snapshot, type TaskAnswer } from './guard/writeRecipes.setup'
import { type OwnerLoadsArgs, ownerLoadsStandIn } from './ownerLoadsStandIn.setup'
import type { IssueVM } from './planner'
import type { Row } from './rows'

/* A create of the person's own in a store that never asked for every task,
   as every session of the app is (store/planner.ts P.addIssue,
   P.createParent, P.createLinked): it asks for no task, puts the new task
   into the Board's and the Roadmap's rows from what it sends until the
   server answers it, shows a window opened on it from its creating answer
   until the server took it and the window's own read answered, sends the
   window's changes behind it at once, and takes all of it away when the
   server refuses it. The real store runs on the shared live transport
   double, every read and write answered by hand, at everyday sizes: a
   sub-project with three tasks. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
type Double = ReturnType<typeof import('./guard/liveDouble.setup').liveOver>
const double = vi.hoisted(() => ({ live: null as Double | null }))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network)
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

/* One subscription the store made, and whether it stopped. */
type Live = {
  name: string
  args: Record<string, unknown>
  deliver: (value: unknown) => void
  fail: (e: unknown) => void
  closed: boolean
}
/* One write the store sent, which the test answers. */
type Sent = {
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const SERVER = '2026-10-20T10:00:05.000Z'
const BOARD = 'board:desktop'
const TITLE = 'Order the spare humidity sensors for the north greenhouse before the cold week'

let store: typeof import('./planner')
let liveParts: typeof import('./liveParts')
let snap: Snapshot
let subs: Live[]
let sent: Sent[]
let toasts: string[]
/* Delivers the workspace again, as the server does after a change. */
let deliverWhole: () => void = () => {}
const P = () => store.P
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick()
}
const open = (name: string) => subs.filter((s) => s.name === name && !s.closed)
/* The writes of `name` sent so far and not answered, oldest first. */
const waiting = (name?: string) => sent.filter((s) => !name || s.name === name)
/* Removes and answers the oldest waiting write of `name` with `value`. */
function take(name: string): Sent {
  const at = sent.findIndex((s) => s.name === name)
  if (at < 0) throw new Error(`${name} was not sent`)
  const [request] = sent.splice(at, 1)
  return request
}

/** Task `id`, number `num`, of sub-project Work as a view's answer sends it. */
function viewRow(id: string, num: number, over: Partial<ViewRow> = {}): ViewRow {
  return {
    id,
    org_id: ORG,
    project_id: 'work',
    num,
    title: `Task ${num}`,
    status: 'todo',
    priority: 'medium',
    paused: false,
    status_at: '2026-10-01T08:00:00.000Z',
    created_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-01T08:00:00.000Z',
    has_subtasks: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...over,
  }
}
/* The three tasks of Work on every Board and Roadmap answer. */
const THREE = () => [viewRow('task-a', 1), viewRow('task-b', 2), viewRow('task-c', 3)]
const boardOf = (rows: ViewRow[]): BoardAnswer => ({
  state: 'ok',
  rows,
  parents: [],
  held_projects: ['work'],
  projects: ['work'],
})
const roadmapOf = (rows: ViewRow[]): RoadmapAnswer =>
  ({
    state: 'ok',
    rows,
    parents: [],
    subtasks: [],
    remaining: { state: 'ok', tenths: {} },
  }) as unknown as RoadmapAnswer

/** The row the server stores for a create sent with `args`, numbered
    `num`, with its own stamps, as issues.create answers it. */
function stored(args: Record<string, unknown>, num: number): Row<'issues'> {
  const clean = Object.fromEntries(
    Object.entries(args).filter(([key, value]) => value !== null && key !== 'org_id'),
  )
  return {
    ...(clean as Partial<Row<'issues'>>),
    id: String(args.id),
    org_id: ORG,
    project_id: String(args.project_id),
    num,
    title: String(args.title),
    description: String(args.description ?? ''),
    status: (args.status as Row<'issues'>['status']) ?? 'backlog',
    priority: (args.priority as Row<'issues'>['priority']) ?? 'low',
    reporter_id: ME,
    created_by: ME,
    paused: !!args.paused,
    status_at: SERVER,
    created_at: SERVER,
    updated_at: SERVER,
  }
}
/* What issues.create answers: the stored row without its text. */
const answerOf = (row: Row<'issues'>) => {
  const { description: _text, ...rest } = row
  return rest
}
/* The stored row as a view's answer sends it. */
const asView = (row: Row<'issues'>): ViewRow => {
  const { description: _text, ...rest } = row
  return { ...rest, has_subtasks: false, has_hidden_subtasks: false, has_hidden_parent: false }
}
/* The stored row as the window's own read answers it. */
const asWindow = (row: Row<'issues'>, extra: Partial<Extract<TaskAnswer, { state: 'ok' }>> = {}) =>
  ({
    state: 'ok',
    task: { ...row, has_subtasks: false, has_hidden_subtasks: false, has_hidden_parent: false },
    level: 'lead',
    labels: [],
    follow:
      row.assignee_id === ME ? { issue_id: row.id, profile_id: ME, created_at: SERVER } : null,
    parent: null,
    subtasks: { rows: [], complete: true },
    ...extra,
  }) as TaskAnswer

/* Every read the store subscribed since `from`, by name, that names task
   `uuid` in its arguments, the inbox's item among them. */
const readsOf = (watch: ReturnType<typeof vi.spyOn>, uuid: string) =>
  watch.mock.calls
    .filter(([, args]) => JSON.stringify(args).includes(uuid))
    .map(([ref]) => getFunctionName(ref as never))

async function boot(asked = false) {
  vi.resetModules()
  vi.clearAllMocks()
  snap = fixture()
  // the workspace holds no task, and Pat holds Edit on Work too
  subs = []
  sent = []
  toasts = []
  vi.stubGlobal('window', {
    showToast: (msg: string) => toasts.push(msg),
    setTimeout,
    clearTimeout,
  })
  network.onUpdate.mockImplementation((ref, args, next, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliverWhole = () => next(structuredClone(snap))
      deliverWhole()
      return () => {}
    }
    const live: Live = { name, args, deliver: next, fail, closed: false }
    subs.push(live)
    if (name === 'snapshot:threadComments') next({ comments: [], earlier: false })
    return () => {
      live.closed = true
    }
  })
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    return new Promise((resolve, reject) => sent.push({ name, args, resolve, reject }))
  })
  liveParts = await import('./liveParts')
  liveParts.TASKS.atBoot = asked
  store = await import('./planner')
  await store.initStore()
  await settle()
}

/* Opens the desktop Board's read and answers it with `rows`. */
async function openBoard(rows = THREE()) {
  P().watchBoard(BOARD, JSON.stringify({ scope: 'work' }))
  await settle()
  const read = open('tasks:board').at(-1)
  if (!read) throw new Error('the Board did not read')
  read.deliver(boardOf(rows))
  await settle()
  return read
}

/* Dates and hours whose verdict reads the owner's load and misses the due
   date: next week, 200 hours, due in ten days. */
function soon() {
  const week = P().isoToWeek(P().TODAY_ISO) + 1
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
  return { start: week, end: week, remaining: '200', due }
}

/* Creates a task of the person's own in Work, as the New task dialog does. */
function create(extra: Partial<Parameters<typeof store.P.addIssue>[0]> = {}) {
  const made = P().addIssue({
    project: 'work',
    title: TITLE,
    status: 'todo',
    priority: 'medium',
    assignee: ME,
    ...extra,
  })
  const named = refParts(made)
  if (!made || !named?.uuid) throw new Error('the create returned no reference')
  return { open: made, uuid: named.uuid }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (liveParts) {
    liveParts.TASKS.atBoot = true
    liveParts.STALL.ms = 60_000
  }
  // no write went out on a path that needs every task, and no paint threw
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a create in a store that never asked for every task', () => {
  it('asks for no task, subscribes no task window and answers a reference to its organization, preview number and uuid', async () => {
    await boot()
    const watch = vi.spyOn(double.live as Double, 'watch')
    const { open: made, uuid } = create()
    expect(refParts(made)).toEqual({ org: ORG, num: 4, uuid })
    expect(P().handleOf(uuid)).toBeNull()
    expect(store.__layerProbe?.asks()).toEqual([])
    expect(P().taskLoad()).toEqual({ state: 'not_asked' })
    await settle()
    expect(waiting().map((s) => s.name)).toEqual(['issues:create'])
    const windows = watch.mock.calls.filter(([ref]) => getFunctionName(ref) === 'workspace:tasks')
    expect(windows).toEqual([])
    // the next create's preview is the number after it
    const second = create({ title: 'Second' })
    expect(refParts(second.open)?.num).toBe(5)
  })

  it("puts the new task into the Board's rows at once, keeps it through a delivery without tasks, and leaves the answer to decide once accepted", async () => {
    await boot()
    const board = await openBoard()
    const { uuid } = create()
    const card = P().viewTask(BOARD, uuid)
    expect(card?.title).toBe(TITLE)
    expect(card?.key).toBe('QN-4')
    expect(P().ownPaintedTasks().has(uuid)).toBe(true)
    // a workspace delivery holds no task, and the card stays
    snap.projects[1].description = 'changed'
    deliverWhole()
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    // Convex delivers the Board's answer that holds the create, then the
    // create answers: the answer's row shows, and no paint is left
    const request = take('issues:create')
    const row = stored(request.args, 4)
    board.deliver(boardOf([...THREE(), asView(row)]))
    await settle()
    request.resolve(answerOf(row))
    await settle()
    expect(P().viewTask(BOARD, uuid)?.title).toBe(TITLE)
    expect(P().ownPaintedTasks().has(uuid)).toBe(false)
    expect(store.__layerProbe?.layerCount()).toBe(0)
  })

  it('takes the card away at acceptance when the answer leaves it out, as under a filter', async () => {
    await boot()
    const board = await openBoard()
    const { uuid } = create()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    const request = take('issues:create')
    // the Board's answer under a filter leaves the task out, unchanged
    board.deliver(boardOf(THREE()))
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeUndefined()
    expect(store.__layerProbe?.layerCount()).toBe(0)
  })

  it("takes the card away at acceptance where the Board's answer did not change, as Convex sends no unchanged result", async () => {
    await boot()
    await openBoard()
    const { uuid } = create()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    // the Board's filter leaves the task out, so its answer is the same and
    // no delivery of it comes before the create answers; the workspace's
    // does, with the organization's counter the create raised
    const request = take('issues:create')
    snap.orgs[0].next_issue_num = 4
    deliverWhole()
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeUndefined()
    expect(store.__layerProbe?.layerCount()).toBe(0)
  })

  it('keeps the card past acceptance only on a Board whose read is behind a reconnect, until it reads again', async () => {
    await boot()
    const board = await openBoard()
    const { uuid } = create()
    const request = take('issues:create')
    // the socket reconnects: the Board's answer must arrive again
    double.live?.reconnect(['workspace:root'])
    await settle()
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeDefined()
    board.deliver(boardOf(THREE()))
    await settle()
    expect(P().viewTask(BOARD, uuid)).toBeUndefined()
  })

  it("shows the new task in the Roadmap's rows and judges its delay with the window closed", async () => {
    await boot()
    P().watchRoadmap(JSON.stringify({ scope: 'work' }))
    await settle()
    const roadmap = open('tasks:roadmap').at(-1)
    roadmap?.deliver(roadmapOf(THREE()))
    await settle()
    const loads = () => open('planning:ownerLoads').flatMap((s) => s.args.owner_ids as string[])
    expect(loads()).not.toContain(ME)
    const { uuid } = create(soon())
    await settle()
    expect(P().viewTask('roadmap', uuid)?.title).toBe(TITLE)
    // its owner registers for its verdict, though the answer names it not
    expect(loads()).toContain(ME)
  })

  it("puts nothing into Team sync's agenda, which shows only what its answer names", async () => {
    await boot()
    await openBoard()
    const key = JSON.stringify({
      org_id: ORG,
      scope: { kind: 'all' },
      day: P().TODAY_ISO,
      week: P().TODAY_ISO,
      week_starts: 1,
      week_end: P().TODAY_ISO,
    })
    P().watchSync(key, 1)
    await settle()
    open('teamSync:agenda')
      .at(-1)
      ?.deliver({
        state: 'ok',
        sub_projects: ['work'],
        top_projects: ['plan'],
        editable: ['work'],
        rows: THREE().map((row) => ({ ...row, blocked_by: [], delay: null })),
        asks: [],
        done: [],
        parents: [],
        people: [],
        hidden: 'counted',
      })
    await settle()
    expect(P().viewTask('sync', 'task-a')).toBeDefined()
    const { uuid } = create()
    const views = store.__layerProbe?.rows() ?? {}
    expect(views[`view:${BOARD}`]).toContain(uuid)
    expect(views['view:sync']).not.toContain(uuid)
    expect(P().viewTask('sync', uuid)).toBeUndefined()
  })

  it('shows a window opened on it from its creating answer, reading nothing about it until the server took it', async () => {
    await boot()
    const watch = vi.spyOn(double.live as Double, 'watch')
    const { uuid } = create({
      description: '\n\n  Check the **north** bench first.  \n\n',
      priority: 'high',
    })
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    P().showHistory({}, true)
    await settle()
    const detail = P().taskDetail(uuid)
    expect(detail).toMatchObject({ state: 'ok', saving: true, level: 'lead', num: 4 })
    expect(detail?.view).toMatchObject({
      title: TITLE,
      description: '  Check the **north** bench first.',
      status: 'todo',
      priority: 'high',
      assignee: ME,
    })
    // its lists are a new task's: empty and whole
    expect(P().sections).toMatchObject({
      subtasks: { rows: [], complete: true },
      links: { rows: [], complete: true },
      attachments: { rows: [], complete: true },
    })
    expect(P().commentsLoaded).toBe(true)
    // the person follows a task assigned to them, as the server makes them
    expect(detail?.view?.subscribed).toBe(true)
    // nothing that names the task reads the server before it exists
    expect(readsOf(watch, uuid)).toEqual([])
    expect(P().familyOf(detail?.view as never)).toBeNull()
    expect(P().createOnItsWay(uuid)).toBe(true)
  })

  it('names the new task from its creating answer before a window watches it, as the window renders before its effect watches', async () => {
    await boot()
    const { uuid } = create({ description: 'Check the north bench first.' })
    const detail = P().taskDetail(uuid)
    expect(detail).toMatchObject({ state: 'ok', saving: true, num: 4 })
    expect(detail?.view).toMatchObject({
      title: TITLE,
      description: 'Check the north bench first.',
    })
    // the same object while its creating answer holds, as a render reads it
    expect(P().taskDetail(uuid)).toBe(detail)
    // the window's editors name the task by its handle from the first
    // render on, so the watch builds none of them again
    const handle = detail?.view?.id ?? ''
    expect(P().taskShown(handle)?.uuid).toBe(uuid)
    P().watchComments(uuid, ORG)
    await settle()
    expect(P().taskDetail(uuid)?.view?.id).toBe(handle)
    expect(P().taskShown(handle)?.uuid).toBe(uuid)
  })

  it("starts the window's reads once the server took it, shows the answer's number and stamps, and its own first answer ends saving", async () => {
    await boot()
    const watch = vi.spyOn(double.live as Double, 'watch')
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    await settle()
    const request = take('issues:create')
    // someone else took number 4 meanwhile
    const row = stored(request.args, 5)
    request.resolve(answerOf(row))
    await settle()
    expect(readsOf(watch, uuid).sort()).toEqual(
      [
        'inbox:item',
        'snapshot:threadComments',
        'taskWindow:attachments',
        'taskWindow:links',
        'taskWindow:task',
      ].sort(),
    )
    const detail = P().taskDetail(uuid)
    expect(detail).toMatchObject({ saving: true, num: 5 })
    expect(detail?.view?.updatedAt).toBe(Date.parse(SERVER))
    const own = open('taskWindow:task').find((s) => s.args.ref === uuid)
    own?.deliver(asWindow(row))
    await settle()
    expect(P().taskDetail(uuid)).toMatchObject({ state: 'ok', saving: false, num: 5 })
    expect(P().createOnItsWay(uuid)).toBe(false)
    // the creating answer showed what the server's own answer shows
    const fields = (view: IssueVM | null) => {
      if (!view) return null
      const { title, description, status, priority, assignee, reviewer, subscribed, key, id } = view
      return { title, description, status, priority, assignee, reviewer, subscribed, key, id }
    }
    expect(fields(P().taskDetail(uuid)?.view ?? null)).toEqual(fields(detail?.view ?? null))
  })

  it('sends the window’s changes at once behind the create, from its creating answer, and paints the card and the window until its own read holds them', async () => {
    await boot()
    const board = await openBoard()
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    store.__layerProbe?.answerMarks()
    void P().updateIssue(handle, { title: 'Order the spare sensors' })
    void P().updateIssue(handle, { status: 'progress' })
    await settle()
    // out at once, after the create, in the order sent
    expect(waiting().map((s) => s.name)).toEqual([
      'issues:create',
      'issues:update',
      'issues:update',
    ])
    expect(store.__layerProbe?.answerMarks()).toEqual(['issues:update', 'issues:update'])
    const [, rename, status] = waiting()
    expect(rename.args.patch).toEqual({ title: 'Order the spare sensors' })
    expect((rename.args.expected as Record<string, unknown>).title).toBeDefined()
    expect(status.args.patch).toEqual({ status: 'progress' })
    expect(P().viewTask(BOARD, uuid)).toMatchObject({
      title: 'Order the spare sensors',
      status: 'progress',
    })
    expect(P().taskDetail(uuid)?.view).toMatchObject({
      title: 'Order the spare sensors',
      status: 'progress',
    })
    // the server runs them in order: the create, then the edits
    const request = take('issues:create')
    const row = {
      ...stored(request.args, 4),
      title: 'Order the spare sensors',
      status: 'progress' as const,
    }
    board.deliver(boardOf([...THREE(), asView(row)]))
    await settle()
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    take('issues:update').resolve(null)
    take('issues:update').resolve(null)
    await settle()
    // the creating answer still shows: the edits paint over it
    expect(P().taskDetail(uuid)?.view?.status).toBe('progress')
    open('taskWindow:task')
      .find((s) => s.args.ref === uuid)
      ?.deliver(asWindow(row))
    await settle()
    expect(P().taskDetail(uuid)).toMatchObject({ saving: false })
    expect(P().taskDetail(uuid)?.view).toMatchObject({
      title: 'Order the spare sensors',
      status: 'progress',
    })
    expect(store.__layerProbe?.layerCount()).toBe(0)
  })

  it('checks the new card under a text filter by the title, description and labels its window changed behind the create', async () => {
    await boot()
    snap.labels.push({
      id: 'label-hw',
      org_id: ORG,
      name: 'Hardware',
      name_lower: 'hardware',
      color: '#335577',
      created_at: SERVER,
    })
    deliverWhole()
    await openBoard()
    const { uuid } = create({ description: 'Check the north bench first.' })
    P().watchComments(uuid, ORG)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    const text = () => P().createText(uuid) ?? ''
    expect(text()).toContain('humidity')
    expect(text()).toContain('north bench')
    // renamed, described again and labelled in its window before the
    // create answers, so the card is checked against what the screen shows
    void P().updateIssue(handle, {
      title: 'Order the spare sensors',
      description: 'Check the south bench first.',
    })
    P().toggleIssueLabel(handle, 'label-hw')
    await settle()
    expect(P().viewTask(BOARD, uuid)?.title).toBe('Order the spare sensors')
    for (const word of ['spare sensors', 'south bench', 'hardware'])
      expect(text().toLowerCase()).toContain(word)
    for (const word of ['humidity', 'north bench']) expect(text()).not.toContain(word)
    // the label's refusal takes its name back with its paint
    expect(waiting().map((s) => s.name)).toEqual([
      'issues:create',
      'issues:update',
      'labels:toggle',
    ])
    take('labels:toggle').reject(
      new ConvexError({ code: 'forbidden', message: 'no write access to this project' }),
    )
    await settle()
    expect(text().toLowerCase()).not.toContain('hardware')
    // with the window closed, a description change on its way cannot be
    // read, so the Board counts the card as unsure
    P().watchComments(null)
    await settle()
    expect(P().createText(uuid)).toBeNull()
  })

  it('takes a refused create away with one toast: its card, its window and the writes sent behind it', async () => {
    await boot()
    await openBoard()
    const refused: string[] = []
    const { open: made, uuid } = (() => {
      const made = P().addIssue({ project: 'work', title: TITLE, assignee: ME }, (last) =>
        refused.push(last),
      )
      return { open: made ?? '', uuid: refParts(made)?.uuid ?? '' }
    })()
    P().watchComments(uuid, ORG)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    void P().updateIssue(handle, { title: 'Renamed before the refusal' })
    P().setIssueSubscribed(handle, false)
    await settle()
    expect(waiting().map((s) => s.name)).toEqual([
      'issues:create',
      'issues:update',
      'issues:unsubscribe',
    ])
    const gone = new ConvexError({ code: 'forbidden', message: 'no write access to this project' })
    take('issues:create').reject(gone)
    await settle()
    for (const name of ['issues:update', 'issues:unsubscribe'])
      take(name).reject(new ConvexError({ code: 'not_found', message: 'issue not found' }))
    await settle()
    expect(refused).toEqual([made])
    expect(toasts).toEqual(["You don't have permission for that. Change reverted."])
    expect(P().viewTask(BOARD, uuid)).toBeUndefined()
    expect(P().taskDetail(uuid)).toMatchObject({ state: 'unavailable', saving: false })
    expect(store.__layerProbe?.layerCount()).toBe(0)
    // a window opened on it later shows it as gone and reads nothing
    const watch = vi.spyOn(double.live as Double, 'watch')
    P().watchComments(null)
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    await settle()
    expect(P().taskDetail(uuid)?.state).toBe('unavailable')
    expect(readsOf(watch, uuid)).toEqual([])
  })

  it('says nothing more for files added to a refused create than its own refusal', async () => {
    await boot()
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    // a photo whose re-encode still runs when the refusal arrives
    let encoded: (error: unknown) => void = () => {}
    vi.stubGlobal(
      'createImageBitmap',
      () =>
        new Promise((_, reject) => {
          encoded = reject
        }),
    )
    const notes = P().addAttachment(handle, new File(['Bench notes'], 'notes.txt'))
    const photo = P().addAttachment(
      handle,
      new File([new Uint8Array(MIN_BYTES)], 'bench.jpg', { type: 'image/jpeg' }),
    )
    await settle()
    // the notes' upload went out behind the create
    expect(waiting().map((s) => s.name)).toEqual(['issues:create', 'files:uploadUrl'])
    take('issues:create').reject(
      new ConvexError({ code: 'forbidden', message: 'no write access to this project' }),
    )
    await settle()
    take('files:uploadUrl').reject(
      new ConvexError({ code: 'not_found', message: 'task not found' }),
    )
    encoded(new Error('no decoder'))
    expect(await notes).toBeNull()
    expect(await photo).toBeNull()
    // the next file of the same drop, which the window sends by the uuid
    expect(await P().addAttachment(uuid, new File(['More notes'], 'more.txt'))).toBeNull()
    expect(waiting()).toEqual([])
    expect(toasts).toEqual(["You don't have permission for that. Change reverted."])
  })

  it('says the window closed for a file whose window closed while its new task was on its way', async () => {
    await boot()
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    // a photo whose re-encode still runs when the window closes
    let encoded: (error: unknown) => void = () => {}
    vi.stubGlobal(
      'createImageBitmap',
      () =>
        new Promise((_, reject) => {
          encoded = reject
        }),
    )
    const photo = P().addAttachment(
      handle,
      new File([new Uint8Array(MIN_BYTES)], 'bench.jpg', { type: 'image/jpeg' }),
    )
    await settle()
    P().watchComments(null)
    await settle()
    encoded(new Error('no decoder'))
    expect(await photo).toBeNull()
    // the create still waits, and nothing more went out
    expect(waiting().map((s) => s.name)).toEqual(['issues:create'])
    expect(toasts).toEqual([
      'Couldn\'t upload "bench.jpg". The upload stopped because the window no longer shows its task.',
    ])
  })

  it("shows a new parent's number from its create's answer in a window opened on it, before the window's own read", async () => {
    await boot()
    await openBoard([...THREE(), viewRow('task-w', 80)])
    P().watchComments('task-w', ORG)
    await settle()
    open('taskWindow:task')
      .find((s) => s.args.ref === 'task-w')
      ?.deliver({
        state: 'ok',
        task: { ...viewRow('task-w', 80), description: '' },
        level: 'lead',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      })
    await settle()
    void P().createParent(P().taskDetail('task-w')?.view?.id ?? '', 'Build the rig')
    await settle()
    const request = take('issues:createParent')
    const parentId = String(request.args.parent_id)
    P().watchComments(parentId, ORG)
    await settle()
    expect(P().taskDetail(parentId)).toMatchObject({ state: 'ok', saving: true, num: 4 })
    // someone else took number 4 meanwhile
    request.resolve({ ...viewRow('task-w', 80, { parent_id: parentId }), parent_num: 5 })
    await settle()
    expect(P().taskDetail(parentId)).toMatchObject({ state: 'ok', saving: true, num: 5 })
  })

  it("moves the reference to the server's number when someone else took the preview", async () => {
    await boot()
    const board = await openBoard()
    const moves: [string, string][] = []
    P().watchHandles((moved) => moves.push(...moved))
    const { open: made, uuid } = create()
    const request = take('issues:create')
    const row = stored(request.args, 6)
    board.deliver(boardOf([...THREE(), asView(row)]))
    await settle()
    request.resolve(answerOf(row))
    await settle()
    expect(moves).toEqual([[made, P().openTask(uuid, ORG, 6)]])
    expect(refParts(moves[0][1])?.num).toBe(6)
    expect(P().viewTask(BOARD, uuid)?.key).toBe('QN-6')
  })

  it("moves a new task past the number another person's create took first, so its card opens and drops its own task", async () => {
    await boot()
    const board = await openBoard()
    const moves: [string, string][] = []
    P().watchHandles((moved) => moves.push(...moved))
    const { open: made, uuid } = create()
    expect(refParts(made)?.num).toBe(4)
    // Pat's create took number 4 first, and the Board's answer brings it
    // before this create answers
    const theirs = () => P().viewTask(BOARD, 'task-pat')
    board.deliver(boardOf([...THREE(), viewRow('task-pat', 4, { title: "Pat's bench check" })]))
    await settle()
    const card = P().viewTask(BOARD, uuid)
    expect(card?.key).toBe('QN-5')
    expect(theirs()?.key).toBe('QN-4')
    // the reference a caller holds moved with it
    expect(moves).toEqual([[made, P().openTask(uuid, ORG, 5)]])
    // opening the card opens its own task, and a drop moves its own task
    expect(refParts(P().openTarget(card?.id ?? ''))?.uuid).toBe(uuid)
    void P().updateIssue(card?.id ?? '', { status: 'progress' })
    await settle()
    expect(waiting('issues:update').map((s) => s.args.id)).toEqual([uuid])
    expect(P().viewTask(BOARD, uuid)?.status).toBe('progress')
    expect(theirs()).toMatchObject({ key: 'QN-4', status: 'todo', title: "Pat's bench check" })
    // the server gave it 6, as a third create took 5. The answer that
    // holds it arrives, then the create answers, and the reference follows
    const request = take('issues:create')
    const row = { ...stored(request.args, 6), status: 'progress' as const }
    board.deliver(
      boardOf([...THREE(), viewRow('task-pat', 4, { title: "Pat's bench check" }), asView(row)]),
    )
    await settle()
    request.resolve(answerOf(stored(request.args, 6)))
    await settle()
    expect(P().viewTask(BOARD, uuid)?.key).toBe('QN-6')
    expect(moves).toEqual([
      [made, P().openTask(uuid, ORG, 5)],
      [P().openTask(uuid, ORG, 5), P().openTask(uuid, ORG, 6)],
    ])
  })

  it("takes the number a view's answer gives a new task when that answer also brings the task that took its preview", async () => {
    await boot()
    const board = await openBoard()
    const moves: [string, string][] = []
    P().watchHandles((moved) => moves.push(...moved))
    const { open: made, uuid } = create()
    expect(refParts(made)?.num).toBe(4)
    P().watchComments(uuid, ORG)
    await settle()
    // Pat's create took 4 and this one 5, and both reach the Board in one
    // answer, after the organization's counter, before this create answers
    const request = take('issues:create')
    snap.orgs[0].next_issue_num = 5
    deliverWhole()
    await settle()
    board.deliver(
      boardOf([
        ...THREE(),
        viewRow('task-pat', 4, { title: "Pat's bench check" }),
        asView(stored(request.args, 5)),
      ]),
    )
    await settle()
    expect(P().viewTask(BOARD, uuid)?.key).toBe('QN-5')
    expect(P().taskDetail(uuid)).toMatchObject({ state: 'ok', saving: true, num: 5 })
    expect(moves).toEqual([[made, P().openTask(uuid, ORG, 5)]])
    request.resolve(answerOf(stored(request.args, 5)))
    await settle()
    expect(moves).toEqual([[made, P().openTask(uuid, ORG, 5)]])
  })

  it('files a new subtask under its parent on the Board, the parent as a group, from a window shown from its answer', async () => {
    await boot()
    await openBoard([
      ...THREE(),
      viewRow('task-w', 80, { remaining_hours: 4, remaining_set_at: SERVER }),
    ])
    P().watchComments('task-w', ORG)
    await settle()
    open('taskWindow:task')
      .find((s) => s.args.ref === 'task-w')
      ?.deliver({
        state: 'ok',
        task: { ...viewRow('task-w', 80, { remaining_hours: 4 }), description: '' },
        level: 'lead',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      })
    await settle()
    const parent = P().taskDetail('task-w')?.view?.id ?? ''
    const made = P().addIssue({ project: 'work', title: 'Mount the probe', parent })
    const uuid = refParts(made)?.uuid ?? ''
    const kid = P().viewTask(BOARD, uuid)
    expect(kid?.parent).toBe(P().viewTask(BOARD, 'task-w')?.id)
    const group = P().viewTask(BOARD, 'task-w')
    expect(group?.isGroup).toBe(true)
    expect(group?.remaining).toBeUndefined()
    // the window's Subtasks list shows it too
    expect(P().taskDetail('task-w')?.view?.children).toContain(kid?.id)
  })

  it('shows a new parent with the task under it, and a new linked task, on the Board', async () => {
    await boot()
    await openBoard([...THREE(), viewRow('task-w', 80)])
    P().watchComments('task-w', ORG)
    await settle()
    open('taskWindow:task')
      .find((s) => s.args.ref === 'task-w')
      ?.deliver({
        state: 'ok',
        task: { ...viewRow('task-w', 80), description: '' },
        level: 'lead',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [], complete: true },
      })
    await settle()
    const shown = P().taskDetail('task-w')?.view?.id ?? ''
    void P().createParent(shown, 'Build the rig')
    void P().createLinked(shown, 'blocks', 'Wire the rig')
    await settle()
    const parentId = String(waiting('issues:createParent')[0].args.parent_id)
    const linkedId = String(waiting('issues:createLinked')[0].args.new_id)
    expect(P().viewTask(BOARD, 'task-w')?.parent).toBe(P().viewTask(BOARD, parentId)?.id)
    expect(P().viewTask(BOARD, parentId)?.isGroup).toBe(true)
    expect(P().viewTask(BOARD, linkedId)?.title).toBe('Wire the rig')
    expect(store.__layerProbe?.asks()).toEqual([])
  })

  it('judges the new card from the owner-load cache, as the window does', async () => {
    await boot()
    await openBoard([viewRow('task-a', 1)])
    const { uuid } = create(soon())
    P().watchComments(uuid, ORG)
    P().showSections({}, true)
    await settle()
    const loads = open('planning:ownerLoads').filter((s) =>
      (s.args.owner_ids as string[]).includes(ME),
    )
    expect(loads.length).toBeGreaterThan(0)
    for (const load of loads) load.deliver(ownerLoadsStandIn(snap, load.args as OwnerLoadsArgs))
    await settle()
    const card = P().viewTask(BOARD, uuid)
    const window = P().taskDetail(uuid)?.view
    if (!card || !window) throw new Error('no card or window')
    // a verdict, and the window's own
    expect(P().delayOf(card)).toMatchObject({ status: 'late' })
    expect(P().delayOf(card)).toEqual(P().windowDelay(window))
  })

  it('pauses saving as for any write while the create waits, and keeps the card and the window', async () => {
    await boot()
    await openBoard()
    const { SLOW_SAVE_MS, syncStatus } = await import('../lib/syncStatus')
    syncStatus.setSocket({ connected: true, everConnected: true })
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    try {
      const { uuid } = create()
      P().watchComments(uuid, ORG)
      await vi.advanceTimersByTimeAsync(SLOW_SAVE_MS + 100)
      expect(P().savePause()?.kind).toBe('slow')
      expect(P().viewTask(BOARD, uuid)).toBeDefined()
      expect(P().taskDetail(uuid)?.saving).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the waiting controls off while the window’s own read stays silent after the create', async () => {
    await boot()
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    await settle()
    const request = take('issues:create')
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    // the read never answers: the window keeps the creating answer, saving
    expect(P().taskDetail(uuid)).toMatchObject({ state: 'ok', saving: true })
    expect(P().familyOf(P().taskDetail(uuid)?.view as never)).toBeNull()
  })

  it('keeps the creating answer through a failed first read, its saves waiting, until Retry reads the task', async () => {
    await boot()
    const { uuid } = create()
    P().watchComments(uuid, ORG)
    await settle()
    const handle = P().taskDetail(uuid)?.view?.id ?? ''
    // a rename sent behind the create, which the server takes after it
    void P().updateIssue(handle, { title: 'Order the spare sensors' })
    await settle()
    const request = take('issues:create')
    const row = { ...stored(request.args, 4), title: 'Order the spare sensors' }
    request.resolve(answerOf(stored(request.args, 4)))
    await settle()
    const own = () => {
      const read = open('taskWindow:task').find((s) => s.args.ref === uuid)
      if (!read) throw new Error('the window did not read its task')
      return read
    }
    own().fail(new Error('Server Error'))
    await settle()
    // the window goes on showing the task from what its create sent, with
    // the rename on it, and its controls that read the server still wait
    expect(P().taskDetail(uuid)).toMatchObject({
      state: 'failed',
      answered: 'ok',
      saving: true,
      view: { title: 'Order the spare sensors' },
    })
    expect(P().familyOf(P().taskDetail(uuid)?.view as never)).toBeNull()
    // the failed read keeps the pending create
    expect(P().createText(uuid)).not.toBeNull()
    // the write sent behind the create goes on and is saved
    take('issues:update').resolve(null)
    await settle()
    expect(P().hasUnconfirmed()).toBe(false)
    // a save that needs the stored task waits until a read answers, and
    // the editors keep their drafts (P.refuseStaleEdit)
    toasts = []
    expect(P().editsFromAnswer(handle)).toBe(false)
    expect(P().refuseStaleEdit(handle)).toBe(true)
    expect(toasts).toEqual([
      "Couldn't save yet. Saving is available once Qivo can check this task for changes.",
    ])
    // Retry reads the task again, and its answer ends the creating answer
    P().retryTask()
    await settle()
    expect(P().taskDetail(uuid)).toMatchObject({ state: 'retrying', saving: true })
    own().deliver(asWindow(row))
    await settle()
    expect(P().taskDetail(uuid)).toMatchObject({
      state: 'ok',
      saving: false,
      view: { title: 'Order the spare sensors' },
    })
    // and ends the pending create too
    expect(P().createText(uuid)).toBeNull()
    expect(P().refuseStaleEdit(handle)).toBe(false)
    void P().updateIssue(handle, { title: 'Order the spare humidity sensors' })
    await settle()
    expect(take('issues:update').args.patch).toEqual({ title: 'Order the spare humidity sensors' })
  })
})

describe('a create in a store that asked for every task', () => {
  it('paints the workspace too and answers the held handle', async () => {
    await boot(true)
    const made = P().addIssue({ project: 'work', title: TITLE, assignee: PAT })
    expect(made).not.toBeNull()
    expect(P().issueById[made ?? '']?.title).toBe(TITLE)
    expect(store.__layerProbe?.asks()).toEqual([])
  })
})
