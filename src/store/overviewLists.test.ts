import { describe, expect, it } from 'vitest'
import {
  createOverviewReads,
  type HealthTable,
  OVERVIEW_BATCH,
  OVERVIEW_WEEKS,
  type OverviewBase,
  type OverviewQuery,
  type OverviewTransport,
  WORK_FIRST,
  WORK_STEP,
} from './overviewLists'
import { type ForcedOverview, type OverviewArgs, overviewStandIn } from './overviewStandIn.setup'
import { plannerFixture, type Snapshot, underProgram } from './plannerFixture.setup'

/* The Overview's health table and Your work (store/overviewLists.ts) over
   a stand-in server: a fake transport that registers reads as the store's
   view reads do (store/planner.ts watchView) and answers each live read
   from the Overview's stand-in (store/overviewStandIn.setup.ts) over a
   workspace the test changes, when the test delivers, as
   ownerLoadCache.test.ts runs the owner-load cache. */

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
  ...over,
})

/** A workspace of one sub-project under a program, with the tasks
    `tasks()` makes, numbered from 1. */
function workspace(tasks: () => Partial<Task>[] = () => []): Snapshot {
  const snap = underProgram(plannerFixture())
  for (const [i, t] of tasks().entries()) snap.issues.push(taskOf(snap, i + 1, t))
  return snap
}

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
    watch(slot, query, key, attempt, hold) {
      let read = reads.get(slot)
      if (!read) {
        read = { query, want: null, attempt, held: null, current: false }
        reads.set(slot, read)
      }
      const retry = attempt !== read.attempt
      read.attempt = attempt
      if (key !== null && (retry || (read.held !== null && read.held.key !== key && !hold)))
        read.held = null
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
      reads take them in, until nothing new is asked; `each` runs after
      every round. */
  const deliver = (each: () => void = () => {}) => {
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
      each()
      if (!any) return
    }
  }
  /** Everything changed on the server: every live read answers again. */
  const change = (each?: () => void) => {
    for (const read of reads.values()) read.current = false
    deliver(each)
  }
  return { state, reads, transport, lists: reads2, deliver, change }
}

const HEALTH = 'overview:health'

/** A table by name, ascending, with no search. */
const BY_NAME: HealthTable = { sort: 'name', dir: 'asc', search: '' }

/** A workspace of a program with `n` sub-projects, Sub 01 the fixture's
    own, each with one To do task, and the program's scope on DAY. */
function programOf(n: number) {
  const snap = workspace()
  const first = snap.projects[0]
  const program = snap.projects.find((p) => p.id === first.parent_id)
  if (!program) throw new Error('no program')
  first.name = 'Sub 01'
  for (let i = 2; i <= n; i++)
    snap.projects.push({
      ...first,
      id: `sub${i}`,
      key: `S${i}`,
      num: 100 + i,
      name: `Sub ${String(i).padStart(2, '0')}`,
    })
  for (const [i, p] of snap.projects.filter((x) => x.parent_id === program.id).entries())
    snap.issues.push(taskOf(snap, i + 1, { id: `task-${p.id}`, project_id: p.id }))
  const base: OverviewBase = {
    scope: { kind: 'project', org_id: snap.orgs[0].id, project_id: program.id },
    clock: clock(),
  }
  return { snap, base }
}

/** The health read's arguments now, or null for none. */
const healthArgs = (s: ReturnType<typeof server>) => {
  const want = s.reads.get(HEALTH)?.want ?? null
  return want === null ? null : (JSON.parse(want) as Record<string, unknown>)
}

/** The names of the rows the health table shows. */
const healthNames = (s: ReturnType<typeof server>) => {
  const value = s.lists.view().health?.value
  return value?.state === 'ok' ? value.rows.map((r) => r.name) : []
}

