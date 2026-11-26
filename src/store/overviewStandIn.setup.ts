/* A stand-in for the Overview's live queries the app calls
   (convex/overview.ts summary, health, needs and work) that answers from
   a workspace the app holds, for the jsdom Board fixture
   (src/views/boardFixture.setup.tsx), the app-level tests and the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/boardStandIn.setup.ts answers the Board.

   It applies the Overview's rules (convex/lib/overview.ts) to the
   workspace's tasks: the scope as the Board's stand-in selects it, the
   leaves by status and the paused leaves, whether the scope holds a task,
   Overdue on the client's day, and the health table's rows (a project's
   visible live sub-projects, or My view's top-level projects above the
   person's tasks) with their counts and delays by convex/lib/delay.ts
   against each owner's load as store/ownerLoadsStandIn.setup.ts gives it,
   at most one owner's load a query for a guest or an organization Viewer,
   searched, ordered by the server's total order (name keys by their bytes,
   convex/lib/nameKey.ts) with its name fallback and cut at `limit`, at
   most HEALTH_ROWS; My view's Your work from its stored facts alone
   (Overdue, No reviewer and Paused, no verdict kind or blocker); and a
   project's Needs attention list by the rule of convex/lib/overviewNeeds.ts
   readNeeds: every kind, Blocked by the workspace's blocks links, ranked
   as the server ranks them, its verdicts judged as readNeeds judges them,
   with no load read for an overdue task, which is Late whatever the load,
   and for a top-level project its Sub-projects, the health table sorted
   by Late from those verdicts, every row up to HEALTH_ROWS. It reads no
   access rule or read budget of its own, so a state the workspace cannot
   reach, such as `counting`, `budget` or `over_budget`, answers only when
   `force` asks for it. src/store/overviewParity.test.ts compares the
   summary, the health table and the Needs attention answer with the real
   queries. It imports nothing the benchmark's worker cannot load. */

import { ConvexError, compareValues, type Value } from 'convex/values'
import { type DelayInfo, type DelayIssue, delayOf } from '../../convex/lib/delay'
import { LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import type {
  Figure,
  HealthAnswer,
  HealthDelays,
  HealthRow,
  HealthSort,
  OverviewScope,
  SummaryAnswer,
} from '../../convex/lib/overview'
import type { NEEDS_KINDS, NeedsAnswer, NeedsKind } from '../../convex/lib/overviewNeeds'
import type { WorkAnswer } from '../../convex/lib/overviewWork'
import { taskOwnerId } from '../../convex/lib/review'
import { allWordsMatcher } from '../../convex/lib/search'
import type { WorkGroup } from '../../convex/lib/workGroups'
import {
  canonicalLoad,
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
} from '../../convex/lib/workload'
import type { LeafCounts } from '../../convex/model/overviewCounts'
import { groupProgress, isIssueDone } from '../lib/issueGroups'
import { spanOf } from './boardStandIn.setup'
import type { Whole } from './guard/liveDouble.setup'
import { OVERVIEW_BATCH, type OverviewQuery } from './overviewLists'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'

/** A state the stand-in answers whatever the tasks say: a scope refusal
    (`unavailable`, `access_unchecked`, `over_budget`), a figure that is not
    given (`counting`, the counts' `budget`, which takes the figures after
    them too, or Overdue's `budget`), the owners in `unknown` whose loads
    the health table and the Needs attention list cannot read; and for the
    health table alone its scope refusal, its counts or its judged rows'
    delays not given, or a lower cap (`most`). A top-level project's
    Sub-projects in its Needs attention answer take the counts and the cap,
    and of the delays `budget` alone, which the server answers where the
    list's verdicts did not fit, so the list's verdict counts read it too. */
export type ForcedOverview = {
  scope?: 'unavailable' | 'access_unchecked' | 'over_budget'
  counts?: 'counting' | 'budget'
  overdue?: 'budget'
  unknown?: readonly string[]
  /** Your work: past its budget, or with verdicts it could not read */
  work?: 'over_budget' | 'unknown'
  /** the Needs attention list: past its budget, or with no owner's load
      read, so that where a task it judges needs one its verdict counts,
      and the Sub-projects row of that task's sub-project, read unavailable
      for `loads` */
  needs?: 'over_budget' | 'unknown'
  health?: {
    scope?: 'unavailable' | 'access_unchecked' | 'over_budget'
    counts?: 'counting' | 'budget'
    delays?: 'budget' | 'loads'
    most?: number
  }
}

/** The most rows one health answer holds (convex/lib/overview.ts
    OVERVIEW.healthRows, pinned by store/overviewParity.test.ts). */
export const HEALTH_ROWS = 200

/** The sentence an `access_unchecked` answer carries. */
export const ACCESS_UNCHECKED_MESSAGE =
  'Qivo could not check all of your access in time. Try again in a moment.'

type Task = Whole['issues'][number]
type Project = Whole['projects'][number]

/** My view's top-level projects in `workspace`, by the rule of the
    health table's My view rows and of milestones.section's `mine` scope
    (convex/lib/overview.ts myViewProjects): each top-level project the
    person sees (a meta, not archived, and `sees`, true unless given) above
    an active task in a sub-project they see that one of their seats owns
    by the Reviewer rule (convex/lib/review.ts taskOwnerId), a group
    included, with those tasks, in the order the tasks come.
    store/milestoneStandIn.setup.ts answers a `mine` read with it. */
export function myViewProjects(
  workspace: Pick<Whole, 'myProfileIds' | 'projects' | 'issues'>,
  sees?: (projectId: string) => boolean,
): Map<string, Task[]> {
  const mine = new Set(workspace.myProfileIds)
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const seen = (id: string) => {
    const p = projectById.get(id)
    return p !== undefined && p.archived_at === undefined && (sees ? sees(id) : true)
  }
  const parents = new Set(
    workspace.issues.flatMap((t) => (t.parent_id === undefined ? [] : [t.parent_id])),
  )
  const isGroup = (t: Task) => parents.has(t.id)
  const byTop = new Map<string, Task[]>()
  for (const t of workspace.issues) {
    const p = projectById.get(t.project_id)
    if (p?.parent_id === undefined || !seen(p.id)) continue
    if (!mine.has(taskOwnerId(t, isGroup(t)) ?? '')) continue
    byTop.set(p.parent_id, [...(byTop.get(p.parent_id) ?? []), t])
  }
  const out = new Map<string, Task[]>()
  for (const [id, tasks] of byTop) {
    const top = projectById.get(id)
    if (top && top.type === 'meta' && top.parent_id === undefined && seen(top.id))
      out.set(id, tasks)
  }
  return out
}

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byCreation = (a: Project, b: Project) =>
  order(a.created_at ?? '', b.created_at ?? '') || order(a.id, b.id)

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/* The days since 1970-01-01 of YYYY-MM-DD `iso`. */
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/** The client's clock as convex/lib/viewLoads.ts clockOf places days and
    instants in its weeks, week 0 being the client's current week. */
function clockOf(a: { day: string; week: string; week_starts: number[]; week_end: number }) {
  const first = dayNumber(a.week)
  const starts = a.week_starts
  const last = starts.length - 1
  return {
    day: a.day,
    ofDay: (iso: string) => Math.floor((dayNumber(iso) - first) / 7),
    ofInstant: (instant: string) => {
      const ms = Date.parse(instant)
      if (ms >= a.week_end) return 1 + Math.floor((ms - a.week_end) / WEEK_MS)
      if (ms >= (starts[last] as number)) return 0
      if (ms < (starts[0] as number))
        return -last - Math.ceil(((starts[0] as number) - ms) / WEEK_MS)
      let lo = 0
      let hi = last
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if ((starts[mid] as number) <= ms) lo = mid
        else hi = mid
      }
      return lo - last
    },
    firstDay: (week: number) => new Date((first + 7 * week) * DAY_MS).toISOString().slice(0, 10),
  }
}

