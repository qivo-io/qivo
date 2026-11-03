/* A stand-in for the Overview's five live queries (convex/overview.ts
   summary, risk, attention, paused and health) that answers from a
   workspace the app holds, for the jsdom Board fixture
   (src/views/boardFixture.setup.tsx), the app-level tests and the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/boardStandIn.setup.ts answers the Board.

   It applies the Overview's rules (convex/lib/overview.ts) to the
   workspace's tasks: the scope as the Board's stand-in selects it, the
   leaves by status and the paused leaves, whether the scope holds a task,
   Overdue on the client's day, the projected-late count by convex/lib/
   delay.ts against each owner's load as store/ownerLoadsStandIn.setup.ts
   gives it, at most one owner's load a query for a guest or an
   organization Viewer, and the two lists in the server's order (due date,
   undated last, then the task number, organization and id, where the
   server ties by creation time), in batches of OVERVIEW_BATCH with the
   server's `complete`, `next`, `end` and `split`, and fixed ends, and the
   health table's rows (a project's visible live sub-projects, or My view's
   top-level projects above the person's tasks) with their counts and
   delays, searched, ordered by the server's total order (name keys by
   their bytes, convex/lib/nameKey.ts) with its name fallback and cut at
   `limit`, at most HEALTH_ROWS. Its positions are plain text with each
   list's prefix, refused with bad_request under another list, scope,
   reader or clock. It reads no access rule or read budget of its own, so a
   state the workspace cannot reach, such as `counting`, `budget`,
   `over_budget` or a stopped batch, answers only when `force` asks for
   it. src/store/overviewParity.test.ts
   compares it with the real queries. It imports nothing the benchmark's
   worker cannot load. */

import { ConvexError, compareValues, type Value } from 'convex/values'
import { type DelayIssue, delayOf } from '../../convex/lib/delay'
import { LIMITS } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import type {
  Figure,
  HealthAnswer,
  HealthRow,
  HealthSort,
  ListAnswer,
  OverviewRow,
  OverviewScope,
  RiskAnswer,
  SummaryAnswer,
} from '../../convex/lib/overview'
import { taskOwnerId } from '../../convex/lib/review'
import { allWordsMatcher } from '../../convex/lib/search'
import type { ViewRow } from '../../convex/lib/viewReads'
import {
  canonicalLoad,
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
} from '../../convex/lib/workload'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import type { LeafCounts } from '../../convex/model/overviewCounts'
import { groupProgress, isIssueDone } from '../lib/issueGroups'
import { spanOf } from './boardStandIn.setup'
import { OVERVIEW_BATCH, OVERVIEW_SPLIT, type OverviewQuery } from './overviewLists'
import { ownerLoadsStandIn } from './ownerLoadsStandIn.setup'

/** A state the stand-in answers whatever the tasks say: a scope refusal
    (`unavailable`, `access_unchecked`, `over_budget`), a figure that is not
    given (`counting`, the counts' `budget`, which takes the figures after
    them too, Overdue's `budget`, the projection's `budget`, or `loads`), a
    list batch that stops after half a batch (`incomplete`), a list batch
    that answers `over_budget`, or the owners in `unknown` whose loads no
    batch can read; and for the health table alone its scope refusal, its
    counts or its judged rows' delays not given, or a lower cap (`most`). */