describe('the health table', () => {
  it('asks only with a table and while asking, its arguments in one key order', () => {
    const { snap, base } = programOf(3)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    expect(healthArgs(s)).toBeNull()
    expect(s.lists.view().health).toBeNull()
    s.lists.watchTable(BY_NAME, 1)
    expect(Object.keys(healthArgs(s) ?? {})).toEqual([
      'scope',
      'day',
      'week',
      'week_starts',
      'week_end',
      'sort',
      'dir',
      'limit',
    ])
    expect(healthArgs(s)).toMatchObject({ sort: 'name', dir: 'asc', limit: OVERVIEW_BATCH })
    s.lists.watchTable({ ...BY_NAME, search: 'sub' }, 1)
    expect(Object.keys(healthArgs(s) ?? {})).toEqual([
      'scope',
      'day',
      'week',
      'week_starts',
      'week_end',
      'sort',
      'dir',
      'search',
      'limit',
    ])
    s.deliver()
    expect(healthNames(s)).toEqual(['Sub 01', 'Sub 02', 'Sub 03'])
    // a page that is not the one asking changes nothing
    s.lists.watchTable({ ...BY_NAME, sort: 'late' }, 2)
    expect(healthArgs(s)).toMatchObject({ sort: 'name', search: 'sub' })
    // hidden: no read, and the answer stays
    s.lists.watch(null, 1, 0)
    expect(healthArgs(s)).toBeNull()
    expect(s.lists.view().health).toMatchObject({ current: false, kept: false })
    // no table, as for one sub-project: no read, nothing shown
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(null, 1)
    expect(healthArgs(s)).toBeNull()
    expect(s.lists.view().health).toBeNull()
  })

  it('asks the health read alone for a new sort, search or Load more, keeping the rows shown as kept until the new answer', () => {
    const { snap, base } = programOf(25)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ current: true, kept: false, more: 'ready' })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
    const asked = s.state.asked.length
    s.state.holding = (slot) => slot === HEALTH
    s.lists.watchTable({ ...BY_NAME, dir: 'desc' }, 1)
    expect(s.state.asked.slice(asked).map((a) => a.slot)).toEqual([HEALTH])
    // the rows of the order before stay, marked kept
    expect(s.lists.view().health).toMatchObject({ kept: true, current: false })
    expect(healthNames(s)[0]).toBe('Sub 01')
    s.state.holding = () => false
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ kept: false, current: true })
    expect(healthNames(s)[0]).toBe('Sub 25')
    // Load more: the rows stay until 20 answer
    s.state.holding = (slot) => slot === HEALTH
    s.lists.moreHealth()
    expect(healthArgs(s)).toMatchObject({ limit: 2 * OVERVIEW_BATCH })
    expect(s.lists.view().health).toMatchObject({ kept: true, more: 'loading' })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
    s.state.holding = () => false
    s.deliver()
    expect(healthNames(s)).toHaveLength(2 * OVERVIEW_BATCH)
    s.lists.moreHealth()
    s.deliver()
    expect(healthNames(s)).toHaveLength(25)
    expect(s.lists.view().health?.more).toBeNull()
    // a new search starts again at the first rows: every word anywhere,
    // so Sub 21 holds a 1 too
    s.lists.watchTable({ ...BY_NAME, dir: 'desc', search: 'sub 1' }, 1)
    expect(healthArgs(s)).toMatchObject({ search: 'sub 1', limit: OVERVIEW_BATCH })
    s.deliver()
    expect(healthNames(s)).toEqual([
      'Sub 21',
      'Sub 19',
      'Sub 18',
      'Sub 17',
      'Sub 16',
      'Sub 15',
      'Sub 14',
      'Sub 13',
      'Sub 12',
      'Sub 11',
    ])
    expect(s.lists.view().health?.value).toMatchObject({ total: 12 })
    // nothing but the health read was asked again
    expect(s.state.asked.slice(asked).every((a) => a.slot === HEALTH)).toBe(true)
  })

  it('shows nothing for a new scope or day until its answer; a new day keeps the rows asked, a new scope starts at the first', () => {
    const { snap, base } = programOf(25)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    s.lists.moreHealth()
    s.deliver()
    s.state.holding = (slot) => slot === HEALTH
    s.lists.watch({ ...base, clock: clock('2026-11-05') }, 1, 0)
    expect(s.lists.view().health).toBeNull()
    expect(healthArgs(s)).toMatchObject({ day: '2026-11-05', limit: 2 * OVERVIEW_BATCH })
    s.state.holding = () => false
    s.deliver()
    expect(healthNames(s)).toHaveLength(2 * OVERVIEW_BATCH)
    s.state.holding = (slot) => slot === HEALTH
    s.lists.watch({ scope: { kind: 'mine' }, clock: clock('2026-11-05') }, 1, 0)
    expect(s.lists.view().health).toBeNull()
    // until the page registers the new scope's table
    expect(healthArgs(s)).toBeNull()
    s.lists.watchTable(BY_NAME, 1)
    expect(healthArgs(s)).toMatchObject({ scope: { kind: 'mine' }, limit: OVERVIEW_BATCH })
  })

  it('asks a new scope only with the table its page registers, never with the sort or search of the scope before', () => {
    const { snap, base } = programOf(3)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable({ sort: 'name', dir: 'asc', search: 'sub' }, 1)
    s.deliver()
    const asked = s.state.asked.length
    // App mounts a page anew for each scope, which registers the scope's
    // reads and then its own table in one commit: My view, then the
    // project again
    s.lists.watch({ ...base, scope: { kind: 'mine' } }, 2, 0)
    expect(healthArgs(s)).toBeNull()
    expect(s.lists.view().health).toBeNull()
    s.lists.watchTable({ sort: 'late', dir: 'desc', search: '' }, 2)
    s.lists.watch(base, 3, 0)
    expect(healthArgs(s)).toBeNull()
    s.lists.watchTable({ sort: 'progress', dir: 'desc', search: '' }, 3)
    const health = s.state.asked.slice(asked).filter((a) => a.slot === HEALTH)
    expect(health.map((a) => JSON.parse(a.key))).toEqual([
      expect.objectContaining({ scope: { kind: 'mine' }, sort: 'late', dir: 'desc' }),
      expect.objectContaining({ scope: base.scope, sort: 'progress', dir: 'desc' }),
    ])
    expect(health.every((a) => !('search' in JSON.parse(a.key)))).toBe(true)
  })

  it('takes a table only from the page that owns the reads, which a page that mounted hidden registers again once it asks', () => {
    const { snap, base } = programOf(3)
    const s = server(snap)
    // mounted while hidden, the page asks for nothing and owns no reads yet
    s.lists.watch(null, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.lists.watch(base, 1, 0)
    expect(healthArgs(s)).toBeNull()
    // the page registers its table again after the scope's reads
    s.lists.watchTable(BY_NAME, 1)
    expect(healthArgs(s)).toMatchObject({ sort: 'name', limit: OVERVIEW_BATCH })
  })

  it('asks the same arguments on return and shows them refreshing until they answer, also after a reconnect', () => {
    const { snap, base } = programOf(3)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    const want = s.reads.get(HEALTH)?.want
    s.lists.watch(null, 1, 0)
    expect(s.reads.get(HEALTH)?.want).toBeNull()
    s.lists.watch(base, 1, 0)
    expect(s.reads.get(HEALTH)?.want).toBe(want)
    expect(s.lists.view().health).toMatchObject({ current: false, kept: false })
    expect(healthNames(s)).toHaveLength(3)
    s.deliver()
    expect(s.lists.view().health?.current).toBe(true)
    const read = s.reads.get(HEALTH)
    if (read) read.current = false
    expect(s.lists.view().health?.current).toBe(false)
    s.deliver()
    expect(s.lists.view().health?.current).toBe(true)
  })

  it('asks afresh on Try again, and takes a failed Load more back to its rows, live, with Retry', () => {
    const { snap, base } = programOf(25)
    const s = server(snap)
    s.state.failing = (slot) => (slot === HEALTH ? new Error('down') : undefined)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ error: expect.any(Error), kept: false })
    s.state.failing = () => undefined
    const asked = s.state.asked.length
    s.lists.retryHealth()
    expect(s.state.asked.slice(asked).map((a) => a.slot)).toEqual([HEALTH])
    s.deliver()
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
    // the next 10 fail: back to the first 10, asked again so they stay live
    s.state.failing = (slot, args) =>
      slot === HEALTH && args.limit === 2 * OVERVIEW_BATCH ? new Error('down') : undefined
    s.lists.moreHealth()
    s.deliver()
    expect(healthArgs(s)).toMatchObject({ limit: OVERVIEW_BATCH })
    expect(s.lists.view().health).toMatchObject({
      moreFailed: true,
      more: null,
      current: true,
      kept: false,
    })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
    s.state.failing = () => undefined
    s.lists.retryHealth()
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ moreFailed: false, more: 'ready' })
    expect(healthNames(s)).toHaveLength(2 * OVERVIEW_BATCH)
  })

  it('offers no Load more on rows kept for another sort or search, so a press there asks nothing', () => {
    const { snap, base } = programOf(25)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    expect(s.lists.view().health?.more).toBe('ready')
    s.state.holding = (slot) => slot === HEALTH
    const next: HealthTable[] = [
      { ...BY_NAME, dir: 'desc' },
      { ...BY_NAME, search: 'sub 1' },
    ]
    for (const table of next) {
      s.lists.watchTable(table, 1)
      expect(s.lists.view().health).toMatchObject({ kept: true, more: null })
      const asked = s.state.asked.length
      s.lists.moreHealth()
      expect(s.state.asked.length).toBe(asked)
      expect(healthArgs(s)).toMatchObject({ limit: OVERVIEW_BATCH })
    }
    // the answer for the table asked now offers it again
    s.state.holding = () => false
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ kept: false, more: 'ready' })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
  })

  it('shows the table’s error where the rows a failed Load more went back to fail too, and Try again asks those rows afresh', () => {
    const { snap, base } = programOf(25)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    // the next 10 fail, and the first 10 asked again are held back
    s.state.failing = (slot) => (slot === HEALTH ? new Error('down') : undefined)
    s.state.holding = (slot, args) => slot === HEALTH && args.limit === OVERVIEW_BATCH
    s.lists.moreHealth()
    s.deliver()
    expect(healthArgs(s)).toMatchObject({ limit: OVERVIEW_BATCH })
    expect(s.lists.view().health).toMatchObject({ moreFailed: true, kept: false })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
    // they fail too: the table's error from the first view, before the
    // module takes the news in
    const read = s.reads.get(HEALTH)
    if (!read?.want) throw new Error('no health read')
    read.held = { key: read.want, error: new Error('down') }
    read.current = true
    expect(s.lists.view().health).toMatchObject({ error: expect.any(Error), moreFailed: false })
    s.lists.settle()
    expect(s.lists.view().health).toMatchObject({
      error: expect.any(Error),
      moreFailed: false,
      more: null,
    })
    expect(s.lists.view().health?.value).toBeUndefined()
    // Try again asks the first rows afresh, not the Load more that failed
    s.state.failing = () => undefined
    s.state.holding = () => false
    const asked = s.state.asked.length
    s.lists.retryHealth()
    expect(s.state.asked.slice(asked).map((a) => JSON.parse(a.key).limit)).toEqual([OVERVIEW_BATCH])
    s.deliver()
    expect(s.lists.view().health).toMatchObject({ current: true, moreFailed: false, more: 'ready' })
    expect(healthNames(s)).toHaveLength(OVERVIEW_BATCH)
  })

  it('forgets the health read on release and clear', () => {
    const { snap, base } = programOf(3)
    const s = server(snap)
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    s.lists.release()
    expect(s.reads.has(HEALTH)).toBe(false)
    expect(s.lists.view().health).toBeNull()
    s.lists.watch(base, 1, 0)
    s.lists.watchTable(BY_NAME, 1)
    s.deliver()
    s.lists.clear()
    expect(s.lists.view().health).toBeNull()
  })
})

