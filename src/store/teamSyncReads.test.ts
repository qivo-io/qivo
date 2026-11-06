import { getFunctionName } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnswer } from '../../convex/lib/board'
import { roundTenths } from '../../convex/lib/numbers'
import type { AgendaAnswer, AgendaRow } from '../../convex/lib/teamSyncAgenda'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { OwnerLoadsJson } from '../../convex/planning'
import { isoFromDate, weekToDate } from '../lib/dates'
import { agendaScopeOf, type SyncScope, syncAgendaKey } from '../lib/teamSync'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* Team sync's agenda as a view read on the real store (P.watchSync): what
   it subscribes and when, the rows its answer brings (store/viewRows.ts),
   what a refusal, a failure, a new day and a release keep, an organization
   Viewer's people through the owner-load cache, the week a person's
   pending edits move (P.syncLoadChanges), and the view write path's
   Remaining and Pause on a task only the agenda brings. The store boots
   not asked, as production does. */

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
const double = vi.hoisted(() => ({
  live: null as null | { reconnect(only?: readonly string[]): void },
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

let store: typeof import('./planner')
let snapshot: Snapshot
let answer: AgendaAnswer
let deliver: (snap: Snapshot) => void
/* the agenda's subscriptions open now, by key, and every one asked */
let open: Map<string, { next: (v: unknown) => void; fail: (e: unknown) => void }>
let asked: string[]
let loads: Map<string, (value: OwnerLoadsJson) => void>
/* the Board's answer, for a case that reads it beside the agenda */
let boardAnswer: BoardAnswer
let lastComments: { args: Record<string, unknown>; unsub: ReturnType<typeof vi.fn> }[]
let writes: {
  name: string
  args: Record<string, unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}[]

/** A turn for the double's microtasks and the store's 0 ms paint timer. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

const me = () => snapshot.profiles[0].id
const sub = () => snapshot.projects[0].id
const iso = (week: number) => isoFromDate(weekToDate(week))

/** Task `id` as the agenda sends a row, in the fixture's sub-project. */
function row(id: string, num: number, over: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id,
    org_id: snapshot.orgs[0].id,
    project_id: sub(),
    num,
    title: `Task ${id}`,
    status: 'todo',
    priority: 'medium',
    paused: false,
    assignee_id: me(),
    created_at: AT,
    updated_at: AT,
    has_subtasks: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    blocked_by: [],
    delay: null,
    ...over,
  }
}

/** An ok agenda with `rows`, walking the fixture's person, whose week is
    `hours` (or unavailable), and `extra` over it. */
function ok(
  rows: AgendaRow[],
  hours: number | null = 10,
  extra: Partial<Extract<AgendaAnswer, { state: 'ok' }>> = {},
): AgendaAnswer {
  return {
    state: 'ok',
    sub_projects: [sub()],
    top_projects: [snapshot.projects[0].parent_id ?? ''],
    editable: [sub()],
    rows,
    asks: [],
    done: [],
    parents: [],
    people: [
      {
        id: me(),
        name: 'Planner',
        kind: 'person',
        active: true,
        plannable_hours: null,
        stamp: null,
        week: hours === null ? { state: 'unavailable', reason: 'loads' } : { state: 'ok', hours },
      },
    ],
    hidden: 'counted',
    ...extra,
  }
}

/** The key Team sync asks with for `scope` on the store's clock, or a day
    `day` of it. */
async function keyOf(scope: SyncScope, day?: string) {
  const { overviewClock } = await import('../views/overview/overviewArgs')
  const clock = overviewClock()
  return syncAgendaKey({
    org_id: snapshot.orgs[0].id,
    scope: agendaScopeOf(scope),
    ...clock,
    ...(day ? { day } : {}),
  })
}

/** Sets the server's answer, delivered at once to every open read. */
async function serve(next: AgendaAnswer) {
  answer = next
  for (const read of open.values()) read.next(structuredClone(next))
  await turn()
}

const probe = () => {
  if (!store.__layerProbe) throw new Error('the layer probe is test-only')
  return store.__layerProbe
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('window', { showToast: vi.fn(), setTimeout, clearTimeout })
  snapshot = underProgram(plannerFixture())
  answer = ok([])
  boardAnswer = { state: 'ok', rows: [], parents: [], held_projects: [] }
  open = new Map()
  asked = []
  loads = new Map()
  lastComments = []
  writes = []
  network.query.mockResolvedValue(null)
  network.mutation.mockImplementation((ref, args) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise((resolve, reject) =>
          writes.push({ name: getFunctionName(ref), args, resolve, reject }),
        ),
  )
  network.onUpdate.mockImplementation((ref, args, receive, fail) => {
    const name = getFunctionName(ref)
    if (name === 'workspace:whole') {
      deliver = (snap) => receive(structuredClone(snap))
      deliver(snapshot)
    } else if (name === 'teamSync:agenda') {
      const key = JSON.stringify(args)
      asked.push(key)
      open.set(key, { next: receive, fail })
      receive(structuredClone(answer))
      return () => open.delete(key)
    } else if (name === 'tasks:board') receive(structuredClone(boardAnswer))
    else if (name === 'planning:ownerLoads') {
      // open while subscribed, so a case can tell a call ended
      const key = (args.owner_ids as string[]).join()
      const call = receive as (v: OwnerLoadsJson) => void
      loads.set(key, call)
      return () => {
        if (loads.get(key) === call) loads.delete(key)
      }
    } else if (name === 'teamSync:lastComments') {
      const unsub = vi.fn()
      lastComments.push({ args, unsub })
      return unsub
    }
    return () => {}
  })
  const { TASKS } = await import('./liveParts')
  TASKS.atBoot = false
  store = await import('./planner')
  await store.initStore()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (store?.__layerProbe) expect(store.__layerProbe.faults()).toEqual([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Opens Team sync's read for `key` and waits for its answer. */
async function watch(key: string, attempt = 0) {
  store.P.watchSync(key, 1, attempt)
  await turn()
  await turn()
}

describe("Team sync's read", () => {
  it('subscribes only while the page asks, with its arguments in their fixed order', async () => {
    expect(asked).toEqual([])
    const key = await keyOf({ kind: 'project', id: sub() })
    await watch(key)
    expect(asked).toEqual([key])
    expect(Object.keys(JSON.parse(asked[0]))).toEqual([
      'org_id',
      'scope',
      'day',
      'week',
      'week_starts',
      'week_end',
    ])
    expect(store.P.syncRead()).toMatchObject({ key, current: true, value: { state: 'ok' } })
    // the same arguments again subscribe nothing new
    store.P.watchSync(key, 1)
    expect(asked).toHaveLength(1)
  })

  it('brings its rows into the views, shaped where the workspace lacks them, and no owner load for staff', async () => {
    answer = ok([row('far', 9, { delay: 'late', blocked_by: ['QN-2'] })])
    await watch(await keyOf({ kind: 'all' }))
    const far = store.P.syncTask('far')
    expect(far?.title).toBe('Task far')
    expect(store.P.anyTask(far?.id ?? '')).toBe(far)
    // the read shows no delays from the cache: the answer carries them
    expect(loads.size).toBe(0)
    // the rows never enter the workspace's lists
    expect(store.P.handleOf('far')).toBeNull()
  })

  it('drops the rows on a new scope or a new attempt', async () => {
    answer = ok([row('far', 9)])
    await watch(await keyOf({ kind: 'all' }))
    expect(store.P.syncTask('far')).toBeDefined()
    answer = ok([])
    store.P.watchSync(await keyOf({ kind: 'team', id: 'team-1' }), 1)
    // another scope is another meeting: it never stands in, even refreshing
    expect(store.P.syncTask('far')).toBeUndefined()
    expect(store.P.syncRead().key).toBeNull()
    answer = ok([row('far', 9)])
    await watch(await keyOf({ kind: 'all' }))
    expect(store.P.syncTask('far')).toBeDefined()
    answer = ok([])
    store.P.watchSync(await keyOf({ kind: 'all' }), 1, 1)
    expect(store.P.syncRead().key).toBeNull()
  })

  it('stops while hidden and keeps its answer, which is not current until it arrives again', async () => {
    answer = ok([row('far', 9)])
    const key = await keyOf({ kind: 'all' })
    await watch(key)
    store.P.watchSync(null, 1)
    expect(open.size).toBe(0)
    expect(store.P.syncRead()).toMatchObject({ key, current: false })
    expect(store.P.syncTask('far')).toBeDefined()
    // another mounted page's late cleanup stops nothing of this one's
    await watch(key)
    store.P.watchSync(null, 2)
    expect(open.size).toBe(1)
    expect(store.P.syncRead().current).toBe(true)
    // after a reconnect the answer is not current until it arrives again
    double.live?.reconnect(['workspace:root'])
    expect(store.P.syncRead().current).toBe(false)
    double.live?.reconnect()
    expect(store.P.syncRead().current).toBe(true)
  })

  it('keeps the meeting and its last ok answer through over_ceiling, over_budget and a failure, and drops it when unavailable', async () => {
    answer = ok([row('far', 9)])
    const key = await keyOf({ kind: 'all' })
    await watch(key)
    const fitted = store.P.syncRead().value
    for (const refusal of [
      { state: 'over_ceiling', ceiling: 1000 },
      { state: 'over_budget' },
    ] as const) {
      await serve(refusal)
      expect(store.P.syncRead()).toMatchObject({ key, value: refusal })
      expect(store.P.syncRead().fitted).toEqual({ key, value: fitted, until: expect.any(Number) })
      expect(store.P.syncTask('far')).toBeDefined()
    }
    // a failure after ok keeps them too
    open.get(key)?.fail(new ConvexError({ code: 'internal', message: 'down' }))
    await turn()
    expect(store.P.syncRead().error).toBeDefined()
    expect(store.P.syncRead().fitted?.key).toBe(key)
    expect(store.P.syncTask('far')).toBeDefined()
    // the next ok answer ends it
    await serve(ok([row('far', 9, { title: 'Again' })]))
    expect(store.P.syncTask('far')?.title).toBe('Again')
    // access to the scope went: the rows go at once
    await serve({ state: 'unavailable' })
    expect(store.P.syncTask('far')).toBeUndefined()
    expect(store.P.syncRead().fitted).toBeNull()
  })

  it('says when the meeting it kept stopped being current, the earliest of the read stopping, a reconnect and a refusal', async () => {
    answer = ok([row('far', 9)])
    const key = await keyOf({ kind: 'all' })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const day = new Date()
      const at = (hours: number) => new Date(day).setHours(hours, 0, 0, 0)
      vi.setSystemTime(at(8))
      await watch(key)
      expect(store.P.syncRead().fitted?.until).toBeNull()
      // a refusal while current stops it when it arrives
      vi.setSystemTime(at(9))
      await serve({ state: 'over_ceiling', ceiling: 1000 })
      expect(store.P.syncRead().fitted?.until).toBe(at(9))
      // a later refusal of another kind keeps the earlier time
      vi.setSystemTime(at(10))
      await serve({ state: 'over_budget' })
      expect(store.P.syncRead().fitted?.until).toBe(at(9))
      // an ok answer is current again; a hidden tab stops it from then
      await serve(ok([row('far', 9)]))
      expect(store.P.syncRead().fitted?.until).toBeNull()
      vi.setSystemTime(at(11))
      store.P.watchSync(null, 1)
      expect(store.P.syncRead().fitted?.until).toBe(at(11))
      // the refusal that greets the return leaves the hide's time
      vi.setSystemTime(at(15))
      answer = { state: 'over_ceiling', ceiling: 1000 }
      await watch(key)
      expect(store.P.syncRead()).toMatchObject({ value: answer, fitted: { until: at(11) } })
      // a reconnect stops it the moment the answer is no longer current
      answer = ok([row('far', 9)])
      await serve(answer)
      expect(store.P.syncRead().fitted?.until).toBeNull()
      vi.setSystemTime(at(16))
      double.live?.reconnect(['workspace:root'])
      expect(store.P.syncRead().current).toBe(false)
      expect(store.P.syncRead().fitted?.until).toBe(at(16))
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the meeting across a new day for the same scope until the new day answers, never as current', async () => {
    answer = ok([row('far', 9)])
    const today = await keyOf({ kind: 'all' })
    await watch(today)
    // the next local day of the same meeting, which the server holds back
    const next = today.replace(/"day":"[^"]+"/, '"day":"2999-01-01"')
    const day = JSON.parse(next).day
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${day}T12:00:00`))
    network.onUpdate.mockImplementationOnce((_ref, args, receive, fail) => {
      open.set(JSON.stringify(args), { next: receive, fail })
      asked.push(JSON.stringify(args))
      return () => open.delete(JSON.stringify(args))
    })
    store.P.watchSync(next, 1)
    vi.useRealTimers()
    // the old meeting stays, kept for its own key and not current
    expect(store.P.syncTask('far')).toBeDefined()
    expect(store.P.syncRead()).toMatchObject({ key: today, current: false })
    // the new day's answer replaces it
    open.get(next)?.next(ok([row('near', 10)]))
    await turn()
    expect(store.P.syncTask('far')).toBeUndefined()
    expect(store.P.syncTask('near')).toBeDefined()
    expect(store.P.syncRead()).toMatchObject({ key: next, current: true })
  })

  it('asks nothing for a day that is not the local day now', async () => {
    const stale = await keyOf({ kind: 'all' }, '2000-01-03')
    store.P.watchSync(stale, 1)
    await turn()
    expect(asked).toEqual([])
  })

  it("moves a store that lags behind midnight to the new day, holding yesterday's meeting until today's answers", async () => {
    answer = ok([row('far', 9)])
    const yesterday = await keyOf({ kind: 'all' })
    await watch(yesterday)
    const was = store.P.TODAY_ISO
    // the next local day, before the store's day watch ran, as after sleep
    const next = new Date()
    next.setDate(next.getDate() + 1)
    next.setHours(12, 0, 0, 0)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(next)
      // a kept page shown again asks with the day it held
      store.P.watchSync(yesterday, 1)
      expect(store.P.TODAY_ISO).toBe(isoFromDate(next))
      expect(store.P.TODAY_ISO).not.toBe(was)
      // nothing asked for yesterday, and its meeting stays, not current
      expect(asked).toEqual([yesterday])
      expect(store.P.syncTask('far')).toBeDefined()
      expect(store.P.syncRead()).toMatchObject({ key: yesterday, current: false })
      // the page asks again with the store's new day, which the server holds
      // back, and yesterday's meeting stands in
      network.onUpdate.mockImplementationOnce((_ref, args, receive, fail) => {
        open.set(JSON.stringify(args), { next: receive, fail })
        asked.push(JSON.stringify(args))
        return () => open.delete(JSON.stringify(args))
      })
      const today = await keyOf({ kind: 'all' })
      expect(JSON.parse(today).day).toBe(isoFromDate(next))
      store.P.watchSync(today, 1)
      expect(asked).toEqual([yesterday, today])
      expect(store.P.syncTask('far')).toBeDefined()
      expect(store.P.syncRead()).toMatchObject({ key: yesterday, current: false })
      open.get(today)?.next(ok([row('near', 10)]))
      await turn()
      expect(store.P.syncTask('far')).toBeUndefined()
      expect(store.P.syncRead()).toMatchObject({ key: today, current: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets its rows, a Viewer's people and the last comments' marks go on release", async () => {
    answer = ok([row('far', 9)])
    await watch(await keyOf({ kind: 'all' }))
    store.P.watchSyncPeople([me()], true)
    store.P.watchTeamSync(snapshot.orgs[0].id, [me()])
    expect(loads.size).toBe(1)
    store.P.releaseSync()
    expect(store.P.syncTask('far')).toBeUndefined()
    expect(store.P.syncRead().key).toBeNull()
    // the people's call (sync:people) ends with it
    expect(loads.size).toBe(0)
    expect(lastComments[0]?.unsub).toHaveBeenCalledOnce()
    expect(store.P.lastComments.size).toBe(0)
    expect(probe().layerCount()).toBe(0)
  })
})

describe("a stopped meeting's rows", () => {
  it("never stand in for the cache's spans of their tasks in a live view's delays", async () => {
    snapshot.projects[0].track_delay = true
    deliver(snapshot)
    await turn()
    const week = store.P.TODAY_WEEK
    // the meeting read Far before someone gave it 40 hours a week up to the
    // card's due week
    answer = ok([row('far', 9, { remaining_hours: 0, start_week: iso(week), end_week: iso(week) })])
    await watch(await keyOf({ kind: 'all' }))
    store.P.watchSync(null, 1)
    // the Board, live, shows a card of the same person due in two weeks
    const card = row('card', 10, {
      status: 'progress',
      remaining_hours: 10,
      start_week: iso(week),
      end_week: iso(week + 1),
      due_date: iso(week + 2),
    })
    const { blocked_by: _b, delay: _d, ...cardRow } = card
    boardAnswer = { state: 'ok', rows: [cardRow], parents: [], held_projects: [sub()] }
    store.P.watchBoard('board:desktop', '{"board":1}')
    await turn()
    await turn()
    // the cache answers the person's load as it is now: Far fills the weeks
    const receive = loads.get(me())
    if (!receive) throw new Error('no owner load asked')
    receive({
      hidden: 'counted',
      owners: [
        {
          owner_id: me(),
          state: 'ok',
          spans: [
            {
              issue_id: 'far',
              project_id: sub(),
              start_week: iso(week),
              end_week: iso(week + 2),
              remaining: 120,
              remaining_set_at: null,
            },
          ],
          paused: [],
        },
      ],
    })
    await turn()
    // the stopped meeting's 0 hours would read the card as on track, which
    // must fail: the live cache's hours push it past its due date
    const verdict = store.P.delayOf(store.P.viewTask('board:desktop', 'card') ?? '')
    expect(verdict?.status).not.toBe('ok')
    expect(verdict).not.toBeNull()
  })
})

describe("an organization Viewer's people", () => {
  it('reads one owner a call for an organization Viewer', async () => {
    const leo = crypto.randomUUID()
    snapshot.profiles[0].org_role = 'viewer'
    snapshot.profiles.push({
      ...snapshot.profiles[0],
      id: leo,
      name: 'Leo',
      auth_user_id: undefined,
    })
    await store.initStore()
    store.P.watchSyncPeople([me(), leo], true)
    // one call each, never one that names both
    expect([...loads.keys()].sort()).toEqual([me(), leo].sort())
  })

  it('reads the people of staff in one call, live only while shown, and the week from the visible share', async () => {
    const leo = crypto.randomUUID()
    snapshot.profiles.push({
      ...snapshot.profiles[0],
      id: leo,
      name: 'Leo',
      auth_user_id: undefined,
    })
    await store.initStore()
    store.P.watchSyncPeople([me(), leo], true)
    expect([...loads.keys()].sort()).toEqual([[me(), leo].sort().join()])
    // staff reads them together; the store's cache answers their loads
    expect(store.P.syncPersonLoad(me())).toEqual({ state: 'waiting' })
    const week = store.P.TODAY_WEEK
    loads.get([me(), leo].sort().join())?.({
      hidden: 'counted',
      owners: [me(), leo].sort().map((owner_id) => ({
        owner_id,
        state: 'ok' as const,
        spans: [
          {
            issue_id: null,
            project_id: null,
            start_week: iso(week),
            end_week: iso(week + 1),
            remaining: 7,
            remaining_set_at: null,
          },
        ],
        paused: [],
      })),
    })
    await turn()
    expect(store.P.syncPersonLoad(me())).toEqual({ state: 'ok', hours: 3.5 })
    // a hidden page keeps the answer without a call
    store.P.watchSyncPeople([me(), leo], false)
    expect(store.P.syncPersonLoad(me())).toEqual({ state: 'ok', hours: 3.5 })
  })
})

describe('the week a person’s pending edits move', () => {
  const week = () => store.P.TODAY_WEEK
  const saved = (rows: ViewRow[]) => new Map(rows.map((r) => [r.id, r]))

  it('moves by a pending Remaining at once, counted once, and settles at 0 once the answer holds it', async () => {
    const far = row('far', 9, {
      start_week: iso(week()),
      end_week: iso(week() + 1),
      remaining_hours: 8,
    })
    answer = ok([far], 4)
    await watch(await keyOf({ kind: 'all' }))
    expect(store.P.syncLoadChanges(saved([far]), week()).size).toBe(0)
    const id = store.P.syncTask('far')?.id ?? ''
    void store.P.updateIssue(id, { remaining: 12 })
    const changes = store.P.syncLoadChanges(saved([far]), week())
    // the saved 4 of this week out, the pending 6 in: +2, not +6
    expect(changes.get(me())).toBe(2)
    expect(roundTenths(4 + (changes.get(me()) ?? 0))).toBe(6)
    // counting the pending hours without taking the saved ones out would
    // say 10, which must fail
    expect(roundTenths(4 + 6)).not.toBe(roundTenths(4 + (changes.get(me()) ?? 0)))
    // the answer that holds the write: the two rows agree, nothing to add
    await serve(ok([{ ...far, remaining_hours: 12 }], 6))
    writes[0]?.resolve(null)
    await turn()
    expect(store.P.syncLoadChanges(saved([{ ...far, remaining_hours: 12 }]), week()).size).toBe(0)
  })

  it('moves the hours to the new owner, and takes them away on Done or a Pause but not on Backlog', async () => {
    const leo = crypto.randomUUID()
    snapshot.profiles.push({
      ...snapshot.profiles[0],
      id: leo,
      name: 'Leo',
      auth_user_id: undefined,
    })
    await store.initStore()
    const far = row('far', 9, {
      start_week: iso(week()),
      end_week: iso(week()),
      remaining_hours: 5,
    })
    answer = ok([far], 5)
    await watch(await keyOf({ kind: 'all' }))
    const id = store.P.syncTask('far')?.id ?? ''
    void store.P.updateIssue(id, { assignee: leo })
    let changes = store.P.syncLoadChanges(saved([far]), week())
    expect([changes.get(me()), changes.get(leo)]).toEqual([-5, 5])
    writes[0]?.reject(new ConvexError({ code: 'forbidden', message: 'no' }))
    await turn()
    // a refusal restores the figure
    expect(store.P.syncLoadChanges(saved([far]), week()).size).toBe(0)
    for (const [patch, delta] of [
      [{ status: 'done' as const }, -5],
      [{ paused: true }, -5],
      // a move into Backlog keeps scheduled hours: the server's fence leaves
      // out only Done and paused tasks
      [{ status: 'backlog' as const }, 0],
    ] as const) {
      void store.P.updateIssue(id, patch)
      changes = store.P.syncLoadChanges(saved([far]), week())
      expect(changes.get(me()) ?? 0, JSON.stringify(patch)).toBe(delta)
      writes.at(-1)?.reject(new ConvexError({ code: 'forbidden', message: 'no' }))
      await turn()
    }
  })

  it('rounds the sum once, never each contribution', async () => {
    // three weeks of 1 hour: a third of an hour each week
    const rows = ['a', 'b', 'c'].map((id, i) =>
      row(id, i + 1, { start_week: iso(week()), end_week: iso(week() + 2), remaining_hours: 1 }),
    )
    answer = ok(rows, 0)
    await watch(await keyOf({ kind: 'all' }))
    for (const r of rows)
      void store.P.updateIssue(store.P.syncTask(r.id)?.id ?? '', { remaining: 2 })
    const delta = store.P.syncLoadChanges(saved(rows), week()).get(me()) ?? 0
    expect(roundTenths(0 + delta)).toBe(1)
    // rounding each third first would say 0.9, which must fail
    expect(roundTenths(delta)).not.toBe(roundTenths(3 * roundTenths(1 / 3)))
  })

  it('re-counts a held task’s pending edit from the workspace’s row, after an ask', async () => {
    const start = iso(week())
    snapshot.issues.push({
      ...row('held', 1, { start_week: start, end_week: start, remaining_hours: 3 }),
      description: '',
    } as unknown as Snapshot['issues'][number])
    const savedRow = row('held', 1, { start_week: start, end_week: start, remaining_hours: 3 })
    deliver(snapshot)
    await turn()
    answer = ok([savedRow], 3)
    await watch(await keyOf({ kind: 'all' }))
    store.P.askTasks('script')
    for (let i = 0; i < 10 && !store.P.tasksHeld(); i++) await turn()
    const handle = store.P.handleOf('held') ?? ''
    expect(handle).not.toBe('')
    void store.P.updateIssue(handle, { remaining: 5 })
    expect(store.P.syncLoadChanges(saved([savedRow]), week()).get(me())).toBe(2)
  })
})

describe("the view write path's Remaining and Pause", () => {
  it('writes Remaining and Pause on a task only the agenda brings, with the row on screen as expected values and the answer mark', async () => {
    answer = ok([row('far', 9, { remaining_hours: 4 })])
    await watch(await keyOf({ kind: 'all' }))
    const id = store.P.syncTask('far')?.id ?? ''
    expect(
      await Promise.race([store.P.updateIssue(id, { remaining: 6 }), turn().then(() => 'sent')]),
    ).toBe('sent')
    expect(writes.at(-1)).toMatchObject({
      name: 'issues:update',
      args: { id: 'far', patch: { remaining_hours: 6 }, expected: { remaining_hours: 4 } },
    })
    expect(store.P.syncTask('far')?.remaining).toBe(6)
    void store.P.updateIssue(id, { paused: true })
    expect(writes.at(-1)).toMatchObject({
      args: { id: 'far', patch: { paused: true }, expected: { paused: false } },
    })
    expect(store.P.syncTask('far')?.paused).toBe(true)
    // the guard saw both carry the answer mark, so neither faulted (afterEach)
  })

  it('paints a move into In Review with the review hours, and a refusal takes the paint away', async () => {
    answer = ok([row('far', 9, { status: 'progress', remaining_hours: 9 })])
    await watch(await keyOf({ kind: 'all' }))
    const id = store.P.syncTask('far')?.id ?? ''
    void store.P.updateIssue(id, { status: 'review' })
    expect(store.P.syncTask('far')).toMatchObject({ status: 'review', remaining: 2 })
    writes[0]?.reject(new ConvexError({ code: 'forbidden', message: 'no write access' }))
    await turn()
    expect(store.P.syncTask('far')).toMatchObject({ status: 'progress', remaining: 9 })
    expect(probe().layerCount()).toBe(0)
  })

  it("drops a Remaining on a group, and still refuses a field the views don't write", async () => {
    answer = ok([], 0, {
      parents: [
        {
          ...row('grp', 3),
          has_subtasks: true,
          group_done: false,
          span: { partial: false },
        },
      ],
    })
    await watch(await keyOf({ kind: 'all' }))
    const id = store.P.syncTask('grp')?.id ?? ''
    expect(await store.P.updateIssue(id, { remaining: 5 })).toBe(true)
    expect(writes).toHaveLength(0)
    const far = row('far', 9)
    await serve(ok([far]))
    const farId = store.P.syncTask('far')?.id ?? ''
    expect(await store.P.updateIssue(farId, { title: 'No' })).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it("posts a mention on a task only the agenda brings to that task's organization", async () => {
    answer = ok([row('far', 9)])
    await watch(await keyOf({ kind: 'all' }))
    void store.P.addComment('far', 'A note')
    expect(writes.at(-1)).toMatchObject({
      name: 'comments:create',
      args: { org_id: snapshot.orgs[0].id, issue_id: 'far' },
    })
  })
})
