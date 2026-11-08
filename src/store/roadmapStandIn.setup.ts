/* A stand-in for the Roadmap's live queries (convex/tasks.ts roadmap and
   roadmapDependencies) that answers from a workspace the app holds, for the
   jsdom Roadmap (src/views/boardFixture.setup.tsx), the app-level tests and
   the browser benchmark's server (scripts/perf/server.mjs).

   It applies the Roadmap's rules (convex/lib/roadmap.ts, design
   specification row 405) to the workspace's tasks: the selection as the
   Board's stand-in reads it (store/boardStandIn.setup.ts, with `sees`), the
   filter row with each task's owner by the Reviewer rule, the shared
   visibility rule in the window (convex/lib/roadmapVisibility.ts), a
   group's Done and span, the ceiling of ROADMAP_TASKS rows with groups and
   subtasks counted, the shown parents, the shown subtasks of group rows,
   My view's sub-projects, a project selection's sub-projects, the
   headings' Remaining in tenths from the leaves, and the planning
   session's task, which skips the filter row alone. For the dependency
   read it builds the graph over every task of the workspace with a span,
   the blocks links between them and each group's link to its subtasks, and
   answers the arrows' pairs between the selection's own tasks and the
   parts that hold a selected task and a link, with their pairs in link
   creation order and the projects `canEdit` says the reader may edit. It
   has no read budget, so it answers a limit or a state the workspace
   cannot reach only when `force` asks for one, or when a test lowers
   `ceiling` or `partTasks`. It imports only modules the perf worker can
   load. src/store/roadmapParity.test.ts compares it with the real
   queries. */

import { ROADMAP_TASKS } from '../../convex/lib/limits'
import { taskOwnerId } from '../../convex/lib/review'
import type {
  AutoMoveInputs,
  DependencyAnswer,
  DependencyRow,
  PlannedTask,
  RoadmapAnswer,
  RoadmapFilters,
  RoadmapScope,
  RoadmapWindow,
} from '../../convex/lib/roadmap'
import { isRoadmapTaskVisible } from '../../convex/lib/roadmapVisibility'
import { allWordsMatcher, taskSearchText } from '../../convex/lib/search'
import { issueKey } from '../../convex/lib/taskRefs'
import type { ViewRow } from '../../convex/lib/viewReads'
import { groupProgress, isIssueDone } from '../lib/issueGroups'
import { ACCESS_UNCHECKED_MESSAGE, spanOf } from './boardStandIn.setup'
import type { Whole } from './guard/liveDouble.setup'

/** The arguments tasks.roadmap takes. */
export type RoadmapArgs = {
  scope: RoadmapScope
  filters: RoadmapFilters
  window: RoadmapWindow
  planned_task?: PlannedTask
}

/** The arguments tasks.roadmapDependencies takes. */
export type DependencyArgs = { scope: RoadmapScope }

/** A state the stand-in answers whatever the tasks say: the Roadmap's
    `over_ceiling`, `over_budget`, `unavailable` and `access_unchecked`
    (both reads), a Remaining still `counting` or past its `budget`
    (`remaining-budget`), the dependency read's `over_budget`
    (`deps-budget`) and Auto-move's inputs past their size
    (`automove-budget`). */
export type ForcedRoadmap =
  | 'over_ceiling'
  | 'over_budget'
  | 'unavailable'
  | 'access_unchecked'
  | 'counting'
  | 'remaining-budget'
  | 'deps-budget'
  | 'automove-budget'

/** What the stand-in reads besides the workspace: whether the person sees
    a project, may edit one, the states it is told to answer, and the
    bounds a test lowers. */
export type RoadmapStandInOptions = {
  sees?: (projectId: string) => boolean
  canEdit?: (projectId: string) => boolean
  force?: readonly ForcedRoadmap[]
  /** the most rows one Roadmap answers, ROADMAP_TASKS by default */
  ceiling?: number
  /** the most tasks Auto-move's parts hold, the server's DEPENDENCIES.tasks */
  partTasks?: number
}

