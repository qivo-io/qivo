import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import type { ListAnswer, OverviewRow } from '../../convex/lib/overview'
import {
  createOverviewReads,
  LIST_READS,
  LIST_ROWS,
  type ListKind,
  type ListView,
  OVERVIEW_BATCH,
  OVERVIEW_SPLIT,
  OVERVIEW_WEEKS,
  type OverviewBase,
  type OverviewQuery,
  type OverviewTransport,
} from './overviewLists'
import { type ForcedOverview, type OverviewArgs, overviewStandIn } from './overviewStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* The Overview's lists (store/overviewLists.ts) over a stand-in server: a
   fake transport that registers reads as the store's view reads do
   (store/planner.ts watchView) and answers each live read from the
   Overview's stand-in (store/overviewStandIn.setup.ts) over a workspace the
   test changes, when the test delivers, as ownerLoadCache.test.ts runs the
   owner-load cache. */

const AT = '2026-09-14T08:00:00.000Z'
const DAY = '2026-11-04'
const WEEK = '2026-11-02'
const clock = (day = DAY, week = WEEK) => ({
  day,
  week,
  week_starts: Array.from(
    { length: OVERVIEW_WEEKS },
    (_, i) => Date.parse(`${week}T00:00:00.000Z`) - (OVERVIEW_WEEKS - 1 - i) * 7 * 86_400_000,
  ),
  week_end: Date.parse(`${week}T00:00:00.000Z`) + 7 * 86_400_000,
})

type Task = Snapshot['issues'][number]

