import { describe, expect, it } from 'vitest'
import type { ViewRow } from '../../convex/lib/viewReads'
import { TODAY_WEEK, weekToISO } from '../lib/dates'
import { DELAY_UNKNOWN } from '../lib/delay'
import type { LoadSpan } from '../lib/workload'
import type { OwnerLoad } from './ownerLoadCache'
import {
  viewDelay as judge,
  type OwnerItem,
  type OwnerItemsCtx,
  ownerItemsOf,
  type ViewDelayCtx,
  viewLoadOf,
} from './viewDelay'

/** The verdict's status, null or DELAY_UNKNOWN. */
const viewDelay = (...args: Parameters<typeof judge>) => {
  const verdict = judge(...args)
  return verdict === null || verdict === DELAY_UNKNOWN ? verdict : verdict.status
}

/* The delay of a task only a view's answer brings (store/viewDelay.ts):
   its owner's load is the cache's spans with the spans of the tasks the
   person's rows hold taken from those rows, so a pending edit counts once,
   and a load the cache does not have is never read as free time. */

const week = (offset: number) => weekToISO(TODAY_WEEK + offset)

/** A leaf row of organization `org`, owned by `owner`, planned this week
    and next with `hours` left, due in two weeks. */
const row = (id: string, owner: string, over: Partial<ViewRow> = {}): ViewRow => ({
  id,
  org_id: 'org',
  project_id: 'work',
  num: 1,
  title: id,
  status: 'progress',
  priority: 'medium',
  paused: false,
  assignee_id: owner,
  start_week: week(0),
  end_week: week(1),
  due_date: week(2),
  remaining_hours: 10,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  has_subtasks: false,
  has_hidden_subtasks: false,
  has_hidden_parent: false,
  ...over,
})

/** A span of `hours` this week and next. */
const span = (issueUuid: string | null, hours: number): LoadSpan => ({
  issueUuid,
  start: TODAY_WEEK,
  end: TODAY_WEEK + 1,
  remaining: hours,
  remainingSet: null,
})

/** A store with `views` rows the workspace does not hold, `heldSpans` of
    each owner's tasks it does hold, and the cache's `loads`. */
function ctx(
  views: ViewRow[],
  loads: Record<string, OwnerLoad>,
  held: Record<string, LoadSpan[]> = {},
): ViewDelayCtx {
  const heldIds = new Set(
    Object.values(held)
      .flat()
      .map((s) => s.issueUuid),
  )
  return {
    load: (_org, owner) => loads[owner] ?? { state: 'waiting' },
    held: (uuid) => heldIds.has(uuid),
    inView: (uuid) => views.some((r) => r.id === uuid),
    heldSpans: (owner) => held[owner] ?? [],
    viewRows: () => views,
    capacity: () => 40,
    projectLive: () => true,
    orgOf: () => 'org',
  }
}

const ok = (spans: LoadSpan[]): OwnerLoad => ({ state: 'ok', spans, hidden: 'counted' })

describe("a view task's owner load", () => {
  it('counts a task the rows hold once, from its row, and keeps hidden work', () => {
    // the server's load of Ana: task t (10 h, before an edit), task h held by
    // the workspace (3 h on the server, 5 h painted) and hidden work
    const t = row('t', 'ana', { remaining_hours: 12 })
    const load = ok([span('t', 10), span('h', 3), span(null, 7)])
    const spans = viewLoadOf('org', 'ana', load as Extract<OwnerLoad, { state: 'ok' }>, {
      ...ctx([t], { ana: load }, { ana: [span('h', 5)] }),
    })
    // t once, at its row's 12 h; h once, at the workspace's 5 h; hidden 7 h
    const byTask = spans.map((s) => [s.issueUuid, s.remaining])
    expect(byTask.filter(([id]) => id === 't')).toEqual([['t', 12]])
    expect(byTask.filter(([id]) => id === 'h')).toEqual([['h', 5]])
    expect(byTask.filter(([id]) => id === null)).toEqual([[null, 7]])
    expect(spans).toHaveLength(3)
  })

  it("takes a task given to another owner out of the first owner's load", () => {
    // the server still files t under Ana; a pending owner change gave it to Bo
    const t = row('t', 'bo')
    const ana = ok([span('t', 10), span(null, 2)]) as Extract<OwnerLoad, { state: 'ok' }>
    const bo = ok([]) as Extract<OwnerLoad, { state: 'ok' }>
    const c = ctx([t], { ana, bo })
    expect(viewLoadOf('org', 'ana', ana, c).map((s) => s.issueUuid)).toEqual([null])
    expect(viewLoadOf('org', 'bo', bo, c).map((s) => s.issueUuid)).toEqual(['t'])
  })
})