/** The arguments the Overview's queries take (convex/overview.ts). */
export type OverviewArgs = {
  /** none for Your work, which is My view's */
  scope?: OverviewScope
  day?: string
  week?: string
  week_starts?: number[]
  week_end?: number
  cursor?: string
  end?: string
  sort?: HealthSort
  dir?: 'asc' | 'desc'
  search?: string
  limit?: number
  /** the Needs attention list's kind, `all` for every kind */
  kind?: string
  /** Your work's limit of each group */
  progress?: number
  review?: number
  next?: number
  open_only?: boolean
}

/* The Needs attention list's kinds in the order a task takes the first of
   them, a copy that the type keeps equal to the server's, as importing it
   would load the server's code into the benchmark's worker. */
const NEEDS_ORDER: typeof NEEDS_KINDS = [
  'overdue',
  'projected',
  'behind',
  'blocked',
  'no_reviewer',
  'paused',
]

/* The columns whose order needs every row's counts. */
const COUNT_SORTS: readonly HealthSort[] = ['progress', 'done', 'left', 'paused']

/** What the Overview query `query` answers `args` to the person whose
    workspace is `workspace`; `sees` tells whether they see a project, by
    default every live one the workspace holds, and `force` answers states
    the workspace cannot reach. Throws bad_request for arguments the server
    refuses. */
