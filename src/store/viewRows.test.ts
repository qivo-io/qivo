import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { OwnerLoadsJson } from '../../convex/planning'
import { isoToWeek, TODAY_WEEK, weekToISO } from '../lib/dates'
import { DELAY_UNKNOWN } from '../lib/delay'
import { GUEST_CALLS } from './ownerLoadCache'
import { peopleSettingsStandIn } from './peopleSettingsStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* The task rows a view's answer brings (store/viewRows.ts) on the real
   store: the Board's read the store owns (P.watchBoard), the models it
   shapes from the rows the workspace does not hold, the `view` layer part
   a write on such a task paints (store/layers.ts), what ends it, and the
   delays the owner-load cache judges (store/viewDelay.ts). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(): void; batch(step: () => void): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network, { taskWindow: 'client' })
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: { getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }) },
  signOut: vi.fn(),
}))

const AT = '2026-09-14T08:00:00.000Z'
const SLOT = 'board:desktop'
const KEY = '{"board":1}'

let store: typeof import('./planner')
let snapshot: Snapshot
let deliver: (snap: Snapshot) => void
let answer: BoardAnswer
let board: ((value: BoardAnswer) => void) | null
let loads: Map<string, (value: OwnerLoadsJson) => void>
/* the task window's own reads, by ref */
let taskReads: Map<string, (value: unknown) => void>
/* the Overview's reads, by query, the newest subscription of each */
let overviews: Map<string, (value: unknown) => void>
/* the Overview's reads, by query and arguments (JSON), the newest of each */
let overviewsByArgs: Map<string, (value: unknown) => void>
let writes: { name: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[]

/** A turn for the double's microtasks and the store's 0 ms paint timer. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Task `id` as the Board's answer sends it, in the fixture's project. */
function row(id: string, num: number, over: Partial<ViewRow> = {}): ViewRow {
  return {
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num,
    title: `Task ${id}`,
    status: 'todo',
    priority: 'medium',
    paused: false,
    assignee_id: snapshot.profiles[0].id,
    created_at: AT,
    updated_at: AT,
    has_subtasks: false,
    ...over,
  }
}

/** The answer with `rows` and `parents`. */
const ok = (rows: ViewRow[], parents: ViewRow[] = []): BoardAnswer => ({
  state: 'ok',
  rows,
  parents,
  held_projects: [snapshot.projects[0].id],
})

/** Sets the server's Board answer, delivered at once to a live read. */
async function serve(next: BoardAnswer) {
  answer = next
  board?.(structuredClone(next))
  await turn()
}

/** The workspace task row of `id`, held by the store. */
const held = (id: string, num: number, over: Partial<Snapshot['issues'][number]> = {}) => ({
  id,
  org_id: snapshot.orgs[0].id,
  project_id: snapshot.projects[0].id,
  num,
  title: `Task ${id}`,
  description: '',
  status: 'todo' as const,
  priority: 'medium' as const,
  created_at: AT,
  updated_at: AT,
  paused: false,
  ...over,
})

const probe = () => {
  if (!store.__layerProbe) throw new Error('the layer probe is test-only')
  return store.__layerProbe
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  // the project under a top-level project, as every writer stores one
  // that holds tasks, so the navigation reads name it
  snapshot = underProgram(plannerFixture())
  snapshot.issues.push(held('task-a', 1))
  answer = ok([])
  board = null
  loads = new Map()
  taskReads = new Map()
  overviews = new Map()
  overviewsByArgs = new Map()
  writes = []
  network.query.mockResolvedValue(null)
  // the boot's seat claim answers at once; every other write waits for the test
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise((resolve, reject) =>
          writes.push({ name: getFunctionName(ref), resolve, reject }),
        ),
  )
  network.onUpdate.mockImplementation((ref, args, receive) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliver = receive
      receive(structuredClone(snapshot))
    } else if (name === 'tasks:board') {
      board = receive
      receive(structuredClone(answer))
    } else if (name === 'planning:ownerLoads')
      loads.set((args.owner_ids as string[]).join(), receive as (v: OwnerLoadsJson) => void)
    else if (name === 'snapshot:threadComments') receive({ comments: [], earlier: false })
    // the owners' faces, with their hours, which the views name, from the
    // server's people, as the store holds nobody but the signed-in person
    else if (name === 'people:byIds') receive(peopleSettingsStandIn(snapshot, name, args))
    else if (name === 'taskWindow:task') taskReads.set(String(args.ref), receive)
    else if (name.startsWith('overview:')) {
      overviews.set(name, receive)
      overviewsByArgs.set(`${name} ${JSON.stringify(args)}`, receive)
    }
    return () => {}
  })
  store = await import('./planner')
  await store.initStore()
  // the views name the projects they show; this suite names them all
  await (await import('./oracleScope.setup')).nameProjects(store.P, snapshot)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Opens the Board's read and waits for its answer. */
