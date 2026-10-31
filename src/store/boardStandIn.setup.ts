/* A stand-in for the Board's live query (convex/tasks.ts board) that answers
   from a workspace the app holds, for the jsdom Board fixture
   (src/views/boardFixture.setup.tsx), the app-level tests and the browser
   benchmark's server (scripts/perf/server.mjs).

   It applies the Board's rules (convex/lib/board.ts) to the workspace's
   tasks: the selection, the filter row as the app's passesFilters applies
   it, with each task's owner by the Reviewer rule, Focus without the
   groups stored in Backlog or Done, the ceiling of BOARD_TASKS matching
   tasks without subtasks, the shown parents and the lanes the Board keeps.
   It reads no access rule of its own: `sees` tells the sub-projects the
   person sees, by default every live one the workspace holds, as the
   workspace sends only those, and a live top-level project in the workspace
   selects the ones of its sub-projects they see. It has no read budget, so it answers
   `over_budget` or `unavailable` only when `force` asks for them.
   src/store/boardParity.test.ts compares it with the real query. */

import type { BoardAnswer, BoardFilters, BoardScope } from '../../convex/lib/board'
import { BOARD_TASKS, LIMITS } from '../../convex/lib/limits'
import { taskOwnerId } from '../../convex/lib/review'
import { allWordsMatcher, taskSearchText } from '../../convex/lib/search'
import { issueKey } from '../../convex/lib/taskRefs'
import type { ViewRow } from '../../convex/lib/viewReads'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import { groupProgress, isIssueDone } from '../lib/issueGroups'

/** The arguments the Board sends. */
export type BoardArgs = { scope: BoardScope; filters: BoardFilters }

/** A state the stand-in answers whatever the tasks say. */
export type ForcedBoard = 'over_ceiling' | 'over_budget' | 'unavailable' | 'access_unchecked'

/** The sentence an `access_unchecked` answer carries. */
export const ACCESS_UNCHECKED_MESSAGE =
  'Qivo could not check all of your access in time. Try again in a moment.'

type Task = Workspace['issues'][number]
type Project = Workspace['projects'][number]

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byNumber = (a: Task, b: Task) =>
  a.num - b.num || order(a.org_id, b.org_id) || order(a.id, b.id)
const byCreation = (a: Project, b: Project) =>
  order(a.created_at ?? '', b.created_at ?? '') || order(a.id, b.id)

const FOCUS = new Set(['todo', 'progress', 'review'])

/**
 * What tasks.board answers for `args` to the person whose workspace is
 * `workspace`. `sees` tells whether they see a project; `force` answers a
 * state instead. A search past LIMITS.search throws, as the server refuses
 * it.
 */
