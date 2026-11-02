import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { OwnerLoadsJson } from '../../convex/planning'
import { isoToWeek, TODAY_WEEK, weekToISO } from '../lib/dates'
import { GUEST_CALLS } from './ownerLoadCache'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'

/* The task rows a view's answer brings (store/viewRows.ts) on the real
   store: the Board's read the store owns (P.watchBoard), the models it
   shapes from the rows the workspace does not hold, the `view` layer part
   a write on such a task paints (store/layers.ts), what ends it, and the
   delays the owner-load cache judges (store/viewDelay.ts). */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(): void },
}))
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

const AT = '2026-09-14T08:00:00.000Z'
const SLOT = 'board:desktop'
const KEY = '{"board":1}'

let store: typeof import('./planner')
let snapshot: Snapshot
let deliver: (snap: Snapshot) => void
let answer: BoardAnswer
let board: ((value: BoardAnswer) => void) | null
let loads: Map<string, (value: OwnerLoadsJson) => void>
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
    has_hidden_subtasks: false,
    has_hidden_parent: false,
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
  has_hidden_subtasks: false,
  has_hidden_parent: false,
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
  snapshot = plannerFixture()
  snapshot.issues.push(held('task-a', 1))
  answer = ok([])
  board = null
  loads = new Map()
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
    return () => {}
  })
  store = await import('./planner')
  await store.initStore()
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
    // a held task is the workspace's, never a model of the answer's row
    expect(P.viewTask(SLOT, 'task-a')).toBeUndefined()
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

  it('lets the workspace win where it holds a task, and the row stand in once it drops it', async () => {
    answer = ok([row('task-a', 1, { title: 'From the answer' })])
    await open()
    const handle = store.P.handleOf('task-a') ?? ''
    expect(store.P.anyTask(handle)?.title).toBe('Task task-a')
    expect(store.P.viewTask(SLOT, 'task-a')).toBeUndefined()
    // the workspace no longer holds it, while the answer still names it
    snapshot.issues = snapshot.issues.filter((t) => t.id !== 'task-a')
    deliver(structuredClone(snapshot))
    await turn()
    expect(store.P.handleOf('task-a')).toBeNull()
    expect(store.P.viewTask(SLOT, 'task-a')?.title).toBe('From the answer')
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
    views.reshape(() => false, ctx())
    const first = views.model('v', 'far')
    expect(first?.id).toBe('QN-9')
    expect(views.reshape(() => false, ctx())).toBe(false)
    expect(views.model('v', 'far')).toBe(first)
    // the home organization moved, so the task opens by its uuid now
    handle = 'far'
    expect(views.reshape(() => false, ctx())).toBe(true)
    const moved = views.model('v', 'far')
    expect(moved?.id).toBe('far')
    expect(views.byHandle('far')).toBe(moved)
    expect(views.byHandle('QN-9')).toBeUndefined()
    // a re-anchored week grid gives week indexes on the new grid
    grid = 2
    expect(views.reshape(() => false, ctx())).toBe(true)
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
    void P.updateIssue(P.handleOf('task-a') ?? '', { title: 'Renamed' })
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
    // its view part went with the rows; its workspace part, which paints
    // the task once the workspace holds it, goes with the next workspace
    // delivery, as every accepted write's does
    expect(probe().layerCount()).toBe(1)
    deliver(structuredClone(snapshot))
    await turn()
    expect(probe().layerCount()).toBe(0)
  })

  it('walks the parents an answer brings for the roster check', async () => {
    answer = ok(
      [row('kid', 8, { parent_id: 'par' })],
      [row('par', 7, { has_subtasks: true, project_id: 'elsewhere' })],
    )
    await open()
    const kid = store.P.viewTask(SLOT, 'kid')
    if (!kid) throw new Error('no kid')
    // someone who cannot see the parent's project is held off the task
    const unseen = store.P.unseenAbove(kid, 'someone', (project) => project !== 'elsewhere')
    expect(unseen?.uuid).toBe('par')
    expect(store.P.unseenAbove(kid, 'someone', () => true)).toBeNull()
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
    receive({ hidden: 'counted', owners: [{ owner_id: me, state: 'ok', spans: [] }] })
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
    answer = ok(people.map((p, i) => ({ ...planned(`t${i}`, 10 + i), assignee_id: p.id })))
    await open()
    const P = store.P
    const unknown = (i: number) => P.delayUnknown(P.viewTask(SLOT, `t${i}`) ?? '')
    // one call an owner, at most GUEST_CALLS, by id among equal card counts
    expect(loads.size).toBe(GUEST_CALLS)
    for (let i = 0; i < GUEST_CALLS; i++) expect(unknown(i), `t${i}`).toBe(false)
    for (let i = GUEST_CALLS; i < people.length; i++) expect(unknown(i), `t${i}`).toBe(true)
  })

  it("asks no load for a held task, whose delay stays the workspace's", async () => {
    snapshot.projects[0].track_delay = true
    deliver(structuredClone(snapshot))
    await turn()
    answer = ok([{ ...planned('task-a', 1) }])
    await open()
    expect(loads.size).toBe(0)
  })
})