async function open() {
  store.P.watchBoard(SLOT, KEY)
  await turn()
  await turn()
}

describe('the rows a view brings', () => {
  it('shapes a model for each task only the answer brings, the same object while its row holds', async () => {
    const parent = row('par', 7, {
      has_subtasks: true,
      status: 'backlog',
      group_done: true,
      span: { start_week: '2026-09-07', end_week: '2026-09-28', partial: false },
    })
    answer = ok([row('kid', 8, { parent_id: 'par', status: 'done' }), row('task-a', 1)], [parent])
    await open()
    const P = store.P
    const kid = P.viewTask(SLOT, 'kid')
    const par = P.viewTask(SLOT, 'par')
    expect(kid?.title).toBe('Task kid')
    // a parent the answer sends is a group, Done by its facts, with its span
    expect(par && P.isGroup(par)).toBe(true)
    expect(par && P.isDone(par)).toBe(true)
    expect(par?.start).not.toBeNull()
    expect(kid?.parent).toBe(par?.id)
    expect(P.anyTask(kid?.id ?? '')).toBe(kid)
    // every task the answer brings is a model of its row, as the store
    // holds no task of its own
    expect(P.viewTask(SLOT, 'task-a')?.title).toBe('Task task-a')
    // the same data keeps the object; a changed row gives a new one
    await serve(structuredClone(answer))
    expect(P.viewTask(SLOT, 'kid')).toBe(kid)
    await serve(ok([row('kid', 8, { parent_id: 'par', title: 'Renamed' })], [parent]))
    expect(P.viewTask(SLOT, 'kid')).not.toBe(kid)
    expect(P.viewTask(SLOT, 'kid')?.title).toBe('Renamed')
    // a drifted fact moves the parent's Done
    await serve(ok([row('kid', 8, { parent_id: 'par' })], [{ ...parent, group_done: false }]))
    const after = P.viewTask(SLOT, 'par')
    expect(after && P.isDone(after)).toBe(false)
  })

  it("keeps a view's rows while its read stops, and lets them go on other arguments or when its page leaves", async () => {
    answer = ok([row('far', 9)])
    await open()
    store.P.watchBoard(SLOT, null)
    expect(store.P.viewTask(SLOT, 'far')).toBeDefined()
    expect(store.P.boardRead(SLOT)).toMatchObject({ key: KEY, current: false })
    // shown again: the same rows until the fresh answer, which is current
    store.P.watchBoard(SLOT, KEY)
    expect(store.P.viewTask(SLOT, 'far')).toBeDefined()
    await turn()
    expect(store.P.boardRead(SLOT).current).toBe(true)
    // other arguments let the old rows go at once
    answer = ok([])
    store.P.watchBoard(SLOT, '{"board":2}')
    expect(store.P.viewTask(SLOT, 'far')).toBeUndefined()
    await turn()
    // and so does a page that leaves
    answer = ok([row('far', 9)])
    store.P.watchBoard(SLOT, KEY)
    await turn()
    await turn()
    expect(store.P.viewTask(SLOT, 'far')).toBeDefined()
    store.P.releaseView(SLOT)
    expect(store.P.viewTask(SLOT, 'far')).toBeUndefined()
    expect(store.P.boardRead(SLOT)).toMatchObject({ key: null, answered: false })
  })
})