type Snapshot = Pick<
  Whole,
  'myProfileIds' | 'profiles' | 'projects' | 'issues' | 'labels' | 'issueLabels' | 'links'
>
type Task = Whole['issues'][number]
type Project = Whole['projects'][number]
type Link = Whole['links'][number]

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byNumber = (a: Task, b: Task) =>
  a.num - b.num || order(a.org_id, b.org_id) || order(a.id, b.id)
const byCreation = (a: Project, b: Project) =>
  order(a.created_at ?? '', b.created_at ?? '') || order(a.id, b.id)
const linksByCreation = (a: Link, b: Link) => order(a.created_at, b.created_at) || order(a.id, b.id)

/* A YYYY-MM-DD day as a whole number of days. */
const dayOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y as number, (m as number) - 1, d as number) / 86_400_000
}

/** What the stand-in knows of the workspace's tasks: each by id, their
    shown subtasks, which are groups, a group's Done and span, each task's
    owner, and which tasks a person with `sees` is shown in a live
    sub-project. */
function tasksOf(workspace: Snapshot, sees?: (projectId: string) => boolean) {
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const seen = (id: string) => {
    const p = projectById.get(id)
    return p !== undefined && p.archived_at === undefined && (sees ? sees(id) : true)
  }
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
  const span = (t: Task) => ({
    ...spanOf(t, children, byId),
    partial: groupProgress(groupView[t.id], groupView).unknown,
  })
  const owner = (t: Task) => taskOwnerId(t, isGroup(t))
  const inSubProject = (t: Task) => {
    const p = projectById.get(t.project_id)
    return p !== undefined && p.parent_id !== undefined && seen(p.id)
  }
  return { projectById, seen, byId, children, isGroup, done, span, owner, inSubProject }
}

/** The selection `scope` names to the person whose workspace is
    `workspace`: a project selection's sub-projects in creation order, an
    empty list for My view, or null for a selection they hold no seat in or
    that names none. */
function selectionOf(
  workspace: Snapshot,
  scope: RoadmapScope,
  tasks: ReturnType<typeof tasksOf>,
): Project[] | null {
  if (scope.kind === 'mine') return []
  const mine = new Set(workspace.myProfileIds)
  const seats = new Set(workspace.profiles.filter((p) => mine.has(p.id)).map((p) => p.org_id))
  const project = tasks.projectById.get(scope.project_id)
  if (!seats.has(scope.org_id) || !project || project.org_id !== scope.org_id) return null
  if (project.parent_id !== undefined) return tasks.seen(project.id) ? [project] : null
  if (project.type !== 'meta' || project.archived_at !== undefined) return null
  return workspace.projects
    .filter((p) => p.parent_id === project.id && p.org_id === project.org_id && tasks.seen(p.id))
    .sort(byCreation)
}

/** The selection's tasks: a project selection's active tasks of its
    sub-projects, or My view's own, by the Reviewer rule, in sub-projects
    the person sees. */
function selectedTasks(
  workspace: Snapshot,
  scope: RoadmapScope,
  subProjects: readonly Project[],
  tasks: ReturnType<typeof tasksOf>,
): Task[] {
  const mine = new Set(workspace.myProfileIds)
  const ids = new Set(subProjects.map((p) => p.id))
  return workspace.issues.filter((t) =>
    scope.kind === 'project'
      ? ids.has(t.project_id)
      : tasks.inSubProject(t) && mine.has(tasks.owner(t) ?? ''),
  )
}

/** `t` as a view row (convex/lib/viewReads.ts ViewRow), its parent named
    only where `shown` holds it. */