export function overviewStandIn(
  workspace: Whole,
  query: OverviewQuery,
  args: OverviewArgs,
  { sees, force = {} }: { sees?: (projectId: string) => boolean; force?: ForcedOverview } = {},
): SummaryAnswer | HealthAnswer | NeedsAnswer | WorkAnswer {
  const mine = new Set(workspace.myProfileIds)
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const profileById = new Map(workspace.profiles.map((p) => [p.id, p]))
  const seen = (id: string) => {
    const p = projectById.get(id)
    return p !== undefined && p.archived_at === undefined && (sees ? sees(id) : true)
  }
  // the Needs attention list names a project scope by its ids alone
  const scope: OverviewScope =
    args.scope === undefined
      ? { kind: 'mine' }
      : query === 'needs' && !('kind' in args.scope)
        ? { kind: 'project', ...(args.scope as { org_id: string; project_id: string }) }
        : args.scope

  // the selection's sub-projects, in creation order, or null for none
  let subProjects: Project[] | null = null
  if (scope.kind === 'project') {
    const seats = new Set(
      workspace.profiles.filter((p) => mine.has(p.id)).map((p) => p.org_id as string),
    )
    const project = projectById.get(scope.project_id)
    if (!seats.has(scope.org_id) || !project || project.org_id !== scope.org_id)
      return { state: 'unavailable' }
    if (project.parent_id !== undefined) {
      if (!seen(project.id)) return { state: 'unavailable' }
      subProjects = [project]
    } else if (project.type === 'meta' && project.archived_at === undefined)
      subProjects = workspace.projects
        .filter((p) => p.parent_id === project.id && p.org_id === project.org_id && seen(p.id))
        .sort(byCreation)
    else return { state: 'unavailable' }
  }
  if (force.scope === 'unavailable') return { state: 'unavailable' }
  if (force.scope === 'access_unchecked')
    return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
  if (force.scope === 'over_budget') return { state: 'over_budget' }

  // the workspace's tasks, their subtasks and what makes a task a group
  const byId = new Map(workspace.issues.map((t) => [t.id, t]))
  const children = new Map<string, string[]>()
  for (const t of workspace.issues)
    if (t.parent_id !== undefined && byId.has(t.parent_id))
      children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t.id])
  const isGroup = (t: Task) => (children.get(t.id)?.length ?? 0) > 0
  const groupView = Object.fromEntries(
    workspace.issues.map((t) => [
      t.id,
      {
        id: t.id,
        status: t.status,
        children: children.get(t.id) ?? [],
      },
    ]),
  )
  const done = (t: Task) => isIssueDone(groupView[t.id], groupView)
  const owner = (t: Task) => taskOwnerId(t, isGroup(t))
  const inSubProject = (t: Task) => {
    const p = projectById.get(t.project_id)
    return p !== undefined && p.parent_id !== undefined && seen(p.id)
  }
  const ids = new Set(subProjects?.map((p) => p.id))
  // the scope's active tasks, groups included
  const scoped = workspace.issues.filter((t) =>
    scope.kind === 'project' ? ids.has(t.project_id) : inSubProject(t) && mine.has(owner(t) ?? ''),
  )

  if (query === 'summary') {
    const day = args.day as string
    const leaves = { backlog: 0, todo: 0, progress: 0, review: 0, done: 0 }
    let paused = 0
    // the remaining hours of the leaves not Done, in whole tenths, each
    // task's rounded as model/overviewCounts.ts stores it
    let left_tenths = 0
    for (const t of scoped)
      if (!isGroup(t)) {
        leaves[t.status]++
        if (t.paused) paused++
        if (t.status !== 'done') left_tenths += Math.round((t.remaining_hours ?? 0) * 10)
      }
    const budget = force.counts === 'budget'
    const unavailable = { state: 'unavailable' as const, reason: 'budget' as const }
    return {
      state: 'ok',
      counts: budget
        ? unavailable
        : force.counts === 'counting'
          ? { state: 'unavailable', reason: 'counting' }
          : { state: 'ok', leaves, paused, left_tenths },
      any_task: budget ? unavailable : { state: 'ok', value: scoped.length > 0 },
      overdue:
        budget || force.overdue === 'budget'
          ? unavailable
          : {
              state: 'ok',
              count: scoped.filter((t) => !done(t) && t.due_date !== undefined && t.due_date < day)
                .length,
            },
      ...(subProjects === null ? {} : { sub_projects: subProjects.map((p) => p.id) }),
    }
  }

  const tracks = (t: Task) => projectById.get(t.project_id)?.track_delay === true
  const clock = clockOf(
    args as { day: string; week: string; week_starts: number[]; week_end: number },
  )
  // the reader's seat of each organization, and whether it reads one
  // owner's load a query (a guest or an organization Viewer)
  const seatIn = (org: string) => workspace.profiles.find((p) => p.org_id === org && mine.has(p.id))
  const onePerQuery = (org: string) => {
    const role = seatIn(org)?.org_role
    return role !== 'admin' && role !== 'user'
  }
  const capacityOf = (t: Task, id: string | undefined) => {
    const p = id === undefined ? undefined : profileById.get(id)
    return p !== undefined && p.org_id === t.org_id
      ? plannableHoursOf({ plannableHours: p.plannable_hours, kind: p.kind })
      : DEFAULT_PLANNABLE_HOURS
  }
  /* The owner whose load `t`'s verdict needs, or null (convex/lib/viewLoads.ts
     verdicts needs). */
  const needs = (t: Task): string | null => {
    if (isGroup(t) || t.status === 'done') return null
    if (t.end_week === undefined && t.due_date === undefined) return null
    if (!((t.remaining_hours ?? 0) > 0)) return null
    const id = taskOwnerId(t, false)
    if (id === undefined || !profileById.has(id)) return null
    const capacity = capacityOf(t, id)
    return Number.isFinite(capacity) && capacity > 0 ? id : null
  }
  const loads = new Map<string, LoadSpan[]>()
  /* Owner `id`'s load in organization `org`, on the client's weeks. */
  const loadOf = (org: string, id: string): LoadSpan[] => {
    const known = loads.get(id)
    if (known) return known
    const answer = ownerLoadsStandIn(workspace, { org_id: org, owner_ids: [id] })
    const first = answer.owners[0]
    const c = clock as NonNullable<typeof clock>
    const spans =
      first?.state === 'ok'
        ? canonicalLoad(
            first.spans.map((s) => ({
              issueUuid: s.issue_id,
              start: c.ofDay(s.start_week),
              end: c.ofDay(s.end_week),
              remaining: s.remaining,
              remainingSet: s.remaining_set_at === null ? null : c.ofInstant(s.remaining_set_at),
            })),
          )
        : []
    loads.set(id, spans)
    return spans
  }
  /* `t`'s verdict against `load`, as the server judges it. */
  const verdictOf = (t: Task, load: LoadSpan[]) => {
    const c = clock as NonNullable<typeof clock>
    const group = isGroup(t)
    const week = (day: string | undefined) => (day ? c.ofDay(day) : null)
    let start: number | null
    let end: number | null
    let partial = false
    if (group) {
      const span = spanOf(t, children, byId)
      start = week(span.start_week)
      end = week(span.end_week)
      partial = groupProgress(groupView[t.id], groupView).unknown
    } else {
      start = week(t.start_week)
      const planned = week(t.end_week)
      end = planned === null ? null : Math.max(start ?? planned, planned)
    }
    const ownerId = owner(t)
    const it: DelayIssue = {
      uuid: t.id,
      status: t.status,
      isGroup: group,
      isDone: done(t),
      partial,
      paused: !group && t.paused === true,
      owner: ownerId ?? null,
      start,
      end,
      dueWeek: week(t.due_date),
      duePast: t.due_date !== undefined && t.due_date < c.day,
      remaining: t.remaining_hours,
      remainingSet: t.remaining_set_at ? c.ofInstant(t.remaining_set_at) : null,
      capacity: capacityOf(t, ownerId),
    }
    return delayOf(it, load, 0)
  }
  const unknownOwners = new Set(force.unknown ?? [])
  // the owners whose loads the verdicts of `tasks` read, in owner id order
  // by organization, none past the first that could not be read, and one a
  // query for a guest or Viewer (convex/lib/viewLoads.ts verdicts readAll)
  const readableOwners = (tasks: readonly Task[]) => {
    const readable = new Set<string>()
    for (const org of [...new Set(tasks.map((t) => t.org_id))].sort()) {
      const owners = [
        ...new Set(tasks.filter((t) => t.org_id === org).flatMap((t) => needs(t) ?? [])),
      ].sort()
      for (const [i, id] of owners.entries()) {
        if (unknownOwners.has(id) || (onePerQuery(org) && i > 0)) break
        readable.add(id)
      }
    }
    return readable
  }
  const judge = (t: Task, readable: ReadonlySet<string>) => {
    const id = needs(t)
    if (id !== null && !readable.has(id)) return 'unknown' as const
    return verdictOf(t, id === null ? [] : loadOf(t.org_id, id))
  }

  // the health table's rows: a project's sub-projects, or My view's
  // top-level projects above the person's tasks, each with its tasks in the
  // scope
  type Item = { project: Project; key: string; lead: string | null; tasks: Task[] }
  const item = (project: Project, lead: string | null, tasks: Task[]): Item => ({
    project,
    key: nameKey(project.name),
    lead,
    tasks,
  })
  const subProjectItems = (subs: readonly Project[]) =>
    subs.map((p) =>
      item(
        p,
        p.lead_id ??
          (p.parent_id === undefined ? undefined : projectById.get(p.parent_id)?.lead_id) ??
          null,
        scoped.filter((t) => t.project_id === p.id),
      ),
    )
  // the counts: the leaves by status, the paused leaves and Left in tenths
  const countsOf = (r: Item): LeafCounts => {
    const c: LeafCounts = {
      leaves: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0 },
      paused: 0,
      left_tenths: 0,
    }
    for (const t of r.tasks)
      if (!isGroup(t)) {
        c.leaves[t.status]++
        if (t.paused) c.paused++
        if (t.status !== 'done') c.left_tenths += Math.round((t.remaining_hours ?? 0) * 10)
      }
    return c
  }
  type Table = Extract<HealthAnswer, { state: 'ok' }>
  /* The health table of `items` as convex/lib/overview.ts healthTable
     answers it, `uncounted` saying why their counts are not given and
     `delaysOf` giving the delays of the rows the order judges. */
  const healthTable = (
    items: readonly Item[],
    ask: {
      sort: HealthSort
      dir: 'asc' | 'desc'
      limit: number
      most: number
      uncounted?: 'counting' | 'budget'
    },
    delaysOf: (judged: readonly Item[]) => Figure<{ of: Map<string, HealthDelays> }>,
  ): Table => {
    const { sort, dir, limit, most, uncounted } = ask
    // each lead's name, a lead of another organization or none being none
    const leadName = (r: Item) => {
      const p = r.lead === null ? undefined : profileById.get(r.lead)
      return p !== undefined && p.org_id === r.project.org_id ? nameKey(p.name) : undefined
    }
    let delays = new Map<string, HealthDelays>()
    const columnOf = (r: Item, key: HealthSort): Value => {
      const c = uncounted === undefined ? countsOf(r) : null
      const all = c === null ? 0 : Object.values(c.leaves).reduce((n, x) => n + x, 0)
      const d = delays.get(r.project.id)
      switch (key) {
        case 'name':
          return r.key
        case 'lead': {
          const name = leadName(r)
          return name === undefined ? [1] : [0, name]
        }
        case 'progress':
          return c !== null && all > 0 ? Math.round((c.leaves.done / all) * 100) : 0
        case 'done':
          return c !== null && all > 0 ? c.leaves.done / all : 0
        case 'left':
          return c?.left_tenths ?? 0
        case 'paused':
          return c?.paused ?? 0
        case 'late':
          return d?.state === 'ok' ? d.late : 0
        case 'behind':
          return d?.state === 'ok' ? d.behind : 0
      }
    }
    let order: Table['sort'] =
      COUNT_SORTS.includes(sort) && uncounted !== undefined
        ? { key: 'name', dir: 'asc', by_name: 'counts', missing: uncounted }
        : { key: sort, dir }
    const ordered = () =>
      [...items].sort((a, b) => {
        const d = compareValues(columnOf(a, order.key), columnOf(b, order.key))
        const asked = order.dir === 'asc' ? d : -d
        if (asked !== 0) return asked
        const byName = order.key === 'name' ? 0 : compareValues(a.key, b.key)
        return byName !== 0 ? byName : compareValues(a.project.id, b.project.id)
      })
    const byDelays = sort === 'late' || sort === 'behind'
    let rows = byDelays ? items : ordered()
    const judged = byDelays ? items : rows.slice(0, limit)
    const read = delaysOf(judged)
    delays =
      read.state === 'ok'
        ? read.of
        : new Map(
            judged.map((r): [string, HealthDelays] => [
              r.project.id,
              { state: 'unavailable', reason: read.reason },
            ]),
          )
    if (byDelays) {
      if (judged.some((r) => delays.get(r.project.id)?.state !== 'ok'))
        order = {
          key: 'name',
          dir: 'asc',
          by_name: 'delays',
          missing: read.state === 'ok' ? 'loads' : read.reason,
        }
      rows = ordered()
    }
    return {
      state: 'ok',
      rows: rows.slice(0, limit).map(
        (r): HealthRow => ({
          project_id: r.project.id,
          name: r.project.name,
          lead_id: r.lead,
          counts:
            uncounted === undefined
              ? { state: 'ok', ...countsOf(r) }
              : { state: 'unavailable', reason: uncounted },
          delays: delays.get(r.project.id) ?? { state: 'unavailable', reason: 'budget' },
        }),
      ),
      total: items.length,
      sort: order,
      most,
    }
  }

  if (query === 'health') {
    const h = force.health ?? {}
    if (h.scope === 'unavailable') return { state: 'unavailable' }
    if (h.scope === 'access_unchecked')
      return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
    if (h.scope === 'over_budget') return { state: 'over_budget' }
    // a lowered cap cuts the rows there, as the page's first ask of 10 rows
    // stays one the server takes
    const most = Math.min(h.most ?? HEALTH_ROWS, HEALTH_ROWS)
    const { sort = 'late', dir = 'desc', limit: asked = OVERVIEW_BATCH } = args
    if (!Number.isInteger(asked) || asked < 1 || asked > HEALTH_ROWS)
      throw new ConvexError({
        code: 'bad_request',
        message: `limit must be a whole number from 1 to ${HEALTH_ROWS}`,
      })
    const limit = Math.min(asked, most)
    const text = (args.search ?? '').trim()
    if (text.length > LIMITS.search.max)
      throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
    const matches = allWordsMatcher(nameKey(text))
    let items =
      subProjects !== null
        ? subProjectItems(subProjects)
        : [...myViewProjects(workspace, sees)].flatMap(([id, tasks]) => {
            const top = projectById.get(id)
            return top ? [item(top, top.lead_id ?? null, tasks)] : []
          })
    items = items.filter((r) => matches(r.key))
    if (args.open_only === true && h.counts !== undefined)
      return {
        state: 'ok',
        rows: [],
        total: 0,
        sort: { key: sort, dir },
        most,
        uncounted: h.counts,
      }
    if (args.open_only === true)
      items = items.filter((r) => {
        const c = countsOf(r)
        return c.leaves.backlog + c.leaves.todo + c.leaves.progress + c.leaves.review > 0
      })
    return healthTable(items, { sort, dir, limit, most, uncounted: h.counts }, (judged) => {
      if (h.delays !== undefined) return { state: 'unavailable', reason: h.delays }
      const readable = readableOwners(judged.flatMap((r) => r.tasks.filter(tracks)))
      const rowDelays = (r: Item): HealthDelays => {
        let late = 0
        let behind = 0
        for (const t of r.tasks.filter(tracks)) {
          const verdict = judge(t, readable)
          if (verdict === 'unknown') return { state: 'unavailable', reason: 'loads' }
          if (verdict?.status === 'late') late++
          else if (verdict?.status === 'behind') behind++
        }
        return { state: 'ok', late, behind }
      }
      return { state: 'ok', of: new Map(judged.map((r) => [r.project.id, rowDelays(r)])) }
    })
  }

  // ---- the Needs attention list (convex/lib/overviewNeeds.ts readNeeds)
  if (query === 'needs') {
    if (scope.kind !== 'project') return { state: 'unavailable' }
    if (force.needs === 'over_budget') return { state: 'over_budget' }
    const day = args.day as string
    const overdue = (t: Task) => t.due_date !== undefined && t.due_date < day
    const open = scoped.filter((t) => !done(t))
    // the verdicts of the open tasks in sub-projects that track delay and
    // are not overdue: a passed due date is Late whatever the load, so no
    // load is read for it
    const judged = open.filter((t) => tracks(t) && !overdue(t))
    const verdicts = new Map<string, DelayInfo>()
    const unknownIn = new Set<string>()
    let missing: 'budget' | 'loads' | null = force.health?.delays === 'budget' ? 'budget' : null
    if (missing === null) {
      const readable = readableOwners(judged)
      for (const t of judged) {
        const verdict =
          force.needs === 'unknown' && needs(t) !== null ? 'unknown' : judge(t, readable)
        if (verdict === 'unknown') {
          missing = 'loads'
          unknownIn.add(t.project_id)
        } else if (verdict !== null) verdicts.set(t.id, verdict)
      }
    }
    const focus = new Set<string>(['todo', 'progress', 'review'])
    const rows = open.filter((t) => !isGroup(t) && focus.has(t.status))
    const rowIds = new Set(rows.map((t) => t.id))
    const blockersOf = new Map<string, Task[]>()
    for (const link of workspace.links
      .filter((l) => l.type === 'blocks' && rowIds.has(l.target_id))
      .sort((a, b) => order(a.created_at, b.created_at) || order(a.id, b.id))) {
      const b = byId.get(link.source_id)
      if (b === undefined || b.org_id !== scope.org_id || done(b)) continue
      blockersOf.set(link.target_id, [...(blockersOf.get(link.target_id) ?? []), b])
    }
    const plannedEnd = (t: Task) => {
      if (isGroup(t)) {
        const end = spanOf(t, children, byId).end_week
        return end ? clock.ofDay(end) : null
      }
      if (t.end_week === undefined) return null
      const end = clock.ofDay(t.end_week)
      return t.start_week === undefined ? end : Math.max(clock.ofDay(t.start_week), end)
    }
    type Listed = {
      task: Task
      kinds: NeedsKind[]
      weeks: number
      fin?: number | null
      blockers: Task[]
    }
    const list: Listed[] = []
    const lateDue = new Map<string, number>()
    const lateIn = new Map<string, number>()
    const behindIn = new Map<string, number>()
    const add = (to: Map<string, number>, key: string) => to.set(key, (to.get(key) ?? 0) + 1)
    for (const t of open) {
      const leaf = !isGroup(t)
      const kinds: NeedsKind[] = []
      let weeks = 0
      let fin: number | null | undefined
      const verdict = verdicts.get(t.id)
      if (overdue(t)) {
        kinds.push('overdue')
        if (tracks(t)) {
          add(lateDue, t.due_date as string)
          add(lateIn, t.project_id)
        }
      } else if (verdict?.status === 'late') {
        kinds.push('projected')
        fin = verdict.fin
        weeks =
          verdict.fin === null || t.due_date === undefined
            ? 0
            : verdict.fin - clock.ofDay(t.due_date)
        if (t.due_date !== undefined) add(lateDue, t.due_date)
        add(lateIn, t.project_id)
      } else if (verdict?.status === 'behind') {
        kinds.push('behind')
        fin = verdict.fin
        const end = plannedEnd(t)
        weeks = verdict.fin === null || end === null ? 0 : verdict.fin - end
        add(behindIn, t.project_id)
      }
      const blockers = leaf && focus.has(t.status) ? (blockersOf.get(t.id) ?? []) : []
      if (blockers.length > 0) kinds.push('blocked')
      if (leaf && t.status === 'review' && t.reviewer_id === undefined) kinds.push('no_reviewer')
      if (leaf && t.paused === true) kinds.push('paused')
      if (kinds.length > 0) list.push({ task: t, kinds, weeks, fin, blockers })
    }
    // the list's order (convex/lib/overviewNeeds.ts byNeed)
    const rank = (n: Listed) => NEEDS_ORDER.indexOf(n.kinds[0] as NeedsKind)
    list.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      const due = order(a.task.due_date ?? '\uffff', b.task.due_date ?? '\uffff')
      const d =
        a.kinds[0] === 'projected'
          ? b.weeks - a.weeks || due
          : a.kinds[0] === 'behind'
            ? b.weeks - a.weeks
            : a.kinds[0] === 'no_reviewer'
              ? order(a.task.review_at ?? '\uffff', b.task.review_at ?? '\uffff')
              : due
      return d || a.task.num - b.task.num || order(a.task.id, b.task.id)
    })
    const blocks = new Map<string, Task[]>()
    for (const n of list)
      for (const b of n.blockers) blocks.set(b.id, [...(blocks.get(b.id) ?? []), n.task])
    const filter = args.kind as string
    const kept =
      filter === 'all' ? list : list.filter((n) => (n.kinds as string[]).includes(filter))
    const count = (kind: NeedsKind) => list.filter((n) => n.kinds.includes(kind)).length
    const verdictCount = (count: number) =>
      missing === null
        ? { state: 'ok' as const, count }
        : { state: 'unavailable' as const, reason: missing }
    const people = new Map<string, number>()
    for (const t of rows) {
      const id = taskOwnerId(t, false)
      if (id !== undefined && !people.has(id)) people.set(id, 0)
    }
    for (const n of list) {
      const id = owner(n.task)
      if (id !== undefined) people.set(id, (people.get(id) ?? 0) + 1)
    }
    const shownIds = new Set(workspace.issues.map((t) => t.id))
    const most = Math.min(force.health?.most ?? HEALTH_ROWS, HEALTH_ROWS)
    const subs = subProjects ?? []
    const health =
      projectById.get(scope.project_id)?.parent_id === undefined
        ? healthTable(
            subProjectItems(subs),
            { sort: 'late', dir: 'desc', limit: most, most, uncounted: force.health?.counts },
            () =>
              missing === 'budget'
                ? { state: 'unavailable', reason: 'budget' }
                : {
                    state: 'ok',
                    of: new Map(
                      subs.map((p): [string, HealthDelays] => [
                        p.id,
                        unknownIn.has(p.id)
                          ? { state: 'unavailable', reason: 'loads' }
                          : {
                              state: 'ok',
                              late: lateIn.get(p.id) ?? 0,
                              behind: behindIn.get(p.id) ?? 0,
                            },
                      ]),
                    ),
                  },
          )
        : null
    return {
      ...(health === null ? {} : { health }),
      state: 'ok',
      rows: kept.slice(0, args.limit as number).map(({ task: t, kinds, fin, blockers }) => {
        const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
        const blocked = blocks.get(t.id) ?? []
        const [first] = blocked
        return {
          ...rest,
          ...(parent !== undefined && shownIds.has(parent) ? { parent_id: parent } : {}),
          has_subtasks: isGroup(t),
          needs: {
            kind: kinds[0] as NeedsKind,
            also: kinds.slice(1),
            blocked_by: blockers.length,
            blocks:
              first === undefined
                ? null
                : { count: blocked.length, first: { id: first.id, title: first.title } },
            ...(fin === undefined
              ? {}
              : { finish_week: fin === null ? null : clock.firstDay(fin) }),
          },
        }
      }),
      total: kept.length,
      most: 1000,
      counts: {
        overdue: count('overdue'),
        blocked: count('blocked'),
        no_reviewer: count('no_reviewer'),
        paused: count('paused'),
        projected: verdictCount(count('projected')),
        behind: verdictCount(count('behind')),
        all: verdictCount(list.length),
      },
      tracks_delay: (subProjects ?? []).some((p) => p.track_delay === true),
      people: [...people.entries()]
        .sort(([a], [b]) => order(a, b))
        .map(([id, n]) => ({ id, listed: n })),
      late_due:
        missing !== null
          ? { state: 'unavailable', reason: missing }
          : {
              state: 'ok',
              days: [...lateDue.entries()]
                .sort(([a], [b]) => order(a, b))
                .map(([due, count]) => ({ due, count })),
            },
    }
  }

  // ---- Your work (convex/lib/overviewWork.ts), from the stored facts
  // alone: Overdue, No reviewer and Paused. It judges no verdict and reads
  // no blocker; the server's own suite tests the whole rule
  const day = args.day as string
  const kindOrder = ['overdue', 'no_reviewer', 'paused'] as const
  const kindsOf = (t: Task) =>
    kindOrder.filter((k) =>
      k === 'overdue'
        ? t.due_date !== undefined && t.due_date < day
        : k === 'no_reviewer'
          ? t.status === 'review' && !t.reviewer_id
          : t.paused,
    )
  const groupOf = (t: Task): WorkGroup | null =>
    t.status === 'progress'
      ? 'progress'
      : t.status === 'todo'
        ? 'next'
        : t.status === 'review'
          ? t.reviewer_id !== undefined && mine.has(t.reviewer_id)
            ? 'review'
            : 'progress'
          : null
  if (force.work === 'over_budget') return { state: 'over_budget' }
  const unknown = force.work === 'unknown'
  const work = scoped.filter((t) => !isGroup(t) && groupOf(t) !== null)
  const rank = (t: Task) => {
    const k = kindsOf(t)[0]
    return k === undefined ? kindOrder.length : kindOrder.indexOf(k)
  }
  const byUrgency = (a: Task, b: Task) => {
    const due = order(a.due_date ?? '\uffff', b.due_date ?? '\uffff')
    const waited = order(a.review_at ?? '\uffff', b.review_at ?? '\uffff')
    const k = kindsOf(a)[0]
    return (
      rank(a) - rank(b) ||
      (k === 'no_reviewer' || (k === undefined && groupOf(a) === 'review') ? waited : due) ||
      a.num - b.num
    )
  }
  const byStart = (a: Task, b: Task) =>
    order(a.start_week ?? '\uffff', b.start_week ?? '\uffff') ||
    order(a.due_date ?? '\uffff', b.due_date ?? '\uffff') ||
    a.num - b.num
  const shownIds = new Set(workspace.issues.map((t) => t.id))
  const rowOf = (t: Task) => {
    const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
    const kinds = kindsOf(t)
    const overdue = kinds[0] === 'overdue'
    const parentRow = parent === undefined ? undefined : byId.get(parent)
    return {
      ...rest,
      ...(parent !== undefined && shownIds.has(parent) ? { parent_id: parent } : {}),
      has_subtasks: false,
      needs: {
        kind: kinds[0] ?? null,
        also: kinds.slice(1),
        blocked_by: 0,
        ...(unknown && tracks(t) && !overdue ? { delay_unknown: true as const } : {}),
      },
      ...(parentRow ? { parent_title: parentRow.title } : {}),
    }
  }
  const groupRows = (group: WorkGroup) => {
    const rows = work
      .filter((t) => groupOf(t) === group)
      .sort(group === 'next' ? byStart : byUrgency)
    return { rows: rows.slice(0, args[group] as number).map(rowOf), total: rows.length }
  }
  // every project above a task of the person's that tracks delay, Done
  // ones included, by the overdue ones of those not done for them; a
  // forced unknown makes a project unknown where one is due and not overdue
  const late = new Map<string, Map<string, number> | 'loads'>()
  for (const t of scoped) {
    const top = projectById.get(t.project_id)?.parent_id
    if (top === undefined || !tracks(t)) continue
    const days = late.get(top) ?? new Map<string, number>()
    late.set(top, days)
    if (days === 'loads' || t.due_date === undefined || done(t)) continue
    if (t.due_date < day) days.set(t.due_date, (days.get(t.due_date) ?? 0) + 1)
    else if (unknown) late.set(top, 'loads')
  }
  const count = (k: (typeof kindOrder)[number]) => work.filter((t) => kindsOf(t).includes(k)).length
  const verdict = (n: number) =>
    unknown
      ? { state: 'unavailable' as const, reason: 'loads' as const }
      : { state: 'ok' as const, count: n }
  return {
    state: 'ok',
    groups: {
      progress: groupRows('progress'),
      review: groupRows('review'),
      next: groupRows('next'),
    },
    most: 1000,
    counts: {
      overdue: count('overdue'),
      blocked: 0,
      no_reviewer: count('no_reviewer'),
      paused: count('paused'),
      projected: verdict(0),
      behind: verdict(0),
    },
    late_due: [...late.entries()]
      .sort(([a], [b]) => order(a, b))
      .map(([project_id, days]) => ({
        project_id,
        late:
          days === 'loads'
            ? { state: 'unavailable', reason: 'loads' }
            : {
                state: 'ok',
                days: [...days.entries()]
                  .sort(([a], [b]) => order(a, b))
                  .map(([due, n]) => ({ due, count: n })),
              },
      })),
  }
}

/** Answers a test double's subscription to `name`, one of the Overview's
    queries as Convex names it (`overview:summary` and so on), with `args`
    over `workspace` through `next`, or through `fail` where the stand-in
    refuses, as the app-level tests' network doubles answer the Board's. */
export function answerOverview(
  workspace: Whole,
  name: string,
  args: unknown,
  next: (value: unknown) => void,
  fail?: (error: unknown) => void,
  options?: { sees?: (projectId: string) => boolean; force?: ForcedOverview },
) {
  let answer: unknown
  try {
    answer = overviewStandIn(
      workspace,
      name.slice('overview:'.length) as OverviewQuery,
      args as OverviewArgs,
      options,
    )
  } catch (error) {
    fail?.(error)
    return
  }
  next(structuredClone(answer))
}