describe('a handle two models share', () => {
  it("names the person's new task on its way, so its card never acts on another task", async () => {
    const { createViewRows } = await import('./viewRows')
    const views = createViewRows(isoToWeek)
    const org = snapshot.orgs[0].id
    // another person's task numbered 4 in the answer, and the person's new
    // task still showing its preview number 4
    views.take(SLOT, [row('theirs', 4)])
    views.beginPaint()
    views.insert(SLOT, row('mine', 4, { title: 'New bench check' }))
    const ctx = { handleNow: (_uuid: string, _org: string, num: number) => `QN-${num}` }
    views.reshape({ ...ctx, wins: (uuid) => uuid === 'mine' })
    expect(views.byHandle('QN-4')?.uuid).toBe('mine')
    expect(views.model(SLOT, 'theirs')?.key).toBe('QN-4')
    // without one on its way, the first row the view holds names it
    views.reshape(ctx)
    expect(views.byHandle('QN-4')?.uuid).toBe('theirs')
    expect(views.numbered(org)).toEqual(new Map([[4, 'theirs']]))
  })
})

describe('a model shaped from a row', () => {
  it('is shaped again when its own handle or the week grid moves, and kept otherwise', async () => {
    const { createViewRows } = await import('./viewRows')
    const views = createViewRows(isoToWeek)
    views.take('v', [row('far', 9, { start_week: weekToISO(TODAY_WEEK) })])
    views.beginPaint()
    // a standalone task: no parent or subtask whose handle would move with it
    let handle = 'QN-9'
    let grid = 1
    const ctx = () => ({ handleNow: () => handle, grid })
    views.reshape(ctx())
    const first = views.model('v', 'far')
    expect(first?.id).toBe('QN-9')
    expect(views.reshape(ctx())).toBe(false)
    expect(views.model('v', 'far')).toBe(first)
    // the home organization moved, so the task opens by its uuid now
    handle = 'far'
    expect(views.reshape(ctx())).toBe(true)
    const moved = views.model('v', 'far')
    expect(moved?.id).toBe('far')
    expect(views.byHandle('far')).toBe(moved)
    expect(views.byHandle('QN-9')).toBeUndefined()
    // a re-anchored week grid gives week indexes on the new grid
    grid = 2
    expect(views.reshape(ctx())).toBe(true)
    expect(views.model('v', 'far')).not.toBe(moved)
  })
})