describe("a view task's delay", () => {
  it('waits without a mark for the first answer, and says unknown for a load it cannot read', () => {
    const t = row('t', 'ana')
    expect(viewDelay(t, ctx([t], {}))).toBeNull()
    for (const state of ['unavailable', 'failed', 'capped'] as const)
      expect(viewDelay(t, ctx([t], { ana: { state } }))).toBe(DELAY_UNKNOWN)
  })

  it('judges against the load: on track when it fits, late when other work fills the weeks', () => {
    const t = row('t', 'ana')
    expect(viewDelay(t, ctx([t], { ana: ok([]) }))).toBe('ok')
    // 120 h of hidden work over these two weeks leaves no room before the due date
    const busy = ok([
      {
        issueUuid: null,
        start: TODAY_WEEK,
        end: TODAY_WEEK + 3,
        remaining: 160,
        remainingSet: null,
      },
    ])
    expect(viewDelay(t, ctx([t], { ana: busy }))).toBe('late')
  })

  it('needs no load where nothing depends on it: no hours, Done, or a passed due date', () => {
    const none = row('t', 'ana', { remaining_hours: undefined, end_week: undefined })
    expect(viewDelay(none, ctx([none], { ana: { state: 'unavailable' } }))).toBeNull()
    const done = row('d', 'ana', { status: 'done' })
    expect(viewDelay(done, ctx([done], { ana: { state: 'unavailable' } }))).toBeNull()
    // a passed due date is late, with or without the load
    const past = row('p', 'ana', { due_date: week(-1) })
    expect(viewDelay(past, ctx([past], { ana: { state: 'unavailable' } }))).toBe('late')
    expect(viewDelay(past, ctx([past], { ana: ok([]) }))).toBe('late')
  })

  it("judges a group by its facts' span, with no one's load", () => {
    const group = row('g', 'ana', {
      has_subtasks: true,
      group_done: false,
      span: { start_week: week(0), end_week: week(4), partial: false },
      due_date: week(2),
    })
    expect(viewDelay(group, ctx([group], {}))).toBe('late')
    const done = { ...group, group_done: true }
    expect(viewDelay(done, ctx([done], {}))).toBeNull()
  })
})

describe("a person's work for Team utilization and the planning panel", () => {
  /** Ana's cache answer with `spans`, each span's project, and `paused`. */
  const teamLoad = (
    spans: LoadSpan[],
    projects: (string | null)[],
    paused: { issueUuid: string; project: string; start: number; end: number }[] = [],
  ) =>
    ({ state: 'ok', spans, hidden: 'counted', team: { projects, paused } }) as Extract<
      OwnerLoad,
      { state: 'ok' }
    >
  /** The reconciler's store: `views` rows the workspace does not hold, and
      the workspace's own `held` items of each owner. */
  const itemsCtx = (views: ViewRow[], held: Record<string, OwnerItem[]> = {}): OwnerItemsCtx => {
    const heldIds = new Set(
      Object.values(held)
        .flat()
        .map((item) => item.uuid),
    )
    return {
      held: (uuid) => heldIds.has(uuid),
      inView: (uuid) => views.some((r) => r.id === uuid),
      viewRows: () => views,
      projectLive: () => true,
      orgOf: () => 'org',
      heldItems: (owner) => held[owner] ?? [],
    }
  }
  const byTask = (items: OwnerItem[]) =>
    items.map((item) => [item.uuid, item.project, item.remaining, item.paused])

  it('counts a task once whichever list holds it, from its row, its project and pause with it', () => {
    // the server's load of Ana: t in work (10 h before an edit), h held by
    // the workspace, busy time she is not shown, and a paused task p
    const t = row('t', 'ana', { remaining_hours: 12 })
    const load = teamLoad(
      [span('t', 10), span('h', 3), span(null, 7)],
      ['work', 'pcb', null],
      [{ issueUuid: 'p', project: 'fw', start: TODAY_WEEK, end: TODAY_WEEK }],
    )
    const held: OwnerItem = {
      uuid: 'h',
      project: 'pcb',
      start: TODAY_WEEK,
      end: TODAY_WEEK + 1,
      remaining: 5,
      remainingSet: null,
      paused: false,
    }
    const items = ownerItemsOf('org', 'ana', load, itemsCtx([t], { ana: [held] }))
    const order = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : 1)
    expect(byTask(items).sort(order)).toEqual(
      [
        [null, null, 7, false],
        ['p', 'fw', 0, true],
        ['h', 'pcb', 5, false],
        ['t', 'work', 12, false],
      ].sort(order),
    )
    // a version that also kept the server's spans of shown tasks counts
    // them twice
    expect(items.filter((item) => item.uuid === 't')).toHaveLength(1)
    expect(items.filter((item) => item.uuid === 'h')).toHaveLength(1)
  })

  it('moves a task between owners at once, and takes a shown task’s own pause over the server’s', () => {
    // a pending owner change gave t to Bo; the server still files it under Ana
    const t = row('t', 'bo')
    const ana = teamLoad([span('t', 10)], ['work'])
    const bo = teamLoad([], [])
    expect(byTask(ownerItemsOf('org', 'ana', ana, itemsCtx([t])))).toEqual([])
    expect(byTask(ownerItemsOf('org', 'bo', bo, itemsCtx([t])))).toEqual([['t', 'work', 10, false]])
    // the server says p is paused; the person resumed it
    const p = row('p', 'ana', { remaining_hours: 4 })
    const paused = teamLoad(
      [],
      [],
      [{ issueUuid: 'p', project: 'work', start: TODAY_WEEK, end: TODAY_WEEK + 1 }],
    )
    expect(byTask(ownerItemsOf('org', 'ana', paused, itemsCtx([p])))).toEqual([
      ['p', 'work', 4, false],
    ])
    // and the other way: a pause painted on a row the server still loads
    const nowPaused = row('p', 'ana', { paused: true })
    const loaded = teamLoad([span('p', 10)], ['work'])
    expect(byTask(ownerItemsOf('org', 'ana', loaded, itemsCtx([nowPaused])))).toEqual([
      ['p', 'work', 0, true],
    ])
  })

  it('answers nothing for an answer from a backend that sent no projects or paused list', () => {
    const load = ok([span('t', 10)]) as Extract<OwnerLoad, { state: 'ok' }>
    expect(ownerItemsOf('org', 'ana', load, itemsCtx([]))).toEqual([])
  })
})