export function boardStandIn(
  workspace: Pick<
    Workspace,
    'myProfileIds' | 'profiles' | 'projects' | 'issues' | 'labels' | 'issueLabels'
  >,
  { scope, filters: f }: BoardArgs,
  { sees, force }: { sees?: (projectId: string) => boolean; force?: ForcedBoard } = {},
): BoardAnswer {
  const search = f.search.trim()
  if (search.length > LIMITS.search.max) throw new Error(LIMITS.search.refusal)
  const mine = new Set(workspace.myProfileIds)
  const projectById = new Map(workspace.projects.map((p) => [p.id, p]))
  const seen = (id: string) => {
    const p = projectById.get(id)
    return p !== undefined && p.archived_at === undefined && (sees ? sees(id) : true)
  }

  // the selection's sub-projects, in creation order, or null for none
  let subProjects: Project[] | null = null
  if (scope.kind === 'project') {
    const seats = new Set(
      workspace.profiles.filter((p) => mine.has(p.id)).map((p) => p.org_id as string),
    )
    const project = projectById.get(scope.project_id)
    if (!seats.has(scope.org_id) || !project || project.org_id !== scope.org_id) subProjects = null
    else if (project.parent_id !== undefined) subProjects = seen(project.id) ? [project] : null
    else if (project.type === 'meta' && project.archived_at === undefined) {
      const subs = workspace.projects
        .filter((p) => p.parent_id === project.id && p.org_id === project.org_id && seen(p.id))
        .sort(byCreation)
      // the workspace sends a top-level project to someone who sees it, or
      // a sub-project of it, which is all it selects then
      subProjects = subs
    }
    if (subProjects === null || force === 'unavailable') return { state: 'unavailable' }
  } else if (force === 'unavailable') return { state: 'unavailable' }
  if (force === 'access_unchecked')
    return { state: 'unavailable', reason: 'access_unchecked', message: ACCESS_UNCHECKED_MESSAGE }
  const projects = subProjects ? { projects: subProjects.map((p) => p.id) } : {}
  if (force === 'over_budget') return { state: 'over_budget', ...projects }
  if (force === 'over_ceiling') return { state: 'over_ceiling', ceiling: BOARD_TASKS, ...projects }

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
  /* the newest activity of `t` and the subtasks under it */
  const newest = (t: Task): number => {
    let at = Date.parse(t.updated_at)
    const stack = [...(children.get(t.id) ?? [])]
    const visited = new Set([t.id])
    while (stack.length) {
      const id = stack.pop() as string
      if (visited.has(id)) continue
      visited.add(id)
      const child = byId.get(id)
      if (!child) continue
      at = Math.max(at, Date.parse(child.updated_at))
      stack.push(...(children.get(id) ?? []))
    }
    return at
  }
  const owner = (t: Task) => taskOwnerId(t, isGroup(t))
  const inSubProject = (t: Task) => {
    const p = projectById.get(t.project_id)
    return p !== undefined && p.parent_id !== undefined && seen(p.id)
  }

  // the selection's tasks
  const ids = new Set(subProjects?.map((p) => p.id))
  const selected = workspace.issues.filter((t) =>
    scope.kind === 'project' ? ids.has(t.project_id) : inSubProject(t) && mine.has(owner(t) ?? ''),
  )

  const names = new Map(workspace.profiles.map((p) => [p.id, p.name]))
  const labelNames = new Map(workspace.labels.map((l) => [l.id, l.name]))
  const labelsOf = new Map<string, string[]>()
  for (const row of workspace.issueLabels)
    labelsOf.set(row.issue_id, [...(labelsOf.get(row.issue_id) ?? []), row.label_id])
  const matches = search === '' ? null : allWordsMatcher(search)
  const staleBefore = f.stale_before === null ? null : Date.parse(f.stale_before)
  const owners = new Set(f.owners)
  const passes = (t: Task) => {
    const group = isGroup(t)
    const who = owner(t)
    if ((scope.kind === 'mine' || f.mine) && !mine.has(who ?? '')) return false
    if (owners.size > 0 && !owners.has(who ?? '')) return false
    if (f.priority !== null && t.priority !== f.priority) return false
    if (staleBefore !== null) {
      const stale = group
        ? !done(t) && newest(t) < staleBefore
        : t.status !== 'done' && Date.parse(t.updated_at) < staleBefore
      if (!stale) return false
    }
    // Focus reads only To do, In progress and In review, groups included
    if (f.focus && !FOCUS.has(t.status)) return false
    if (
      matches !== null &&
      !matches(
        taskSearchText({
          key: issueKey(t.num),
          title: t.title,
          description: t.description ?? '',
          status: t.status,
          group,
          priority: t.priority,
          assigneeName: t.assignee_id ? names.get(t.assignee_id) : null,
          labelNames: (labelsOf.get(t.id) ?? []).map((id) => labelNames.get(id)),
        }),
      )
    )
      return false
    return true
  }
  const rows = selected.filter(passes).sort(byNumber)
  if (rows.filter((t) => !isGroup(t)).length > BOARD_TASKS)
    return { state: 'over_ceiling', ceiling: BOARD_TASKS, ...projects }

  // the shown ancestors of rows that are not rows themselves
  const rowIds = new Set(rows.map((t) => t.id))
  const parents = new Map<string, Task>()
  for (const t of rows) {
    const visited = new Set([t.id])
    for (let p = t.parent_id && byId.get(t.parent_id); p && !visited.has(p.id); ) {
      visited.add(p.id)
      if (!rowIds.has(p.id)) parents.set(p.id, p)
      p = p.parent_id ? byId.get(p.parent_id) : undefined
    }
  }

  // the lanes the Board keeps (lib/board.ts heldLanes)
  const clearable =
    (scope.kind === 'project' && f.mine) ||
    owners.size > 0 ||
    f.priority !== null ||
    staleBefore !== null ||
    search !== ''
  const counted = rows.filter((t) => !clearable || !isGroup(t))
  let held: string[]
  if (subProjects !== null) {
    const keep = new Set(counted.map((t) => t.project_id))
    if (!clearable && f.focus)
      for (const p of subProjects)
        if (workspace.issues.some((t) => t.project_id === p.id)) keep.add(p.id)
    held = subProjects.map((p) => p.id).filter((id) => keep.has(id))
  } else {
    const keep = new Set<string>()
    const hold = (t: Task) => {
      const top = projectById.get(t.project_id)?.parent_id
      if (top !== undefined) keep.add(top)
    }
    for (const t of counted) hold(t)
    if (!clearable && f.focus)
      for (const t of workspace.issues)
        if (
          (t.status === 'backlog' || t.status === 'done') &&
          mine.has(t.assignee_id ?? '') &&
          inSubProject(t)
        )
          hold(t)
    held = [...keep].sort(order)
  }

  const shown = new Set([...rowIds, ...parents.keys()])
  const out = (t: Task): ViewRow => {
    const { description: _text, parent_id: parent, has_subtasks: _flag, ...rest } = t
    const row = {
      ...rest,
      ...(parent !== undefined && shown.has(parent) ? { parent_id: parent } : {}),
    } as Omit<ViewRow, 'has_subtasks'>
    if (!isGroup(t)) return { ...row, has_subtasks: false, has_hidden_subtasks: false }
    return {
      ...row,
      has_subtasks: true,
      has_hidden_subtasks: t.has_hidden_subtasks,
      group_done: done(t),
      span: {
        ...spanOf(t, children, byId),
        partial: groupProgress(groupView[t.id], groupView).unknown,
      },
    }
  }
  return {
    state: 'ok',
    rows: rows.map(out),
    parents: [...parents.values()].sort(byNumber).map(out),
    held_projects: held,
    ...projects,
  }
}

/* A group's dates: the earliest start to the latest end of the leaves
   under it, a leaf without an end counted at its start (lib/viewReads.ts
   groupFacts). */
function spanOf(
  group: Task,
  children: ReadonlyMap<string, string[]>,
  byId: ReadonlyMap<string, Task>,
): { start_week?: string; end_week?: string } {
  let start: string | undefined
  let end: string | undefined
  const stack = [...(children.get(group.id) ?? [])]
  const visited = new Set([group.id])
  while (stack.length) {
    const id = stack.pop() as string
    if (visited.has(id)) continue
    visited.add(id)
    const t = byId.get(id)
    if (!t) continue
    const below = children.get(id) ?? []
    if (below.length || t.has_hidden_subtasks) {
      stack.push(...below)
      continue
    }
    const from = t.start_week ?? t.end_week
    const to = t.end_week ?? t.start_week
    if (from === undefined || to === undefined) continue
    if (start === undefined || from < start) start = from
    if (end === undefined || to > end) end = to
  }
  return {
    ...(start === undefined ? {} : { start_week: start }),
    ...(end === undefined ? {} : { end_week: end }),
  }
}
