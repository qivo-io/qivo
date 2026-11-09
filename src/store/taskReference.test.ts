import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORG_DELETING } from '../../convex/lib/billingAccess'
import type { OwnerLoadsJson } from '../../convex/planning'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { DELAY_UNKNOWN } from '../lib/delay'
import { taskRef } from '../lib/taskReference'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* A task a window opens by a reference (lib/taskReference.ts) on the real
   store: the read of a reference that does not name the task's uuid and
   organization (P.watchTaskRef, the `reference` side of the live parts),
   the window's own read that takes over from it, the move of the
   reference to the task's handle, the walk of a uuid across the login's
   seats, again after an access change or Retry, and the boot's read of
   its address. Then the window's delay of
   a task the workspace cannot judge (P.windowDelay), from the owner-load
   cache. The live transport is the store's test double, whose side
   queries share one token per arguments, as in Convex. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { holdWindow(from: string | null): void; reconnect(): void },
}))
vi.mock('../lib/convex', async () => {
  const { liveOver } = await import('./guard/liveDouble.setup')
  double.live = liveOver(network, { taskWindow: 'client' })
  return { convex: network, live: double.live }
})
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))
// the hidden-tab gate, which a case turns
const gate = vi.hoisted(() => ({
  visible: true,
  listeners: new Set<(v: { visible: boolean; shownAt: number }) => void>(),
}))
vi.mock('../lib/viewVisibility', async (original) => ({
  ...(await original<typeof import('../lib/viewVisibility')>()),
  watchVisibility: (listener: (v: { visible: boolean; shownAt: number }) => void) => {
    gate.listeners.add(listener)
    listener({ visible: gate.visible, shownAt: 0 })
    return () => gate.listeners.delete(listener)
  },
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

const AT = '2026-09-14T08:00:00.000Z'
const GUEST = 'org-guest'
const GUEST_PROJECT = 'guest-project'
// tasks the workspace does not hold, by uuid
const FAR = '6f1c2a4e-0000-4000-8000-0000000000aa'
const OTHER = '6f1c2a4e-0000-4000-8000-0000000000bb'

let store: typeof import('./planner')
let snap: Snapshot
let org: string
let me: string
let subs: Live[]
let writes: { name: string; args: Record<string, unknown> }[]
let publishWhole: (snap: Snapshot) => void
// a window that shows the details column
const pane = {}

const named = (name: string) => subs.filter((s) => s.name === name)
const open = (name: string) => named(name).filter((s) => !s.closed)
/* The open subscription of `name`, of those `which` picks, which the
   test expects to be the only one. */
const one = (name: string, which: (live: Live) => boolean = () => true) => {
  const live = open(name).filter(which)
  expect(live).toHaveLength(1)
  return live[0]
}
/** A turn for the double's microtasks and the store's 0 ms paint timer. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
/* Waits out the store's next frame, which repaints what the project cache's
   answers bring (store/planner.ts projectCache): a level that follows a
   grant, or a project's delay rule. */
const frame = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Task `id`, number `num`, as the workspace holds it. */
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
/** The answer readWindowTask gives an active task (convex/lib/taskWindow.ts). */
const okAnswer = (
  id: string,
  num: number,
  extra: { task?: Record<string, unknown> } & Record<string, unknown> = {},
) => {
  const { task: row, ...rest } = extra
  return {
    state: 'ok',
    task: { ...task(id, num, { description: `Notes of ${num}` }), has_subtasks: false, ...row },
    level: 'user',
    labels: [],
    follow: null,
    parent: null,
    subtasks: { rows: [], complete: true },
    ...rest,
  }
}
/** The answer readWindowTask gives an archived task. */
const archivedAnswer = (id: string, num: number) => {
  const { description: _d, has_hidden_subtasks: _h, has_hidden_parent: _p, ...row } = task(id, num)
  return {
    state: 'archived',
    task: { ...row, archived_at: '2026-09-14T09:00:00.000Z', is_group: false },
    description: `Archived notes of ${num}`,
    labels: [],
    level: 'user',
  }
}
/** orgQuery's refusal (convex/lib/functions.ts). */
const refused = (message: string) => new ConvexError({ code: 'forbidden', message })

/** Boots a store on `snap`, with `opts` for initStore. */
async function boot(opts?: Parameters<typeof import('./planner')['initStore']>[2]) {
  vi.resetModules()
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
  await store.initStore(undefined, undefined, opts)
  // the views name the projects they show; this suite names them all
  await (await import('./oracleScope.setup')).nameProjects(store.P, snap)
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  gate.visible = true
  gate.listeners.clear()
  // the project under a top-level project, as every writer stores one
  // that holds tasks, so the navigation reads name it
  snap = underProgram(plannerFixture())
  org = snap.orgs[0].id
  me = snap.profiles[0].id
  snap.orgs[0].next_issue_num = 50
  snap.issues.push(task('task-a', 1))
  // a guest seat in another organization
  snap.orgs.push({ ...snap.orgs[0], id: GUEST, name: 'Partner', slug: 'partner' })
  snap.profiles.push({ ...snap.profiles[0], id: 'me-guest', org_id: GUEST, org_role: 'guest' })
  snap.myProfileIds.push('me-guest')
  // its sub-project under its own top-level project, as every writer
  // stores one that holds tasks
  snap.projects.push(
    {
      ...snap.projects[0],
      id: 'guest-program',
      org_id: GUEST,
      key: 'PROG',
      type: 'meta',
      parent_id: undefined,
    },
    {
      ...snap.projects[0],
      id: GUEST_PROJECT,
      org_id: GUEST,
      key: 'PART',
      parent_id: 'guest-program',
    },
  )
  subs = []
  writes = []
  network.query.mockResolvedValue(null)
  // the boot's seat claim answers at once; every other write waits
  network.mutation.mockImplementation((ref, args) => {
    const name = getFunctionName(ref)
    if (name === 'identity:claimMySeats') return Promise.resolve(null)
    writes.push({ name, args })
    return new Promise(() => {})
  })
  await boot()
})

afterEach(() => {
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  double.live?.holdWindow(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the read of a reference', () => {
  it('reads a number in the organization the reference names, by its key, and completes the identity from ok and archived', () => {
    const { P } = store
    const ref = taskRef({ org: GUEST, num: 40 })
    P.watchTaskRef(ref)
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: 'QN-40' })
    expect(P.reference).toEqual({ ref, state: 'loading', task: null })
    one('taskWindow:task').deliver(
      okAnswer(FAR, 40, { task: { org_id: GUEST, assignee_id: 'me-guest' } }),
    )
    expect(P.reference).toEqual({
      ref,
      state: 'resolved',
      task: {
        uuid: FAR,
        org: GUEST,
        num: 40,
        title: 'Task 40',
        project: snap.projects[0].id,
        owner: 'me-guest',
      },
    })
    one('taskWindow:task').deliver({
      ...archivedAnswer(FAR, 40),
      task: { ...archivedAnswer(FAR, 40).task, org_id: GUEST },
    })
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org: GUEST } })
    // the home organization's number 40 is never read for it
    expect(named('taskWindow:task').map((s) => s.args.org_id)).toEqual([GUEST])
  })

  it('keeps unavailable, a refusal for a lost seat and a failure apart, and follows a later answer', () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org: GUEST, num: 40 }))
    const read = one('taskWindow:task')
    read.deliver({ state: 'unavailable' })
    expect(P.reference?.state).toBe('unavailable')
    // the two exact refusals of a seat read as unavailable
    read.fail(refused('no profile in this organization'))
    expect(P.reference?.state).toBe('unavailable')
    read.fail(refused(ORG_DELETING))
    expect(P.reference?.state).toBe('unavailable')
    // every other error is a failure, a lost sign-in included
    read.fail(refused('not signed in'))
    expect(P.reference?.state).toBe('failed')
    read.deliver({ state: 'unavailable' })
    read.fail(new Error('Server Error'))
    expect(P.reference?.state).toBe('failed')
    // a task that becomes available opens
    read.deliver(okAnswer(FAR, 40, { task: { org_id: GUEST } }))
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR } })
  })

  it('serves the window from its answer until the task side answers, which alone lets a write through, then stops', () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org, num: 40 }))
    one('taskWindow:task').deliver(okAnswer(FAR, 40))
    // the window watches the task by the uuid its answer names
    P.watchComments(FAR, org)
    const side = open('taskWindow:task').find((s) => s.args.ref === FAR)
    expect(side?.args).toEqual({ org_id: org, ref: FAR })
    expect(P.taskDetail(FAR)).toMatchObject({ state: 'ok', view: { title: 'Task 40' } })
    const id = P.taskDetail(FAR)?.view?.id ?? ''
    // no write takes the reference's answer: saves wait for the check
    expect(P.editsFromAnswer(id)).toBe(false)
    expect(P.answerSaveWaits(id)).toBe(true)
    // the reference read's failure shows on the window while it serves it
    const ref = open('taskWindow:task').find((s) => s.args.ref === 'QN-40')
    ref?.fail(new Error('Server Error'))
    expect(P.taskDetail(FAR)?.state).toBe('failed')
    ref?.deliver(okAnswer(FAR, 40))
    // the task side's answer takes over, and the reference read stops
    side?.deliver(okAnswer(FAR, 40, { task: { title: 'Its own read' } }))
    expect(P.taskDetail(FAR)).toMatchObject({ state: 'ok', view: { title: 'Its own read' } })
    expect(P.editsFromAnswer(id)).toBe(true)
    expect(ref?.closed).toBe(true)
    expect(one('taskWindow:task')).toBe(side)
  })

  it('walks the seats for a uuid without an organization, the named one first, then home, one at a time', async () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org: null, uuid: FAR }))
    // home first, one read at a time
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: FAR })
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(P.reference?.state).toBe('loading')
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: FAR })
    // a refusal for a lost seat moves on too, and the last says unavailable
    one('taskWindow:task').fail(refused('no profile in this organization'))
    expect(P.reference?.state).toBe('unavailable')
    expect(open('taskWindow:task')).toEqual([])
    expect(named('taskWindow:task')).toHaveLength(2)
    // an address names the organization to read it in first, and the first
    // ok completes the reference with that organization
    P.watchTaskRef(taskRef({ org: null, uuid: OTHER, from: GUEST }))
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: OTHER })
    one('taskWindow:task').deliver(okAnswer(OTHER, 7, { task: { org_id: GUEST } }))
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: OTHER, org: GUEST } })
    // a failure stops the walk, and Retry reads that seat again
    P.watchTaskRef(taskRef({ org: null, uuid: FAR }))
    one('taskWindow:task').fail(new Error('Server Error'))
    expect(P.reference?.state).toBe('failed')
    expect(open('taskWindow:task')[0]?.args).toEqual({ org_id: org, ref: FAR })
    P.retryTask()
    expect(P.reference?.state).toBe('retrying')
    // a fresh subscription, whose first word decides
    expect(named('taskWindow:task').filter((s) => s.args.ref === FAR)).toHaveLength(4)
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: FAR })
    await turn()
    expect(P.reference?.state).toBe('retrying')
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: FAR })
  })

  it('reads a uuid every seat said unavailable for in the seats again once access changes, or on Retry', async () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org: null, uuid: FAR }))
    one('taskWindow:task').deliver({ state: 'unavailable' })
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(P.reference?.state).toBe('unavailable')
    expect(open('taskWindow:task')).toEqual([])
    // a change that grants nothing reads nothing
    snap.issues.push(task('task-b', 2))
    publishWhole(snap)
    await turn()
    expect(open('taskWindow:task')).toEqual([])
    // the partner shares its project with the guest seat, where the task
    // was archived. Every seat is read again, home first, and the window
    // goes on saying unavailable meanwhile
    snap.access.push({ project_id: GUEST_PROJECT, profile_id: 'me-guest', level: 'user' })
    publishWhole(snap)
    await frame()
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: FAR })
    expect(P.reference?.state).toBe('unavailable')
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(P.reference?.state).toBe('unavailable')
    expect(one('taskWindow:task').args).toEqual({ org_id: GUEST, ref: FAR })
    const archived = archivedAnswer(FAR, 40)
    one('taskWindow:task').deliver({
      ...archived,
      task: { ...archived.task, org_id: GUEST, project_id: GUEST_PROJECT },
    })
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org: GUEST } })
    // Retry reads another such uuid in every seat again, from the first
    P.watchTaskRef(taskRef({ org: null, uuid: OTHER }))
    one('taskWindow:task').deliver({ state: 'unavailable' })
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(open('taskWindow:task')).toEqual([])
    P.retryTask()
    expect(P.reference?.state).toBe('retrying')
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: OTHER })
  })

  it('reads the seats it said unavailable in again when access changes while a later seat reads', async () => {
    const { P } = store
    // the person leads neither of the home organization's projects, so the
    // project cache, which names them, answers them gone until a grant
    // below changes who can open what
    snap.projects = snap.projects.map((p) => (p.org_id === org ? { ...p, lead_id: undefined } : p))
    publishWhole(snap)
    await frame()
    await vi.waitFor(() => expect(P.projectState(snap.projects[0].id)).toBe('gone'))
    P.watchTaskRef(taskRef({ org: null, uuid: FAR }))
    one('taskWindow:task').deliver({ state: 'unavailable' })
    const guest = one('taskWindow:task')
    expect(guest.args).toEqual({ org_id: GUEST, ref: FAR })
    // the home organization shares the task's project with you while the
    // guest seat's read has not answered, and that read goes on
    snap.access.push({ project_id: snap.projects[0].id, profile_id: me, level: 'user' })
    publishWhole(snap)
    await frame()
    expect(one('taskWindow:task')).toBe(guest)
    expect(P.reference?.state).toBe('loading')
    // the guest seat says unavailable, and the walk reads the home seat again
    guest.deliver({ state: 'unavailable' })
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: FAR })
    expect(P.reference?.state).toBe('loading')
    one('taskWindow:task').deliver(okAnswer(FAR, 40))
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org } })
    // a walk every seat said unavailable for reads them again after a
    // change, and keeps a later seat's read through the next change
    P.watchTaskRef(taskRef({ org: null, uuid: OTHER }))
    one('taskWindow:task').deliver({ state: 'unavailable' })
    one('taskWindow:task').deliver({ state: 'unavailable' })
    expect(open('taskWindow:task')).toEqual([])
    snap.access.push({ project_id: GUEST_PROJECT, profile_id: 'me-guest', level: 'user' })
    publishWhole(snap)
    await frame()
    one('taskWindow:task').deliver({ state: 'unavailable' })
    const again = one('taskWindow:task')
    expect(again.args).toEqual({ org_id: GUEST, ref: OTHER })
    snap.access[0] = { ...snap.access[0], level: 'viewer' }
    publishWhole(snap)
    await frame()
    expect(one('taskWindow:task')).toBe(again)
    expect(P.reference?.state).toBe('unavailable')
    again.deliver({ state: 'unavailable' })
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: OTHER })
  })

  it("hands a uuid's read over to the window's task side with no second subscription, which turns editable at once and runs again on Retry", () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org: null, uuid: FAR, from: org }))
    one('taskWindow:task').deliver(okAnswer(FAR, 40))
    P.watchComments(FAR, org)
    // one subscription for both, as Convex keeps one for equal arguments
    expect(named('taskWindow:task')).toHaveLength(1)
    const id = P.taskDetail(FAR)?.view?.id ?? ''
    expect(P.editsFromAnswer(id)).toBe(true)
    // its failure is the task side's, and Retry subscribes afresh
    one('taskWindow:task').fail(new Error('Server Error'))
    expect(P.taskDetail(FAR)?.state).toBe('failed')
    P.retryTask()
    expect(named('taskWindow:task')).toHaveLength(2)
    one('taskWindow:task').deliver(okAnswer(FAR, 40))
    expect(P.taskDetail(FAR)?.state).toBe('ok')
    expect(P.editsFromAnswer(id)).toBe(true)
  })

  it("leaves the task side its subscription when a uuid's walk reaches the seat the window reads it in", async () => {
    const { P } = store
    // the window shows the guest organization's task from its own read
    P.watchComments(FAR, GUEST)
    const side = one('taskWindow:task')
    expect(side.args).toEqual({ org_id: GUEST, ref: FAR })
    side.deliver(okAnswer(FAR, 40, { task: { org_id: GUEST } }))
    // Back lands on an address that names it by its uuid under the home
    // organization's slug, which the home organization says is unavailable
    P.watchTaskRef(taskRef({ org: null, uuid: FAR, from: org }))
    const home = one('taskWindow:task', (s) => s !== side)
    expect(home.args).toEqual({ org_id: org, ref: FAR })
    home.deliver({ state: 'unavailable' })
    // the next seat is the one the task side reads: its answer names the task
    expect(home.closed).toBe(true)
    expect(one('taskWindow:task')).toBe(side)
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org: GUEST } })
    // the task side keeps its subscription, and the window hears a change
    side.deliver(okAnswer(FAR, 40, { task: { org_id: GUEST, title: 'Renamed' } }))
    await turn()
    expect(side.closed).toBe(false)
    expect(P.taskDetail(FAR)?.view?.title).toBe('Renamed')
    expect(P.editsFromAnswer(P.taskDetail(FAR)?.view?.id ?? '')).toBe(true)
  })

  it("hears the task side's first answer when the walk reaches its seat before it answered", () => {
    const { P } = store
    P.watchComments(FAR, GUEST)
    const side = one('taskWindow:task')
    P.watchTaskRef(taskRef({ org: null, uuid: FAR, from: org }))
    one('taskWindow:task', (s) => s.args.org_id === org).deliver({ state: 'unavailable' })
    expect(P.reference?.state).toBe('loading')
    expect(one('taskWindow:task')).toBe(side)
    side.deliver(okAnswer(FAR, 40, { task: { org_id: GUEST } }))
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org: GUEST } })
    // the answer is the task side's own, which lets a write through
    expect(side.closed).toBe(false)
    expect(P.editsFromAnswer(P.taskDetail(FAR)?.view?.id ?? '')).toBe(true)
  })

  it('reads on its own when the task side it waited on stops before it answered', () => {
    const { P } = store
    // an Inbox row's reference names the task, which the window watches
    P.watchTaskRef(taskRef({ org: GUEST, uuid: FAR }))
    P.watchComments(FAR, GUEST)
    const side = one('taskWindow:task')
    expect(side.args).toEqual({ org_id: GUEST, ref: FAR })
    // the same window then names it by its uuid under the partner's slug,
    // whose read is the task side's, which has not answered
    P.watchTaskRef(taskRef({ org: null, uuid: FAR, from: GUEST }))
    expect(one('taskWindow:task')).toBe(side)
    expect(P.reference?.state).toBe('loading')
    // the window lets the task go before the task side answered
    P.watchComments(null)
    expect(side.closed).toBe(true)
    const read = one('taskWindow:task')
    expect(read.args).toEqual({ org_id: GUEST, ref: FAR })
    read.deliver(okAnswer(FAR, 40, { task: { org_id: GUEST } }))
    expect(P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR, org: GUEST } })
  })

  it('reads the reference again on a fresh registry', async () => {
    const { P } = store
    P.watchTaskRef(taskRef({ org, num: 40 }))
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'QN-40' })
    await store.initStore()
    expect(named('taskWindow:task')).toHaveLength(2)
    expect(one('taskWindow:task').args).toEqual({ org_id: org, ref: 'QN-40' })
  })
})