export type ForcedOverview = {
  scope?: 'unavailable' | 'access_unchecked' | 'over_budget'
  counts?: 'counting' | 'budget'
  overdue?: 'budget'
  projected?: 'budget' | 'loads'
  list?: 'incomplete' | 'over_budget'
  unknown?: readonly string[]
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

type Task = Workspace['issues'][number]
type Project = Workspace['projects'][number]

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byCreation = (a: Project, b: Project) =>
  order(a.created_at ?? '', b.created_at ?? '') || order(a.id, b.id)

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/* The days since 1970-01-01 of YYYY-MM-DD `iso`. */
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/** The client's clock as convex/lib/overview.ts clockOf places days and
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
  scope: OverviewScope
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
}

/* The columns whose order needs every row's counts. */
const COUNT_SORTS: readonly HealthSort[] = ['progress', 'done', 'left', 'paused']

/* Where a row sorts: dated before undated, then by due date, then the task
   number, organization and id. */
type Pos = [undated: 0 | 1, due: string, num: number, org: string, id: string]
const posOf = (t: Task): Pos => [
  t.due_date === undefined ? 1 : 0,
  t.due_date ?? '',
  t.num,
  t.org_id,
  t.id,
]
const comparePos = (a: Pos, b: Pos) =>
  a[0] - b[0] || order(a[1], b[1]) || a[2] - b[2] || order(a[3], b[3]) || order(a[4], b[4])

const PREFIX = { attention: 'soa~', paused: 'sop~' } as const

/** What the Overview query `query` answers `args` to the person whose
    workspace is `workspace`; `sees` tells whether they see a project, by
    default every live one the workspace holds, and `force` answers states
    the workspace cannot reach. Throws bad_request for a position from
    another list, scope, reader or clock, as the server refuses it. */
export function overviewStandIn(
  workspace: Workspace,
  query: OverviewQuery,
  args: OverviewArgs,
  { sees, force = {} }: { sees?: (projectId: string) => boolean; force?: ForcedOverview } = {},
): SummaryAnswer | RiskAnswer | ListAnswer | HealthAnswer {
  const mine = new Set(workspace.myProfileIds)
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const profileById = new Map(workspace.profiles.map((p) => [p.id, p]))
  const seen = (id: string) => {
    const p = projectById.get(id)
    return p !== undefined && p.archived_at === undefined && (sees ? sees(id) : true)
  }
  const scope = args.scope

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
  const isGroup = (t: Task) => t.has_hidden_subtasks || (children.get(t.id)?.length ?? 0) > 0
  const groupView = Object.fromEntries(
    workspace.issues.map((t) => [
      t.id,
      {
        id: t.id,
        status: t.status,
        children: children.get(t.id) ?? [],
        hasHiddenSubtasks: t.has_hidden_subtasks,
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
    for (const t of scoped)
      if (!isGroup(t)) {
        leaves[t.status]++
        if (t.paused) paused++
      }
    const budget = force.counts === 'budget'
    const unavailable = { state: 'unavailable' as const, reason: 'budget' as const }
    return {
      state: 'ok',
      counts: budget
        ? unavailable
        : force.counts === 'counting'
          ? { state: 'unavailable', reason: 'counting' }
          : { state: 'ok', leaves, paused },
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
  const clock =
    query === 'paused'
      ? null
      : clockOf(args as { day: string; week: string; week_starts: number[]; week_end: number })
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
  /* The owner whose load `t`'s verdict needs, or null (convex/lib/overview.ts
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

  if (query === 'health') {
    const h = force.health ?? {}
    if (h.scope === 'unavailable') return { state: 'unavailable' }
    if (h.scope === 'access_unchecked')
      return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
    if (h.scope === 'over_budget') return { state: 'over_budget' }
    const most = h.most ?? HEALTH_ROWS
    const { sort = 'late', dir = 'desc', limit = OVERVIEW_BATCH } = args
    if (!Number.isInteger(limit) || limit < 1 || limit > most)
      throw new ConvexError({
        code: 'bad_request',
        message: `limit must be a whole number from 1 to ${most}`,
      })
    const text = (args.search ?? '').trim()
    if (text.length > LIMITS.search.max)
      throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
    const matches = allWordsMatcher(nameKey(text))
    // the rows: a project's sub-projects, or My view's top-level projects
    // above the person's tasks, each with its tasks in the scope
    type Item = { project: Project; key: string; lead: string | null; tasks: Task[] }
    const item = (project: Project, lead: string | null, tasks: Task[]): Item => ({
      project,
      key: nameKey(project.name),
      lead,
      tasks,
    })
    let items: Item[]
    if (subProjects !== null)
      items = subProjects.map((p) =>
        item(
          p,
          p.lead_id ??
            (p.parent_id === undefined ? undefined : projectById.get(p.parent_id)?.lead_id) ??
            null,
          scoped.filter((t) => t.project_id === p.id),
        ),
      )
    else {
      const byTop = new Map<string, Task[]>()
      for (const t of scoped) {
        const top = projectById.get(t.project_id)?.parent_id
        if (top !== undefined) byTop.set(top, [...(byTop.get(top) ?? []), t])
      }
      items = []
      for (const [id, tasks] of byTop) {
        const top = projectById.get(id)
        if (top && top.type === 'meta' && top.parent_id === undefined && seen(top.id))
          items.push(item(top, top.lead_id ?? null, tasks))
      }
    }
    items = items.filter((r) => matches(r.key))
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
    const counted = h.counts === undefined
    // each lead's name, a lead of another organization or none being none
    const leadName = (r: Item) => {
      const p = r.lead === null ? undefined : profileById.get(r.lead)
      return p !== undefined && p.org_id === r.project.org_id ? nameKey(p.name) : undefined
    }
    const delays = new Map<string, Figure<{ late: number; behind: number }>>()
    const columnOf = (r: Item, key: HealthSort): Value => {
      const c = counted ? countsOf(r) : null
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
    let order: Extract<HealthAnswer, { state: 'ok' }>['sort'] =
      COUNT_SORTS.includes(sort) && !counted
        ? { key: 'name', dir: 'asc', by_name: 'counts' }
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
    // the judged rows' delays: owners read in owner id order across them,
    // by organization, none past the first that could not be read, and one
    // a query for a guest or Viewer
    const tracked = (r: Item) => r.tasks.filter(tracks)
    const readable = new Set<string>()
    const all = judged.flatMap(tracked)
    for (const org of [...new Set(all.map((t) => t.org_id))].sort()) {
      const owners = [
        ...new Set(all.filter((t) => t.org_id === org).flatMap((t) => needs(t) ?? [])),
      ].sort()
      for (const [i, id] of owners.entries()) {
        if (unknownOwners.has(id) || (onePerQuery(org) && i > 0)) break
        readable.add(id)
      }
    }
    for (const r of judged) {
      if (h.delays !== undefined) {
        delays.set(r.project.id, { state: 'unavailable', reason: h.delays })
        continue
      }
      let late = 0
      let behind = 0
      let known = true
      for (const t of tracked(r)) {
        const id = needs(t)
        if (id !== null && !readable.has(id)) {
          known = false
          break
        }
        const verdict = verdictOf(t, id === null ? [] : loadOf(t.org_id, id))
        if (verdict?.status === 'late') late++
        else if (verdict?.status === 'behind') behind++
      }
      delays.set(
        r.project.id,
        known ? { state: 'ok', late, behind } : { state: 'unavailable', reason: 'loads' },
      )
    }
    if (byDelays) {
      if (judged.some((r) => delays.get(r.project.id)?.state !== 'ok'))
        order = { key: 'name', dir: 'asc', by_name: 'delays' }
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
            h.counts === undefined
              ? { state: 'ok', ...countsOf(r) }
              : { state: 'unavailable', reason: h.counts },
          delays: delays.get(r.project.id) ?? { state: 'unavailable', reason: 'budget' },
        }),
      ),
      total: items.length,
      sort: order,
      most,
    }
  }

  if (query === 'risk') {
    if (force.projected)
      return { state: 'ok', projected: { state: 'unavailable', reason: force.projected } }
    const day = clock?.day as string
    const open = scoped.filter(
      (t) => t.due_date !== undefined && t.due_date >= day && tracks(t) && !done(t),
    )
    // every owner the verdicts need, at most one a query for a guest or Viewer
    for (const org of new Set(open.map((t) => t.org_id))) {
      const owners = new Set(open.filter((t) => t.org_id === org).flatMap((t) => needs(t) ?? []))
      if ([...owners].some((id) => unknownOwners.has(id)))
        return { state: 'ok', projected: { state: 'unavailable', reason: 'loads' } }
      if (onePerQuery(org) && owners.size > 1)
        return { state: 'ok', projected: { state: 'unavailable', reason: 'loads' } }
    }
    const late = open.filter((t) => {
      const id = needs(t)
      return verdictOf(t, id === null ? [] : loadOf(t.org_id, id))?.status === 'late'
    }).length
    return { state: 'ok', projected: { state: 'ok', count: late } }
  }

  // ---- a list batch
  const kind = query
  const key = JSON.stringify([
    kind,
    workspace.auth_user_id,
    scope.kind === 'project' ? [scope.org_id, scope.project_id] : 'mine',
    kind === 'paused' ? [] : [args.day, args.week, args.week_starts, args.week_end],
  ])
  const seal = (pos: Pos | null) => `${PREFIX[kind]}${JSON.stringify([key, pos])}`
  const open = (text: string | undefined, name: string): Pos | null | undefined => {
    if (text === undefined) return undefined
    const refused = () =>
      new ConvexError({
        code: 'bad_request',
        message: `${name} must be a position an earlier batch of this list answered`,
      })
    if (!text.startsWith(PREFIX[kind])) throw refused()
    let body: unknown
    try {
      body = JSON.parse(text.slice(PREFIX[kind].length))
    } catch {
      throw refused()
    }
    if (!Array.isArray(body) || body[0] !== key) throw refused()
    return body[1] as Pos | null
  }
  const from = open(args.cursor, 'cursor') ?? null
  const fixedEnd = open(args.end, 'end')
  const end = fixedEnd === undefined ? null : fixedEnd
  if (force.list === 'over_budget') return { state: 'over_budget' }

  // the candidates in order: the At-risk list's overdue and projected-late
  // tasks, the Paused list's paused tasks without subtasks
  const day = clock?.day ?? ''
  const candidates = scoped
    .filter((t) =>
      kind === 'paused'
        ? t.paused
        : t.due_date !== undefined && (t.due_date < day || tracks(t)) && !done(t),
    )
    .sort((a, b) => comparePos(posOf(a), posOf(b)))
  const shown = new Set(workspace.issues.map((t) => t.id))
  const rowOf = (t: Task, at_risk?: OverviewRow['at_risk']): OverviewRow => {
    const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
    const row = {
      ...rest,
      ...(parent !== undefined && shown.has(parent) ? { parent_id: parent } : {}),
    } as Omit<ViewRow, 'has_subtasks'>
    const view: ViewRow = isGroup(t)
      ? {
          ...row,
          has_subtasks: true,
          has_hidden_subtasks: t.has_hidden_subtasks,
          group_done: done(t),
          span: {
            ...spanOf(t, children, byId),
            partial: groupProgress(groupView[t.id], groupView).unknown,
          },
        }
      : { ...row, has_subtasks: false, has_hidden_subtasks: false }
    return at_risk === undefined ? view : { ...view, at_risk }
  }

  // one batch's read (convex/lib/overview.ts readBatch)
  const want = end === null ? OVERVIEW_BATCH + 1 : OVERVIEW_SPLIT + 1
  const rows: { task: Task; row: OverviewRow }[] = []
  let last: Pos | null = from
  let stopped = false
  // the owner a guest's or Viewer's batch read, by organization
  const read = new Map<string, string>()
  const unread = new Set<string>()
  const stopAt =
    force.list === 'incomplete' ? Math.ceil(OVERVIEW_BATCH / 2) : Number.POSITIVE_INFINITY
  let judged = 0
  for (const t of candidates) {
    const pos = posOf(t)
    if (from !== null && comparePos(pos, from) <= 0) continue
    if (end !== null && comparePos(pos, end) > 0) break
    if (rows.length >= want) break
    if (judged >= stopAt) {
      stopped = true
      break
    }
    judged++
    if (kind === 'paused') {
      if (!isGroup(t)) rows.push({ task: t, row: rowOf(t) })
      last = pos
      continue
    }
    if ((t.due_date as string) < day) {
      rows.push({ task: t, row: rowOf(t, { kind: 'overdue' }) })
      last = pos
      continue
    }
    const id = needs(t)
    let verdict: ReturnType<typeof verdictOf>
    if (id === null) verdict = verdictOf(t, [])
    else {
      const other = onePerQuery(t.org_id) && read.has(t.org_id) && read.get(t.org_id) !== id
      if (other || unknownOwners.has(id)) {
        // nothing judged before it, or an owner no batch can read: unknown
        if (last !== from && !unread.has(id)) {
          stopped = true
          break
        }
        unread.add(id)
        rows.push({ task: t, row: rowOf(t, { kind: 'unknown' }) })
        last = pos
        continue
      }
      if (onePerQuery(t.org_id)) read.set(t.org_id, id)
      verdict = verdictOf(t, loadOf(t.org_id, id))
    }
    if (verdict?.status === 'late')
      rows.push({
        task: t,
        row: rowOf(t, {
          kind: 'projected',
          finish_week:
            verdict.fin === null
              ? null
              : (clock as NonNullable<typeof clock>).firstDay(verdict.fin),
        }),
      })
    last = pos
  }

  // the batch's answer (convex/lib/overview.ts listBatch)
  if (stopped && rows.length === 0 && last === from) return { state: 'over_budget' }
  let kept = rows
  let split: string | undefined
  let complete = !stopped
  let next: string | null
  let lastText: string | null
  const posOfRow = (i: number) => posOf((kept[i] as { task: Task }).task)
  if (end === null) {
    if (rows.length > OVERVIEW_BATCH || (stopped && rows.length === OVERVIEW_BATCH)) {
      kept = rows.slice(0, OVERVIEW_BATCH)
      lastText = seal(posOfRow(kept.length - 1))
      next = lastText
      complete = true
    } else if (!stopped) {
      lastText = kept.length === 0 ? null : seal(posOfRow(kept.length - 1))
      next = null
    } else {
      lastText = last === null ? null : seal(last)
      next = seal(last)
    }
  } else if (rows.length > OVERVIEW_SPLIT) {
    kept = rows.slice(0, OVERVIEW_BATCH)
    split = seal(posOfRow(kept.length - 1))
    complete = true
    lastText = seal(end)
    next = lastText
  } else {
    lastText = seal(end)
    next = stopped ? seal(last) : lastText
  }
  return {
    state: 'ok',
    rows: kept.map((r) => r.row),
    complete,
    next,
    end: lastText,
    ...(split === undefined ? {} : { split }),
  }
}

/** Answers a test double's subscription to `name`, one of the Overview's
    queries as Convex names it (`overview:summary` and so on), with `args`
    over `workspace` through `next`, or through `fail` where the stand-in
    refuses, as the app-level tests' network doubles answer the Board's. */
export function answerOverview(
  workspace: Workspace,
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