describe('a write on a task only a view brings', () => {
  it('paints at once, stays through the echo, ends with the answer that holds it', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(store.P.ownPaintedTasks().has('far')).toBe(true)
    expect(writes.map((w) => w.name)).toEqual(['issues:update'])
    // an answer from before the write leaves the paint on screen
    await serve(ok([row('far', 9, { title: 'Echo' })]))
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    // the answer that holds it, then the acceptance: no layer left
    await serve(ok([row('far', 9, { title: 'Echo', status: 'progress' })]))
    writes[0]?.resolve(null)
    await turn()
    expect(probe().layerCount()).toBe(0)
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(store.P.ownPaintedTasks().has('far')).toBe(false)
  })

  it('shows each of two writes on one card at once, the second over the first', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    // the second paints over the copy the first made, whose model the
    // first's showing shaped
    void store.P.updateIssue(id, { reviewer: snapshot.profiles[0].id })
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(store.P.viewTask(SLOT, 'far')?.reviewer).toBe(snapshot.profiles[0].id)
    expect(writes.map((w) => w.name)).toEqual(['issues:update', 'issues:update'])
  })

  it('goes with a refusal, and changes nothing the Board does not write', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { assignee: null })
    expect(store.P.viewTask(SLOT, 'far')?.assignee).toBeUndefined()
    writes[0]?.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.assignee).toBe(snapshot.profiles[0].id)
    expect(probe().layerCount()).toBe(0)
    // a title waits until the workspace holds the task
    expect(await store.P.updateIssue(id, { title: 'No' })).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('keeps a write accepted across a reconnect until the answer arrives again holding it', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'review' })
    // the socket drops; the results arrive again before the server applied
    // the write, and none holds it
    double.live?.reconnect()
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('review')
    expect(probe().layerCount()).toBe(1)
    // the server applies it and, as Convex does, delivers it before it
    // answers: the answer holding it ends the layer
    await serve(ok([row('far', 9, { status: 'review', remaining_hours: 2 })]))
    writes[0]?.resolve(null)
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('review')
    expect(probe().layerCount()).toBe(0)
  })

  it('stays painted on the rows a stopped read keeps when the server accepts it', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    // an answer from before the write arrives after it was sent
    await serve(ok([row('far', 9, { title: 'Echo' })]))
    // the tab hides: the read stops and keeps its rows
    store.P.watchBoard(SLOT, null)
    // the server accepts it, which no delivery of the stopped read can hold
    writes[0]?.resolve(null)
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    // shown again, the fresh answer holds it and ends the paint
    answer = ok([row('far', 9, { title: 'Echo', status: 'progress' })])
    store.P.watchBoard(SLOT, KEY)
    await turn()
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(probe().layerCount()).toBe(0)
  })

  it("shows a read's news that waited for a pending write, past a repaint of the sections", async () => {
    answer = ok([row('far', 9)])
    await open()
    const P = store.P
    // a write of the person's own waits, so the views' paint waits with it
    void P.updateIssue(P.viewTask(SLOT, 'far')?.id ?? '', { title: 'Renamed' })
    await turn()
    let views = 0
    const stop = P.updates.views.subscribe(() => views++)
    try {
      // news of the read that changes no model: other lanes
      answer = { state: 'ok', rows: [row('far', 9)], parents: [], held_projects: [] }
      board?.(structuredClone(answer))
      // a repaint of the task window's sections before the views' paint
      P.showSections({}, true)
      await turn()
      expect(P.boardRead(SLOT).value).toMatchObject({ held_projects: [] })
      expect(views).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })

  it('leaves no layer behind when its view closes before a delivery holds it', async () => {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    store.P.releaseView(SLOT)
    writes[0]?.resolve(null)
    await turn()
    // its view part went with the rows, and it paints nothing else, as the
    // workspace holds no task
    expect(probe().layerCount()).toBe(0)
  })
})