/** Task number `num` of `snap`'s one sub-project, with `over`. */
const taskOf = (snap: Snapshot, num: number, over: Partial<Task> = {}): Task => ({
  id: `t${String(num).padStart(3, '0')}`,
  org_id: snap.orgs[0].id,
  project_id: snap.projects[0].id,
  num,
  title: `Task ${num}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  created_at: AT,
  updated_at: AT,
  paused: false,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
  ...over,
})

/** A workspace of one sub-project under a program, with the tasks
    `tasks()` makes, numbered from 1. */
function workspace(tasks: () => Partial<Task>[] = () => []): Snapshot {
  const snap = underProgram(plannerFixture())
  for (const [i, t] of tasks().entries()) snap.issues.push(taskOf(snap, i + 1, t))
  return snap
}

/** `n` paused tasks due a day apart from 1 November. */
const pausedTasks = (n: number) => () =>
  Array.from({ length: n }, (_, i) => ({
    paused: true,
    due_date: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
  }))

/** The fake server and transport. */
function server(snap: Snapshot) {
  type Read = {
    query: OverviewQuery
    want: string | null
    attempt: number
    held: { key: string; value?: unknown; error?: unknown } | null
    current: boolean
  }
  const reads = new Map<string, Read>()
  const state = {
    snap,
    force: {} as ForcedOverview,
    /** what each read answers whatever the tasks say, beside `force` */
    forceOf: (_slot: string, _args: OverviewArgs): ForcedOverview => ({}),
    /** reads whose answers wait, by a test's choice */
    holding: (_slot: string, _args: OverviewArgs) => false,
    /** reads that fail */
    failing: (_slot: string, _args: OverviewArgs): unknown => undefined,
    /** every subscription asked, newest last */
    asked: [] as { slot: string; key: string }[],
  }
  const transport: OverviewTransport = {
    watch(slot, query, key, attempt) {
      let read = reads.get(slot)
      if (!read) {
        read = { query, want: null, attempt, held: null, current: false }
        reads.set(slot, read)
      }
      const retry = attempt !== read.attempt
      read.attempt = attempt
      if (key !== null && (retry || (read.held !== null && read.held.key !== key))) read.held = null
      if (key === null || key !== read.want || retry) read.current = false
      if (key !== null && (key !== read.want || retry)) state.asked.push({ slot, key })
      read.want = key
      read.query = query
    },
    read(slot) {
      const read = reads.get(slot)
      const held = read?.held ?? null
      return {
        key: held?.key ?? null,
        ...(held && 'value' in held ? { value: held.value } : {}),
        ...(held && 'error' in held ? { error: held.error } : {}),
        current: !!read && read.current && read.want === held?.key,
      }
    },
    release(slot) {
      reads.delete(slot)
    },
  }
  const reads2 = createOverviewReads(transport)
  /** Answers every live read whose answer does not wait, and lets the
      lists take them in, until nothing new is asked. */
  const deliver = () => {
    for (let round = 0; round < 20; round++) {
      let any = false
      for (const [slot, read] of reads) {
        if (read.want === null) continue
        const args = JSON.parse(read.want) as OverviewArgs
        if (state.holding(slot, args)) continue
        if (read.held?.key === read.want && read.current) continue
        const fail = state.failing(slot, args)
        let held: Read['held']
        if (fail !== undefined) held = { key: read.want, error: fail }
        else
          try {
            held = {
              key: read.want,
              value: structuredClone(
                overviewStandIn(state.snap, read.query, args, {
                  force: { ...state.force, ...state.forceOf(slot, args) },
                }),
              ),
            }
          } catch (error) {
            held = { key: read.want, error }
          }
        read.held = held
        read.current = true
        any = true
      }
      reads2.settle()
      if (!any) return
    }
  }
  /** Everything changed on the server: every live read answers again. */
  const change = () => {
    for (const read of reads.values()) read.current = false
    deliver()
  }
  return { state, reads, transport, lists: reads2, deliver, change }
}

const BASE = (snap: Snapshot, day = DAY): OverviewBase => ({
  scope: { kind: 'project', org_id: snap.orgs[0].id, project_id: snap.projects[0].id },
  clock: clock(day),
})

/** The row ids list `kind` shows, batch by batch. */
const shown = (view: ListView) => view.batches.map((b) => b.rows.map((r: OverviewRow) => r.id))
/** The row ids list `kind` shows, in order. */
const ids = (view: ListView) => shown(view).flat()
/** The ids of the tasks the server's whole list holds, in order. */
function wholeIds(snap: Snapshot, kind: ListKind, base: OverviewBase): string[] {
  const out: string[] = []
  let cursor: string | undefined
  for (let n = 0; n < 50; n++) {
    const args = kind === 'paused' ? { scope: base.scope } : { scope: base.scope, ...base.clock }
    const got = overviewStandIn(snap, kind, {
      ...args,
      ...(cursor ? { cursor } : {}),
    }) as ListAnswer
    if (got.state !== 'ok') throw new Error(JSON.stringify(got))
    out.push(...got.rows.map((r) => r.id))
    if (got.next === null) return out
    cursor = got.next
  }
  throw new Error('no end')
}
/** The live reads of the lists. */
const liveLists = (s: ReturnType<typeof server>) =>
  [...s.reads].filter(([slot, r]) => r.want !== null && /attention|paused/.test(slot))

describe('the first batch and Load more', () => {
  it('shows the first batch, freezes it with its end on Load more and opens the next at its next, never blinking', () => {
    const snap = workspace(pausedTasks(25))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    expect(s.lists.view().paused.state).toBe('loading')
    s.deliver()
    let view = s.lists.view().paused
    expect(view.state).toBe('ok')
    expect(shown(view).map((b) => b.length)).toEqual([OVERVIEW_BATCH])
    expect(view.more).toBe('ready')
    const first = ids(view)
    // the frozen read and the next batch wait: the press's rows stay
    s.state.holding = () => true
    s.lists.more('paused')
    view = s.lists.view().paused
    expect(ids(view)).toEqual(first)
    expect(view.more).toBe('loading')
    const asked = s.state.asked.slice(-2).map((a) => JSON.parse(a.key))
    expect(asked[0].end).toBeDefined()
    expect(asked[0].cursor).toBeUndefined()
    expect(asked[1].cursor).toBe(asked[0].end)
    expect(asked[1].end).toBeUndefined()
    s.state.holding = () => false
    s.deliver()
    view = s.lists.view().paused
    expect(shown(view).map((b) => b.length)).toEqual([10, 10])
    expect(ids(view)).toEqual(wholeIds(snap, 'paused', BASE(snap)).slice(0, 20))
    s.lists.more('paused')
    s.deliver()
    view = s.lists.view().paused
    expect(ids(view)).toEqual(wholeIds(snap, 'paused', BASE(snap)))
    expect(view.end).toBe(true)
    expect(view.more).toBeNull()
  })

  it('keeps a row that moves into or out of a frozen batch once, with no gap', () => {
    const snap = workspace(pausedTasks(30))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    s.deliver()
    s.lists.more('paused')
    s.deliver()
    expect(ids(s.lists.view().paused)).toHaveLength(30)
    const tasks = snap.issues
    // the last task moves into the first batch: it shows there once, and
    // the first batch's last row stays where it was
    ;(tasks[29] as Task).due_date = '2026-10-01'
    s.change()
    let now = ids(s.lists.view().paused)
    expect(now).toEqual(wholeIds(snap, 'paused', BASE(snap)))
    expect(new Set(now).size).toBe(30)
    // the first task moves past the end: it leaves the first batch, and the
    // second batch's first row does not show twice
    ;(tasks[0] as Task).due_date = '2026-12-31'
    s.change()
    now = ids(s.lists.view().paused)
    expect(now).toEqual(wholeIds(snap, 'paused', BASE(snap)))
    expect(new Set(now).size).toBe(30)
  })
})

describe('splits and stops', () => {
  it('splits a frozen batch grown past the split into two halves, showing its rows until both answered', () => {
    const snap = workspace(pausedTasks(20))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    s.deliver()
    // 15 more inside the first batch's span
    for (let i = 0; i < 15; i++)
      snap.issues.push(taskOf(snap, 100 + i, { paused: true, due_date: '2026-11-02' }))
    // the halves wait: the first batch still shows its last rows
    const before = ids(s.lists.view().paused)
    const slots = new Set(s.reads.keys())
    s.state.holding = (slot) => !slots.has(slot)
    s.change()
    expect(ids(s.lists.view().paused)).toEqual(before)
    expect(s.lists.view().paused.state).not.toBe('loading')
    s.state.holding = () => false
    s.deliver()
    const after = s.lists.view().paused
    expect(ids(after)).toEqual(wholeIds(snap, 'paused', BASE(snap)).slice(0, ids(after).length))
    expect(new Set(ids(after)).size).toBe(ids(after).length)
    expect(after.batches.some((b) => b.rows.length > OVERVIEW_SPLIT)).toBe(false)
  })

  it('gives a frozen batch whose reads stopped two reads that meet where it stopped', () => {
    const snap = workspace(pausedTasks(20))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    s.deliver()
    const whole = ids(s.lists.view().paused)
    // the first frozen batch's reads stop after half a batch, and so do
    // those of the first half it gives way to, which ends before that
    s.state.forceOf = (_slot, args) =>
      args.end !== undefined && args.cursor === undefined ? { list: 'incomplete' } : {}
    s.change()
    const view = s.lists.view().paused
    expect(view.batches.length).toBeGreaterThan(2)
    expect(ids(view).slice(0, 20)).toEqual(whole)
    expect(new Set(ids(view)).size).toBe(ids(view).length)
  })

  it('shows an open batch that stopped with the note and Load more from where it stopped', () => {
    const snap = workspace(pausedTasks(20))
    const s = server(snap)
    s.state.force = { list: 'incomplete' }
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    const view = s.lists.view().paused
    expect(view.state).toBe('incomplete')
    expect(view.batches[0]?.note).toEqual({ kind: 'incomplete' })
    expect(view.more).toBe('ready')
    expect(view.end).toBe(false)
    s.lists.more('paused')
    s.deliver()
    expect(ids(s.lists.view().paused)).toEqual(wholeIds(snap, 'paused', BASE(snap)).slice(0, 10))
  })
})

describe('refusals and failures', () => {
  it('starts a list again once when a position is refused, and fails on a second refusal', () => {
    const snap = workspace(pausedTasks(25))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    // the server's secret rotated: every position is refused
    const refuse = (_slot: string, args: OverviewArgs) =>
      args.cursor !== undefined || args.end !== undefined
        ? new ConvexError({ code: 'bad_request', message: 'cursor must be a position' })
        : undefined
    s.state.failing = refuse
    s.deliver()
    let view = s.lists.view().paused
    // started again from its first batch, which needs no position
    expect(view.failed).toBe(false)
    expect(view.batches).toHaveLength(1)
    expect(ids(view)).toEqual(wholeIds(snap, 'paused', BASE(snap)).slice(0, 10))
    s.lists.more('paused')
    s.deliver()
    view = s.lists.view().paused
    expect(view.failed).toBe(true)
    expect(view.state).toBe('error')
  })

  it('answers over_budget in place, never as an end, and keeps the place of a failed Load more for Retry', () => {
    const snap = workspace(pausedTasks(25))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.state.failing = (_slot, args) =>
      args.cursor !== undefined ? new Error('network') : undefined
    s.lists.more('paused')
    s.deliver()
    let view = s.lists.view().paused
    expect(view.batches).toHaveLength(2)
    expect(view.batches[1]?.note).toEqual({ kind: 'error' })
    expect(view.end).toBe(false)
    expect(view.state).toBe('error')
    s.state.failing = () => undefined
    s.lists.retry('paused', view.batches[1]?.id as number)
    s.deliver()
    view = s.lists.view().paused
    expect(ids(view)).toEqual(wholeIds(snap, 'paused', BASE(snap)).slice(0, 20))
    // a batch whose budget could not judge one candidate
    s.state.force = { list: 'over_budget' }
    s.lists.more('paused')
    s.deliver()
    view = s.lists.view().paused
    expect(view.batches.at(-1)?.note).toEqual({ kind: 'over_budget' })
    expect(view.end).toBe(false)
    expect(view.state).toBe('over_budget')
  })
})

describe('days, scopes and visibility', () => {
  it('starts At risk again on a new day and keeps Paused; a new scope starts both', () => {
    const snap = workspace(() =>
      Array.from({ length: 15 }, (_, i) => ({ paused: true, due_date: `2026-10-${10 + i}` })),
    )
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    s.lists.more('attention')
    s.deliver()
    const paused = s.lists.view().paused.batches.map((b) => b.id)
    const attention = s.lists.view().attention.batches.map((b) => b.id)
    expect(attention.length).toBe(2)
    s.lists.watch(BASE(snap, '2026-11-05'), 1, 0)
    s.deliver()
    expect(s.lists.view().paused.batches.map((b) => b.id)).toEqual(paused)
    expect(s.lists.view().attention.batches.map((b) => b.id)).not.toEqual(attention)
    expect(s.lists.view().attention.batches).toHaveLength(1)
    // another scope: both lists start again, and no read of the old scope
    // stays live
    const other: OverviewBase = { scope: { kind: 'mine' }, clock: clock('2026-11-05') }
    s.lists.watch(other, 1, 0)
    s.deliver()
    for (const [, read] of liveLists(s))
      expect(JSON.parse(read.want as string).scope).toEqual({ kind: 'mine' })
    expect(s.lists.view().paused.batches.map((b) => b.id)).not.toEqual(paused)
  })

  it('holds no read while hidden, asks the same arguments on return and shows them refreshing until they answer', () => {
    const snap = workspace(pausedTasks(15))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    s.lists.more('paused')
    s.deliver()
    const wanted = new Map([...s.reads].map(([slot, r]) => [slot, r.want]))
    s.lists.watch(null, 1, 0)
    expect([...s.reads.values()].every((r) => r.want === null)).toBe(true)
    // a page that left after another one asked stops nothing
    s.lists.watch(BASE(snap), 2, 0)
    s.lists.watch(null, 1, 0)
    expect([...s.reads.values()].some((r) => r.want !== null)).toBe(true)
    s.lists.watch(null, 2, 0)
    s.lists.watch(BASE(snap), 2, 0)
    expect(new Map([...s.reads].map(([slot, r]) => [slot, r.want]))).toEqual(wanted)
    expect(s.lists.view().paused.state).toBe('refreshing')
    expect(s.lists.view().summary?.current).toBe(false)
    s.deliver()
    expect(s.lists.view().paused.state).toBe('ok')
    // after a reconnect every answer arrives again before it is current
    for (const read of s.reads.values()) read.current = false
    expect(s.lists.view().paused.state).toBe('refreshing')
    s.deliver()
    expect(s.lists.view().paused.state).toBe('ok')
  })
})

describe('the retained cap', () => {
  it(`keeps at most ${LIST_ROWS} rows and ${LIST_READS} reads a list, drops its first batches past them and shows from the start again`, () => {
    const snap = workspace(pausedTasks(90))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    const all = wholeIds(snap, 'paused', BASE(snap))
    let reached = 0
    for (let press = 0; press < 8; press++) {
      s.lists.more('paused')
      s.deliver()
      const view = s.lists.view().paused
      expect(ids(view).length).toBeLessThanOrEqual(LIST_ROWS)
      expect(view.reads).toBeLessThanOrEqual(LIST_READS)
      // what shows is one stretch of the whole list, in its order
      const at = all.indexOf(ids(view)[0] as string)
      expect(ids(view)).toEqual(all.slice(at, at + ids(view).length))
      reached = at + ids(view).length
    }
    const view = s.lists.view().paused
    expect(view.dropped).toBe(true)
    expect(reached).toBe(all.length)
    expect(view.end).toBe(true)
    s.lists.fromStart('paused')
    s.deliver()
    expect(s.lists.view().paused.dropped).toBe(false)
    expect(ids(s.lists.view().paused)).toEqual(all.slice(0, OVERVIEW_BATCH))
  })

  it('caps a list whose frozen batch split, within its reads', () => {
    const snap = workspace(pausedTasks(40))
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    for (let press = 0; press < 3; press++) {
      s.lists.more('paused')
      s.deliver()
    }
    for (let i = 0; i < 15; i++)
      snap.issues.push(taskOf(snap, 200 + i, { paused: true, due_date: '2026-11-02' }))
    s.change()
    const view = s.lists.view().paused
    expect(view.reads).toBeLessThanOrEqual(LIST_READS)
    expect(ids(view).length).toBeLessThanOrEqual(LIST_ROWS)
    const all = wholeIds(snap, 'paused', BASE(snap))
    const at = all.indexOf(ids(view)[0] as string)
    expect(ids(view)).toEqual(all.slice(at, at + ids(view).length))
  })
})

describe("a guest's At-risk list", () => {
  it('stops at each change of owner, reads one owner a batch, and reaches the end within the cap', () => {
    const snap = workspace()
    const org = snap.orgs[0].id
    const sub = snap.projects[0]
    sub.track_delay = true
    snap.profiles[0].org_role = 'guest'
    const owners = ['a', 'b'].map((k) => ({
      ...snap.profiles[0],
      id: `owner-${k}`,
      auth_user_id: `auth-${k}`,
      name: `Owner ${k}`,
      org_role: 'user' as const,
      plannable_hours: 10,
    }))
    snap.profiles.push(...owners)
    // projected late, owners A, B, A, B in due-date order
    for (let i = 0; i < 8; i++)
      snap.issues.push({
        ...taskOf(snap, i + 1),
        org_id: org,
        project_id: sub.id,
        assignee_id: owners[i % 2]?.id,
        start_week: WEEK,
        end_week: WEEK,
        due_date: `2026-11-${10 + i}`,
        remaining_hours: 100,
        remaining_set_at: '2026-11-03T12:00:00.000Z',
      })
    const s = server(snap)
    s.lists.watch(BASE(snap), 1, 0)
    s.deliver()
    let presses = 0
    while (s.lists.view().attention.more === 'ready' && presses < 20) {
      s.lists.more('attention')
      s.deliver()
      presses++
    }
    const view = s.lists.view().attention
    expect(view.end).toBe(true)
    // one row a batch, as each next candidate needs the other owner's load
    expect(presses).toBe(7)
    expect(view.batches.every((b) => b.rows.length === 1)).toBe(true)
    // one-row batches do not merge, so the reads bind before the rows: the
    // list keeps its last LIST_READS rows and says earlier ones are not shown
    expect(view.reads).toBeLessThanOrEqual(LIST_READS)
    expect(view.dropped).toBe(true)
    expect(ids(view)).toEqual(wholeIds(snap, 'attention', BASE(snap)).slice(-ids(view).length))
  })
})