const WORK = 'overview:work'

/** My view over `todo` To Do tasks and `progress` In Progress ones of
    the person's, due a day apart, on DAY. */
function myWork(todo: number, progress: number) {
  const snap = workspace()
  const me = snap.myProfileIds[0]
  const due = (i: number) =>
    new Date(Date.parse('2026-11-10T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10)
  for (let i = 0; i < todo + progress; i++)
    snap.issues.push(
      taskOf(snap, i + 1, {
        assignee_id: me,
        status: i < todo ? 'todo' : 'progress',
        due_date: due(i),
      }),
    )
  const base: OverviewBase = { scope: { kind: 'mine' }, clock: clock() }
  return { snap, base }
}

/** Your work's arguments now, or null for none. */
const workArgs = (s: ReturnType<typeof server>) => {
  const want = s.reads.get(WORK)?.want ?? null
  return want === null ? null : (JSON.parse(want) as Record<string, unknown>)
}

/** How many rows each group of Your work shows. */
const workRows = (s: ReturnType<typeof server>) => {
  const value = s.lists.view().work?.value
  return value?.state === 'ok'
    ? {
        progress: value.groups.progress.rows.length,
        review: value.groups.review.rows.length,
        next: value.groups.next.rows.length,
      }
    : null
}

describe('Your work', () => {
  it("asks each group's first rows on My view's page alone, and a Load more raises one group, keeping the rows until they answer", () => {
    const { snap, base } = myWork(25, 3)
    const s = server(snap)
    s.lists.watch(base, 1, 0, 'mine')
    expect(workArgs(s)).toBeNull()
    s.lists.watchWork(true, 1)
    expect(workArgs(s)).toMatchObject({
      progress: WORK_FIRST,
      review: WORK_FIRST,
      next: WORK_FIRST,
    })
    s.deliver()
    expect(workRows(s)).toEqual({ progress: 3, review: 0, next: WORK_FIRST })
    expect(s.lists.view().work?.more).toEqual({ progress: null, review: null, next: 'ready' })
    // a press on a group with nothing more asks nothing
    const asked = s.state.asked.length
    s.lists.moreWork('progress')
    expect(s.state.asked.length).toBe(asked)
    s.state.holding = (slot) => slot === WORK
    s.lists.moreWork('next')
    expect(workArgs(s)).toMatchObject({ progress: WORK_FIRST, next: WORK_FIRST + WORK_STEP })
    expect(s.lists.view().work).toMatchObject({
      kept: true,
      more: { progress: null, review: null, next: 'loading' },
    })
    expect(workRows(s)).toEqual({ progress: 3, review: 0, next: WORK_FIRST })
    s.state.holding = () => false
    s.deliver()
    expect(workRows(s)).toEqual({ progress: 3, review: 0, next: WORK_FIRST + WORK_STEP })
    expect(s.lists.view().work).toMatchObject({ kept: false, current: true })
  })

  it('takes a failed Load more back to its rows, live, naming the group for Retry', () => {
    const { snap, base } = myWork(25, 0)
    const s = server(snap)
    s.lists.watch(base, 1, 0, 'mine')
    s.lists.watchWork(true, 1)
    s.deliver()
    s.state.failing = (slot, args) =>
      slot === WORK && args.next === WORK_FIRST + WORK_STEP ? new Error('down') : undefined
    s.lists.moreWork('next')
    s.deliver()
    expect(workArgs(s)).toMatchObject({ next: WORK_FIRST })
    expect(s.lists.view().work).toMatchObject({
      moreFailed: true,
      failedAt: { next: WORK_FIRST + WORK_STEP },
      current: true,
    })
    expect(workRows(s)).toEqual({ progress: 0, review: 0, next: WORK_FIRST })
    s.state.failing = () => undefined
    s.lists.retryWork()
    s.deliver()
    expect(workRows(s)).toEqual({ progress: 0, review: 0, next: WORK_FIRST + WORK_STEP })
    expect(s.lists.view().work).toMatchObject({ moreFailed: false, failedAt: null })
  })

  it("keeps another group's Load more while one group's failed, also once that group fits, and Retry keeps what the other loaded", async () => {
    const { snap, base } = myWork(20, 11)
    const s = server(snap)
    s.lists.watch(base, 1, 0, 'mine')
    s.lists.watchWork(true, 1)
    s.deliver()
    s.state.failing = (slot, args) =>
      slot === WORK && args.progress === WORK_FIRST + WORK_STEP ? new Error('down') : undefined
    s.lists.moreWork('progress')
    s.deliver()
    expect(s.lists.view().work).toMatchObject({
      failedAt: { progress: WORK_FIRST + WORK_STEP },
      more: { progress: null, review: null, next: 'ready' },
    })
    // In progress shrinks to its first rows: Next still loads more
    const started = snap.issues.find((t) => t.status === 'progress')
    if (started) started.status = 'done'
    s.change()
    expect(s.lists.view().work?.more.next).toBe('ready')
    s.lists.moreWork('next')
    s.deliver()
    expect(workRows(s)).toEqual({ progress: WORK_FIRST, review: 0, next: 20 })
    // the failed rows asked again keep Next's
    if (started) started.status = 'progress'
    s.state.failing = () => undefined
    s.lists.retryWork()
    s.deliver()
    expect(workRows(s)).toEqual({ progress: 11, review: 0, next: 20 })
  })
})