describe('the delays of tasks only a view brings', () => {
  const planned = (id: string, num: number) =>
    row(id, num, {
      status: 'progress',
      remaining_hours: 10,
      start_week: weekToISO(TODAY_WEEK),
      end_week: weekToISO(TODAY_WEEK + 1),
      due_date: weekToISO(TODAY_WEEK + 2),
    })

  it('shows nothing while the load is on its way, a verdict once it comes, unknown when unavailable', async () => {
    snapshot.projects[0].track_delay = true
    deliver(structuredClone(snapshot))
    await turn()
    answer = ok([planned('far', 9)])
    await open()
    const P = store.P
    const me = snapshot.profiles[0].id
    expect(P.delayOf(P.viewTask(SLOT, 'far') ?? '')).toBeNull()
    expect(P.delayUnknown(P.viewTask(SLOT, 'far') ?? '')).toBe(false)
    const receive = loads.get(me)
    if (!receive) throw new Error('no owner load asked')
    receive({ hidden: 'counted', owners: [{ owner_id: me, state: 'ok', spans: [], paused: [] }] })
    await turn()
    const judged = P.viewTask(SLOT, 'far')
    expect(P.delayOf(judged ?? '')?.status).toBe('ok')
    receive({ hidden: 'counted', owners: [{ owner_id: me, state: 'unavailable' }] })
    await turn()
    const unknown = P.viewTask(SLOT, 'far')
    // a changed verdict renews the model, so cards and estimates see it
    expect(unknown).not.toBe(judged)
    expect(P.delayOf(unknown ?? '')).toBeNull()
    expect(P.delayUnknown(unknown ?? '')).toBe(true)
    expect(P.delayBanner(unknown ?? '')).toBe(true)
  })

  it("asks no load for a view that shows no delays, as the phone's list", async () => {
    snapshot.projects[0].track_delay = true
    deliver(structuredClone(snapshot))
    await turn()
    answer = ok([planned('far', 9)])
    store.P.watchBoard('board:phone', KEY, 0, 0, false)
    await turn()
    await turn()
    expect(store.P.viewTask('board:phone', 'far')).toBeDefined()
    expect(loads.size).toBe(0)
    // the desktop Board over the same answer asks
    store.P.releaseView('board:phone')
    await open()
    expect(loads.size).toBe(1)
  })

  it("says Delay unknown at once for a Viewer's owners past the cap", async () => {
    snapshot.projects[0].track_delay = true
    snapshot.profiles[0].org_role = 'viewer'
    // an organization Viewer leads nothing, so a grant shows them the
    // project, whose delay rule the cards read from the project cache
    snapshot.access.push({
      project_id: snapshot.projects[0].id,
      profile_id: snapshot.profiles[0].id,
      level: 'viewer',
    })
    // GUEST_CALLS + 2 other people, each owning one planned task
    const people = Array.from({ length: GUEST_CALLS + 2 }, (_, i) => ({
      ...snapshot.profiles[0],
      id: `person-${String(i).padStart(2, '0')}`,
      auth_user_id: `account-${i}`,
      name: `Person ${i}`,
      org_role: 'user' as const,
    }))
    snapshot.profiles.push(...people)
    deliver(structuredClone(snapshot))
    await turn()
    await vi.waitFor(() => expect(store.P.projectState(snapshot.projects[0].id)).toBe('ok'))
    answer = ok(people.map((p, i) => ({ ...planned(`t${i}`, 10 + i), assignee_id: p.id })))
    await open()
    const P = store.P
    const unknown = (i: number) => P.delayUnknown(P.viewTask(SLOT, `t${i}`) ?? '')
    // one call an owner, at most GUEST_CALLS, by id among equal card counts
    expect(loads.size).toBe(GUEST_CALLS)
    for (let i = 0; i < GUEST_CALLS; i++) expect(unknown(i), `t${i}`).toBe(false)
    for (let i = GUEST_CALLS; i < people.length; i++) expect(unknown(i), `t${i}`).toBe(true)
    // the task window over a capped card reads its owner under its own key,
    // which no cap counts, and the card reads the same load while it shows
    const capped = GUEST_CALLS
    const row = { ...planned(`t${capped}`, 10 + capped), assignee_id: people[capped].id }
    P.watchComments(row.id, snapshot.orgs[0].id)
    P.showSections({}, true)
    const read = taskReads.get(row.id)
    if (!read) throw new Error('no task read')
    const { span: _span, group_done: _done, ...fields } = row
    read({
      state: 'ok',
      task: { ...fields, description: '' },
      level: 'viewer',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [], complete: true },
    })
    await turn()
    const view = P.taskDetail(row.id)?.view
    if (!view) throw new Error('no window view')
    expect(loads.size).toBe(GUEST_CALLS + 1)
    expect(P.windowDelay(view)).toBeNull()
    expect(unknown(capped)).toBe(false)
    loads.get(people[capped].id)?.({
      hidden: 'counted',
      owners: [{ owner_id: people[capped].id, state: 'ok', spans: [], paused: [] }],
    })
    await turn()
    const card = P.viewTask(SLOT, row.id)
    expect(P.windowDelay(view)).toMatchObject({ status: 'ok' })
    expect(P.delayOf(card ?? '')).toEqual(P.windowDelay(view))
  })

  it("judges a group the window shows from its answer by the card's span, when its subtask list is not whole", async () => {
    snapshot.projects[0].track_delay = true
    deliver(structuredClone(snapshot))
    await turn()
    const P = store.P
    // a group past its due date whose span, as the server sends it on the
    // card, runs into next week
    const group = row('grp', 20, {
      status: 'progress',
      due_date: weekToISO(TODAY_WEEK - 1),
      has_subtasks: true,
      group_done: false,
      span: {
        start_week: weekToISO(TODAY_WEEK - 2),
        end_week: weekToISO(TODAY_WEEK + 1),
        partial: false,
      },
    })
    answer = ok([group])
    await open()
    const card = P.viewTask(SLOT, 'grp') ?? ''
    const verdict = P.delayOf(card)
    expect(verdict).not.toBeNull()
    // the window reads the group, the list of its subtasks not whole
    P.watchComments('grp', snapshot.orgs[0].id)
    P.showSections({}, true)
    const read = taskReads.get('grp')
    if (!read) throw new Error('no task read')
    const { span: _span, group_done: _done, ...fields } = group
    const kid = row('kid', 21, {
      start_week: weekToISO(TODAY_WEEK - 2),
      end_week: weekToISO(TODAY_WEEK - 1),
    })
    read({
      state: 'ok',
      task: { ...fields, description: '' },
      level: 'user',
      labels: [],
      follow: null,
      parent: null,
      subtasks: { rows: [{ ...kid, has_subtasks: false, level: 'user' }], complete: false },
    })
    await turn()
    expect(P.taskDetail('grp')?.datesKnown).toBe(false)
    const view = P.taskDetail('grp')?.view
    if (!view) throw new Error('no window view')
    expect(P.windowDelay(view)).toEqual(verdict)
  })

  it("takes only a group's Done and span from a view that still reads it, never a stopped view's kept row", async () => {
    snapshot.projects[0].track_delay = true
    deliver(structuredClone(snapshot))
    await turn()
    const P = store.P
    // a group due in three weeks whose span, as the Board sends it, ends
    // next week
    const group = row('grp', 20, {
      status: 'progress',
      due_date: weekToISO(TODAY_WEEK + 3),
      has_subtasks: true,
      group_done: false,
      span: {
        start_week: weekToISO(TODAY_WEEK - 2),
        end_week: weekToISO(TODAY_WEEK + 1),
        partial: false,
      },
    })
    answer = ok([group])
    await open()
    // the window reads the group, the list of its subtasks not whole
    P.watchComments('grp', snapshot.orgs[0].id)
    P.showSections({}, true)
    const read = taskReads.get('grp')
    if (!read) throw new Error('no task read')
    const { span: _span, group_done: _done, ...fields } = group
    const kid = row('kid', 21)
    /** The window's answer, the group due on `due`. */
    const windowRead = async (due: string) => {
      read({
        state: 'ok',
        task: { ...fields, due_date: due, description: '' },
        level: 'user',
        labels: [],
        follow: null,
        parent: null,
        subtasks: { rows: [{ ...kid, has_subtasks: false, level: 'user' }], complete: false },
      })
      await turn()
    }
    const verdict = () => {
      const view = P.taskDetail('grp')?.view
      if (!view) throw new Error('no window view')
      return P.windowDelay(view)
    }
    await windowRead(weekToISO(TODAY_WEEK + 3))
    expect(verdict()).toMatchObject({ status: 'ok' })
    // the Board hides and its read stops, keeping its rows, which then hear
    // no change to the task, so the window takes nothing from them
    P.watchBoard(SLOT, null)
    await turn()
    expect(P.viewTask(SLOT, 'grp')).toBeDefined()
    expect(verdict()).toBe(DELAY_UNKNOWN)
    // its due date passes meanwhile, which only the window hears, so it is
    // overdue, never on track by the kept row's due date
    await windowRead(weekToISO(TODAY_WEEK - 1))
    expect(verdict()).toBeNull()
    // the Board reads again with an answer that has not caught up with the
    // window's yet, so the span is the card's and the due date the window's
    P.watchBoard(SLOT, KEY)
    await turn()
    await turn()
    expect(verdict()).toMatchObject({ status: 'late' })
  })
})