function rowOf(t: Task, tasks: ReturnType<typeof tasksOf>, shown: (id: string) => boolean) {
  const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
  const row = {
    ...rest,
    ...(parent !== undefined && shown(parent) ? { parent_id: parent } : {}),
  } as Omit<ViewRow, 'has_subtasks'>
  if (!tasks.isGroup(t)) return { ...row, has_subtasks: false, has_hidden_subtasks: false }
  return {
    ...row,
    has_subtasks: true,
    has_hidden_subtasks: t.has_hidden_subtasks,
    group_done: tasks.done(t),
    span: tasks.span(t),
  } as ViewRow
}

/**
 * What tasks.roadmap answers for `args` to the person whose workspace is
 * `workspace`. A search past the server's limit is the caller's to refuse.
 */
export function roadmapStandIn(
  workspace: Snapshot,
  { scope, filters: f, window: win, planned_task: planned }: RoadmapArgs,
  { sees, force = [], ceiling = ROADMAP_TASKS }: RoadmapStandInOptions = {},
): RoadmapAnswer {
  const forced = new Set(force)
  const tasks = tasksOf(workspace, sees)
  const subProjects = selectionOf(workspace, scope, tasks)
  if (subProjects === null || forced.has('unavailable')) return { state: 'unavailable' }
  if (forced.has('access_unchecked'))
    return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
  const projects = scope.kind === 'project' ? { projects: subProjects.map((p) => p.id) } : {}
  if (forced.has('over_budget')) return { state: 'over_budget', ...projects }
  if (forced.has('over_ceiling')) return { state: 'over_ceiling', ceiling, ...projects }

  const mine = new Set(workspace.myProfileIds)
  const selected = selectedTasks(workspace, scope, subProjects, tasks)
  // the window: a stored day's week is the whole number of weeks from `from`
  const from = dayOf(win.from)
  const last = (dayOf(win.to) - from) / 7
  const weekIn = (iso: string) => Math.floor((dayOf(iso) - from) / 7)
  const visible = (t: Task) => {
    if (tasks.isGroup(t)) {
      const span = tasks.span(t)
      return isRoadmapTaskVisible(
        {
          status: t.status,
          isGroup: true,
          start: span.start_week === undefined ? null : weekIn(span.start_week),
          end: span.end_week === undefined ? null : weekIn(span.end_week),
        },
        tasks.done(t),
        0,
        last,
      )
    }
    const start = t.start_week === undefined ? null : weekIn(t.start_week)
    const end =
      t.end_week === undefined ? null : Math.max(start ?? weekIn(t.end_week), weekIn(t.end_week))
    return isRoadmapTaskVisible(
      { status: t.status, isGroup: false, start, end },
      t.status === 'done',
      0,
      last,
    )
  }

  // the filter row, each task's owner by the Reviewer rule
  const names = new Map(workspace.profiles.map((p) => [p.id, p.name]))
  const labelNames = new Map(workspace.labels.map((l) => [l.id, l.name]))
  const labelsOf = new Map<string, string[]>()
  for (const row of workspace.issueLabels)
    labelsOf.set(row.issue_id, [...(labelsOf.get(row.issue_id) ?? []), row.label_id])
  const search = f.search.trim()
  const matches = search === '' ? null : allWordsMatcher(search)
  const owners = new Set(f.owners)
  const passes = (t: Task) => {
    const who = tasks.owner(t)
    if ((scope.kind === 'mine' || f.mine) && !mine.has(who ?? '')) return false
    if (owners.size > 0 && !owners.has(who ?? '')) return false
    if (f.priority !== null && t.priority !== f.priority) return false
    if (
      matches !== null &&
      !matches(
        taskSearchText({
          key: issueKey(t.num),
          title: t.title,
          description: t.description ?? '',
          status: t.status,
          group: tasks.isGroup(t),
          priority: t.priority,
          assigneeName: t.assignee_id ? names.get(t.assignee_id) : null,
          labelNames: (labelsOf.get(t.id) ?? []).map((id) => labelNames.get(id)),
        }),
      )
    )
      return false
    return true
  }
  // the planning session's task skips the filter row alone, where it is in
  // the sub-project the caller names and the selection
  const kept = (t: Task) =>
    planned !== undefined &&
    t.id === planned.id &&
    t.project_id === planned.project_id &&
    (scope.kind === 'mine' || subProjects.some((p) => p.id === planned.project_id))
  const rows = selected.filter((t) => (passes(t) || kept(t)) && visible(t)).sort(byNumber)
  if (rows.length > ceiling) return { state: 'over_ceiling', ceiling, ...projects }

  // the shown ancestors of rows that are not rows themselves
  const rowIds = new Set(rows.map((t) => t.id))
  const parents = new Map<string, Task>()
  for (const t of rows) {
    const visited = new Set([t.id])
    for (let p = t.parent_id && tasks.byId.get(t.parent_id); p && !visited.has(p.id); ) {
      visited.add(p.id)
      if (!rowIds.has(p.id)) parents.set(p.id, p)
      p = p.parent_id ? tasks.byId.get(p.parent_id) : undefined
    }
  }
  // every shown descendant of a group row, at any depth through nested
  // groups, that is neither a row nor a parent
  const subtasks: Task[] = []
  const visited = new Set<string>()
  const stack = rows.filter((t) => tasks.isGroup(t)).flatMap((t) => tasks.children.get(t.id) ?? [])
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (visited.has(id)) continue
    visited.add(id)
    const kid = tasks.byId.get(id)
    if (!kid) continue
    if (!rowIds.has(id) && !parents.has(id)) subtasks.push(kid)
    if (tasks.isGroup(kid)) stack.push(...(tasks.children.get(id) ?? []))
  }
  const shownIds = new Set([...rowIds, ...parents.keys(), ...subtasks.map((t) => t.id)])
  const shown = (id: string) => shownIds.has(id)

  // the headings' Remaining in tenths, before the filters: a project
  // selection's every sub-project, My view's sub-projects that hold a leaf
  // the person owns
  let remaining: Extract<RoadmapAnswer, { state: 'ok' }>['remaining']
  if (forced.has('counting')) remaining = { state: 'unavailable', reason: 'counting' }
  else if (forced.has('remaining-budget')) remaining = { state: 'unavailable', reason: 'budget' }
  else {
    const tenths: Record<string, number> = {}
    if (scope.kind === 'project') for (const p of subProjects) tenths[p.id] = 0
    for (const t of selected) {
      if (tasks.isGroup(t)) continue
      if (scope.kind === 'mine' && !mine.has(taskOwnerId(t, false) ?? '')) continue
      tenths[t.project_id] =
        (tenths[t.project_id] ?? 0) +
        (t.status === 'done' ? 0 : Math.round((t.remaining_hours ?? 0) * 10))
    }
    remaining = { state: 'ok', tenths }
  }
  const held =
    scope.kind === 'mine'
      ? { held_sub_projects: [...new Set(selected.map((t) => t.project_id))].sort(order) }
      : {}
  return {
    state: 'ok',
    rows: rows.map((t) => rowOf(t, tasks, shown)),
    parents: [...parents.values()].sort(byNumber).map((t) => rowOf(t, tasks, shown)),
    subtasks: subtasks.sort(byNumber).map((t) => rowOf(t, tasks, shown)),
    ...held,
    ...projects,
    remaining,
  }
}