describe("the boot's read of its address", () => {
  it('reads the task its address names while the parts load, with no read of its own once the window registers it', async () => {
    subs = []
    await boot({ address: { slug: 'Testbed', ref: 'QN-40' } })
    const read = one('taskWindow:task')
    expect(read.args).toEqual({ org_id: org, ref: 'QN-40' })
    read.deliver(okAnswer(FAR, 40))
    await turn()
    // the window's reference takes the read over, with its answer
    store.P.watchTaskRef(taskRef({ org, num: 40 }))
    expect(named('taskWindow:task')).toHaveLength(1)
    expect(store.P.reference).toMatchObject({ state: 'resolved', task: { uuid: FAR } })
    // its failure holds nothing of the workspace
    read.fail(new Error('Server Error'))
    expect(store.P.snapshotTrouble()).toBeNull()
    expect(store.P.reference?.state).toBe('failed')
  })

  it('reads nothing for a slug the login cannot resolve', async () => {
    subs = []
    await boot({ address: { slug: 'globex', ref: 'QN-40' } })
    expect(named('taskWindow:task')).toEqual([])
  })
})

describe("the window's delay", () => {
  // a task of mine the workspace does not hold, planned from this week,
  // whose verdict needs my other work
  const planned = (id: string, num: number, extra: Record<string, unknown> = {}) =>
    okAnswer(id, num, {
      task: {
        assignee_id: me,
        status: 'progress',
        remaining_hours: 10,
        start_week: weekToISO(TODAY_WEEK),
        end_week: weekToISO(TODAY_WEEK + 1),
        due_date: weekToISO(TODAY_WEEK + 2),
        ...extra,
      },
    })
  // my other work, which fills every week until well past the due date
  const busy: OwnerLoadsJson = {
    hidden: 'counted',
    owners: [
      {
        owner_id: '',
        state: 'ok',
        spans: [
          {
            issue_id: null,
            project_id: null,
            start_week: weekToISO(TODAY_WEEK),
            end_week: weekToISO(TODAY_WEEK + 4),
            remaining: 400,
            remaining_set_at: null,
          },
        ],
        paused: [],
      },
    ],
  }
  const loadOf = (json: OwnerLoadsJson) => ({
    ...json,
    owners: json.owners.map((o) => ({ ...o, owner_id: me })),
  })

  /** Shows FAR from its answer in a window with the details column. */
  async function showFar(answer = planned(FAR, 40)) {
    snap.projects[0].track_delay = true
    publishWhole(snap)
    await frame()
    const { P } = store
    P.watchComments(FAR, org)
    P.showSections(pane, true)
    one('taskWindow:task').deliver(answer)
    await turn()
    const view = P.taskDetail(FAR)?.view
    if (!view) throw new Error('no view of the task')
    return view
  }

  it("judges from the owner's load where the workspace cannot: nothing while it waits, Delayed from the load, unknown when unavailable or failed", async () => {
    const view = await showFar()
    const { P } = store
    const load = one('planning:ownerLoads')
    expect(load.args).toEqual({ org_id: org, owner_ids: [me] })
    // nothing while the first answer is on its way, as a card shows
    expect(P.windowDelay(view)).toBeNull()
    load.deliver(loadOf(busy))
    await turn()
    expect(P.windowDelay(view)).toMatchObject({ status: 'late' })
    // with nothing else to do it is on track
    load.deliver(
      loadOf({ hidden: 'counted', owners: [{ owner_id: '', state: 'ok', spans: [], paused: [] }] }),
    )
    await turn()
    expect(P.windowDelay(view)).toMatchObject({ status: 'ok' })
    load.deliver(loadOf({ hidden: 'counted', owners: [{ owner_id: '', state: 'unavailable' }] }))
    await turn()
    expect(P.windowDelay(view)).toBe(DELAY_UNKNOWN)
    load.fail(new Error('Server Error'))
    await turn()
    expect(P.windowDelay(view)).toBe(DELAY_UNKNOWN)
  })

  it('asks for the owner only with the details column, a project that shows delays and a task the workspace cannot judge, and releases it after', async () => {
    const { P } = store
    // no details column
    P.watchComments(FAR, org)
    one('taskWindow:task').deliver(planned(FAR, 40))
    await turn()
    expect(named('planning:ownerLoads')).toEqual([])
    // a project that shows no delays
    P.showSections(pane, true)
    await turn()
    expect(named('planning:ownerLoads')).toEqual([])
    // one that does
    snap.projects[0].track_delay = true
    publishWhole(snap)
    await frame()
    expect(one('planning:ownerLoads').args).toEqual({ org_id: org, owner_ids: [me] })
    // the column closes
    P.showSections(pane, false)
    await turn()
    expect(open('planning:ownerLoads')).toEqual([])
    // a held task in a complete workspace keeps the workspace's verdict
    P.watchComments('task-a', org)
    P.showSections(pane, true)
    await turn()
    expect(open('planning:ownerLoads')).toEqual([])
  })

  it("asks for no load where the verdict needs none: a group from its subtasks' dates, a passed due date late", async () => {
    const group = okAnswer(FAR, 40, {
      task: { has_subtasks: true, assignee_id: me, due_date: weekToISO(TODAY_WEEK + 1) },
      subtasks: {
        rows: [
          {
            ...okAnswer(OTHER, 41).task,
            parent_id: FAR,
            assignee_id: me,
            start_week: weekToISO(TODAY_WEEK),
            end_week: weekToISO(TODAY_WEEK + 3),
            level: 'user',
          },
        ],
        complete: true,
      },
    })
    const view = await showFar(group)
    const { P } = store
    expect(named('planning:ownerLoads')).toEqual([])
    expect(P.windowDelay(view)).toMatchObject({ status: 'late' })
    // a leaf whose due date passed is late with no load read
    P.watchComments(OTHER, org)
    one('taskWindow:task').deliver(planned(OTHER, 41, { due_date: weekToISO(TODAY_WEEK - 1) }))
    await turn()
    const late = P.taskDetail(OTHER)?.view
    if (!late) throw new Error('no view')
    expect(P.windowDelay(late)).toMatchObject({ status: 'late' })
  })

  it("a guest's window reads one owner a call, and none while the tab is hidden", async () => {
    // an organization Viewer leads nothing, so a grant shows them the task's
    // project, whose delay rule the window reads from the project cache
    snap.profiles[0].org_role = 'viewer'
    snap.access.push({ project_id: snap.projects[0].id, profile_id: me, level: 'viewer' })
    await showFar()
    await vi.waitFor(() => expect(store.P.projectState(snap.projects[0].id)).toBe('ok'))
    expect(one('planning:ownerLoads').args).toEqual({ org_id: org, owner_ids: [me] })
    gate.visible = false
    for (const listener of gate.listeners) listener({ visible: false, shownAt: 0 })
    await turn()
    expect(open('planning:ownerLoads')).toEqual([])
    gate.visible = true
    for (const listener of gate.listeners) listener({ visible: true, shownAt: 1 })
    await turn()
    expect(open('planning:ownerLoads')).toHaveLength(1)
  })

  it('moves at once with a Remaining edit sent from its answer, before the server answers, as a Board card of the same task does', async () => {
    const view = await showFar()
    const { P } = store
    // the Board's answer brings a card of the same task
    P.watchBoard('board:desktop', '{"board":1}')
    await turn()
    const { description: _text, ...row } = planned(FAR, 40).task
    one('tasks:board').deliver({
      state: 'ok',
      rows: [row],
      parents: [],
      held_projects: [snap.projects[0].id],
    })
    await turn()
    for (const load of open('planning:ownerLoads')) load.deliver(loadOf(busy))
    await turn()
    const card = () => P.viewTask('board:desktop', FAR)
    expect(card()).toBeDefined()
    expect(P.windowDelay(view)).toMatchObject({ status: 'late' })
    expect(P.delayOf(card() ?? '')).toEqual(P.windowDelay(view))
    void P.updateIssue(view.id, { remaining: 0 })
    await turn()
    expect(writes.map((w) => w.name)).toContain('issues:update')
    const painted = P.taskDetail(FAR)?.view
    if (!painted) throw new Error('no view')
    expect(painted.remaining).toBe(0)
    expect(P.windowDelay(painted)).not.toMatchObject({ status: 'late' })
    // the card shows the pending edit too, with the window's verdict
    expect(card()?.remaining).toBe(0)
    expect(P.delayOf(card() ?? '')).toEqual(P.windowDelay(painted))
  })
})