describe("a write's view part while several views read", () => {
  /** The Overview's key for My view on the store's day (P.watchOverview). */
  const overviewKey = () =>
    JSON.stringify({
      scope: { kind: 'mine' },
      day: store.P.TODAY_ISO,
      week: store.P.isoFromDate(store.P.weekToDate(store.P.TODAY_WEEK)),
      week_starts: Array.from({ length: 53 }, (_, i) =>
        store.P.weekToDate(store.P.TODAY_WEEK - 52 + i).getTime(),
      ),
      week_end: store.P.weekToDate(store.P.TODAY_WEEK + 1).getTime(),
    })

  /** Opens My view's Overview with Your work, which the store reads in
      its own slot. */
  const openWork = async () => {
    store.P.watchOverview(overviewKey(), 1, 0, 'mine')
    store.P.watchOverviewWork(true, 1)
    await turn()
  }
  /** An answer of Your work holding `rows` in Next. */
  const work = (rows: ViewRow[]) => ({
    state: 'ok',
    groups: {
      progress: { rows: [], total: 0 },
      review: { rows: [], total: 0 },
      next: {
        rows: rows.map((r) => ({ ...r, needs: { kind: null, also: [], blocked_by: 0 } })),
        total: rows.length,
      },
    },
    most: 1000,
    counts: {
      overdue: 0,
      blocked: 0,
      no_reviewer: 0,
      paused: 0,
      projected: { state: 'ok', count: 0 },
      behind: { state: 'ok', count: 0 },
    },
    late_due: { state: 'ok', projects: [] },
  })
  /** Your work's view slot. */
  const WORK_SLOT = 'overview:work'
  /** The ids of the tasks Your work's Next shows. */
  const nextIds = () => {
    const value = store.P.overviewRead().work?.value
    return value?.state === 'ok' ? value.groups.next.rows.map((r) => r.id) : []
  }

  /** A Board write on a task only the Board's answer brings, accepted while
      the Board's read is stopped with its rows kept, as a hidden Board's. */
  async function stoppedBoardWrite() {
    answer = ok([row('far', 9)])
    await open()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    // an answer from before the write arrives after it was sent
    await serve(ok([row('far', 9, { title: 'Echo' })]))
    store.P.watchBoard(SLOT, null)
    writes[0]?.resolve(null)
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    // the Overview reads beside it
    await openWork()
  }

  it("keeps a stopped Board's saved part past an Overview read that brings other rows", async () => {
    await stoppedBoardWrite()
    overviews.get('overview:work')?.(work([row('other', 3)]))
    await turn()
    expect(nextIds()).toEqual(['other'])
    // the card does not snap back: no delivery of the Board's own read holds it
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(probe().layerCount()).toBe(1)
    // shown again, the Board's fresh answer holds it and ends the paint
    answer = ok([row('far', 9, { title: 'Echo', status: 'progress' })])
    store.P.watchBoard(SLOT, KEY)
    await turn()
    await turn()
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(probe().layerCount()).toBe(0)
  })

  it("keeps a stopped Board's saved part past an Overview summary, which brings no rows", async () => {
    await stoppedBoardWrite()
    overviews.get('overview:summary')?.({
      state: 'ok',
      counts: {
        state: 'ok',
        leaves: { backlog: 0, todo: 1, progress: 0, review: 0, done: 0 },
        paused: 0,
      },
      any_task: { state: 'ok', value: true },
      overdue: { state: 'ok', count: 0 },
    })
    await turn()
    expect(store.P.overviewRead().summary?.value).toMatchObject({ state: 'ok' })
    expect(store.P.viewTask(SLOT, 'far')?.status).toBe('progress')
    expect(probe().layerCount()).toBe(1)
  })

  it("lets a live read's copy of a task lead over a stopped read's, which follows the live one", async () => {
    await openWork()
    overviews.get('overview:work')?.(work([row('far', 9)]))
    await turn()
    // the Overview hides behind the Board, which answers the task moved on
    store.P.watchOverview(null, 1, 0)
    answer = ok([row('far', 9, { status: 'progress' })])
    await open()
    const P = store.P
    const id = P.viewTask(SLOT, 'far')?.id ?? ''
    // lookups find the Board's model, and the Overview's copy follows it
    expect(P.anyTask(id)).toBe(P.viewTask(SLOT, 'far'))
    expect(P.viewTask(WORK_SLOT, 'far')?.status).toBe('progress')
    // a drop back to To do is a change, sent over the Board's row
    void P.updateIssue(id, { status: 'todo' })
    expect(writes.map((w) => w.name)).toEqual(['issues:update'])
    expect(network.mutation.mock.calls.at(-1)?.[1]).toMatchObject({ patch: { status: 'todo' } })
  })

  it('ends a Board write the Board holds while a stopped Overview keeps a copy, and shows a later change on both', async () => {
    answer = ok([row('far', 9)])
    await open()
    await openWork()
    overviews.get('overview:work')?.(work([row('far', 9)]))
    await turn()
    // the Overview hides behind the Board: its reads stop, its rows stay
    store.P.watchOverview(null, 1, 0)
    await turn()
    const P = store.P
    const id = P.viewTask(SLOT, 'far')?.id ?? ''
    void P.updateIssue(id, { status: 'progress' })
    await serve(ok([row('far', 9, { status: 'progress' })]))
    writes[0]?.resolve(null)
    await turn()
    // the Board's answer holds it, and the Overview's copy follows the Board
    expect(probe().layerCount()).toBe(0)
    expect(P.viewTask(WORK_SLOT, 'far')?.status).toBe('progress')
    // someone else moves it on: the Board shows it, and so does the copy
    await serve(ok([row('far', 9, { status: 'review' })]))
    expect(P.viewTask(SLOT, 'far')?.status).toBe('review')
    expect(P.viewTask(WORK_SLOT, 'far')?.status).toBe('review')
    // shown again, the Overview shows that while it refreshes
    P.watchOverview(overviewKey(), 1, 0, 'mine')
    await turn()
    expect(P.overviewRead().work?.current).toBe(false)
    expect(P.viewTask(WORK_SLOT, 'far')?.status).toBe('review')
  })

  it('ends a write held by the Overview read that holds its task, once every read holding it delivered', async () => {
    answer = ok([row('far', 9)])
    await open()
    await openWork()
    overviews.get('overview:work')?.(work([row('far', 9, { status: 'todo' })]))
    await turn()
    const id = store.P.viewTask(SLOT, 'far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'progress' })
    // the Board's answer holds the write, then the server accepts it: Your
    // work, which holds a copy of the task, has not delivered since
    await serve(ok([row('far', 9, { status: 'progress' })]))
    writes[0]?.resolve(null)
    await turn()
    expect(probe().layerCount()).toBe(1)
    expect(store.P.viewTask(WORK_SLOT, 'far')?.status).toBe('progress')
    // its delivery holds it too and ends the paint
    overviews.get('overview:work')?.(work([row('far', 9, { status: 'progress' })]))
    await turn()
    expect(probe().layerCount()).toBe(0)
    expect(store.P.viewTask(WORK_SLOT, 'far')?.status).toBe('progress')
  })
})