/**
 * What tasks.roadmapDependencies answers for `args` to the person whose
 * workspace is `workspace`.
 */
export function dependenciesStandIn(
  workspace: Snapshot,
  { scope }: DependencyArgs,
  { sees, canEdit = () => true, force = [], partTasks = 2000 }: RoadmapStandInOptions = {},
): DependencyAnswer {
  const forced = new Set(force)
  const tasks = tasksOf(workspace, sees)
  const subProjects = selectionOf(workspace, scope, tasks)
  if (subProjects === null || forced.has('unavailable')) return { state: 'unavailable' }
  if (forced.has('access_unchecked'))
    return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
  if (forced.has('deps-budget')) return { state: 'over_budget' }
  const selected = selectedTasks(workspace, scope, subProjects, tasks)

  // the graph's nodes, every task with a span, and its edges
  const isNode = (t: Task) =>
    tasks.isGroup(t) ? tasks.span(t).start_week !== undefined : t.start_week !== undefined
  const nodes = new Map(workspace.issues.filter(isNode).map((t) => [t.id, t]))
  const blocks = workspace.links.filter((l) => l.type === 'blocks')
  const roots = new Set(selected.filter((t) => nodes.has(t.id)).map((t) => t.id))
  const pairOf = (l: Link) => ({ blocker: l.source_id, blocked: l.target_id })
  const pairs = blocks
    .filter((l) => roots.has(l.source_id) && roots.has(l.target_id))
    .sort(linksByCreation)
    .map(pairOf)

  // the parts grown from the selected nodes through links, parents and
  // subtasks, each a node
  const near = new Map<string, Set<string>>()
  const join = (a: string, b: string) => {
    near.set(a, (near.get(a) ?? new Set()).add(b))
    near.set(b, (near.get(b) ?? new Set()).add(a))
  }
  for (const t of nodes.values())
    if (t.parent_id !== undefined && nodes.has(t.parent_id)) join(t.id, t.parent_id)
  const partLinks = blocks.filter((l) => nodes.has(l.source_id) && nodes.has(l.target_id))
  for (const l of partLinks) join(l.source_id, l.target_id)
  const part = new Map<string, number>()
  let grown = 0
  let parts = 0
  for (const id of roots) {
    if (part.has(id)) continue
    const at = parts++
    const stack = [id]
    while (stack.length) {
      const next = stack.pop() as string
      if (part.has(next)) continue
      part.set(next, at)
      grown++
      stack.push(...(near.get(next) ?? []))
    }
  }
  let auto_move: AutoMoveInputs | { state: 'over_budget' }
  if (forced.has('automove-budget') || grown > partTasks) auto_move = { state: 'over_budget' }
  else {
    const linked = new Set(
      partLinks.filter((l) => part.has(l.source_id)).map((l) => part.get(l.source_id)),
    )
    const kept = [...part.keys()]
      .filter((id) => linked.has(part.get(id)))
      .map((id) => nodes.get(id) as Task)
      .sort(byNumber)
    const keptIds = new Set(kept.map((t) => t.id))
    const shown = (id: string) => keptIds.has(id)
    auto_move = {
      state: 'ok',
      tasks: kept.map((t): DependencyRow => {
        const row = rowOf(t, tasks, shown)
        return {
          id: row.id,
          org_id: row.org_id,
          project_id: row.project_id,
          num: row.num,
          status: row.status,
          ...(row.start_week === undefined ? {} : { start_week: row.start_week }),
          ...(row.end_week === undefined ? {} : { end_week: row.end_week }),
          ...(row.parent_id === undefined ? {} : { parent_id: row.parent_id }),
          has_subtasks: row.has_subtasks,
          ...(row.span === undefined ? {} : { span: row.span }),
        }
      }),
      pairs: partLinks
        .filter((l) => keptIds.has(l.source_id))
        .sort(linksByCreation)
        .map(pairOf),
      editable_projects: [...new Set(kept.map((t) => t.project_id))]
        .filter((id) => canEdit(id))
        .sort(order),
    }
  }
  return { state: 'ok', pairs, auto_move }
}

/** Answers subscription `name` (tasks:roadmap or tasks:roadmapDependencies)
    with `args` from `workspace`, or undefined for any other query, for a
    test's or a server's query router. */
export function answerRoadmap(
  workspace: Snapshot,
  name: string,
  args: unknown,
  options: RoadmapStandInOptions = {},
): RoadmapAnswer | DependencyAnswer | undefined {
  if (name === 'tasks:roadmap') return roadmapStandIn(workspace, args as RoadmapArgs, options)
  if (name === 'tasks:roadmapDependencies')
    return dependenciesStandIn(workspace, args as DependencyArgs, options)
  return undefined
}
