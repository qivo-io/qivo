/* A stand-in for the task window's three reads (convex/taskWindow.ts task,
   links and attachments) that answers from the server's data a test
   publishes (store/guard/liveDouble.setup.ts Whole), for the store's live
   double, which answers them from the published whole by default, and the
   browser benchmark's server (scripts/perf/server.mjs).

   It applies the readers' rules (convex/lib/taskWindow.ts) to the whole's
   tasks, which are the caller's working set: a server-made whole holds
   only the tasks the caller is shown (convex/tests/tasksOracle.setup.ts),
   and a fixture's holds the tasks its test means the caller to see.

   - task: the task the ref names in the organization the read names, a
     uuid in any case or a number bare or as QN-12, never another
     organization's (convex/lib/taskWindow.ts taskByRef). An active task
     whose project the caller reaches answers `ok` with its row, the
     caller's level on its project, its label rows, the caller's follow,
     its parent as a short row when the whole holds the parent, and its
     subtasks the whole holds as short rows by number and then id, the
     list complete. An archived task whose project the caller sees answers
     `archived` with the Archived tasks page's row, its text, labels, level
     and whether its project is archived. Everything else answers
     `unavailable`, alike.
   - links: the opened task's links, as source and as target, whose other
     end the whole holds, by creation and then id, with each other end
     once as a short row.
   - attachments: the opened task's attachment rows by creation and then
     id, with the count of those not dropped.

   The caller's sight of a project and level on it follow the project
   navigation reads' rule (store/projectNavStandIn.setup.ts seatSight), so
   it judges every seat by ordinary access as the server does: an active
   task opens when its project and that project's parent are live and the
   seat sees the project, an archived one when the seat sees its project,
   archived or not, and the level is the seat's own on the project, or
   Viewer for a top-level project it sees only to reach a sub-project. It reads no budget, so a stopped
   or incomplete list, a read that never answers or fails, and an
   unavailable answer come only when `force` asks for them. It imports
   nothing the benchmark's worker cannot load. */

import { parseIssueRef } from '../../convex/lib/taskRefs'
import type { Whole } from './guard/liveDouble.setup'
import { seatSight } from './projectNavStandIn.setup'

/** The three reads this stand-in answers. */
export const TASK_WINDOW_READS = [
  'taskWindow:task',
  'taskWindow:links',
  'taskWindow:attachments',
] as const
export type TaskWindowRead = (typeof TASK_WINDOW_READS)[number]

/** Whether query `name` is one of the window's three reads. */
export const isTaskWindowRead = (name: string): name is TaskWindowRead =>
  (TASK_WINDOW_READS as readonly string[]).includes(name)

/** States a read answers whatever the whole says: `loading` never
    answers, `failed` fails, `unavailable` answers that the caller may not
    open the task, and `incomplete` answers a list that says it is not
    whole (half the subtasks, has_hidden_subtasks set). */
export type ForcedTaskWindow = 'loading' | 'failed' | 'unavailable' | 'incomplete'

/** What a read that never answers holds back. */
export const TASK_WINDOW_NO_ANSWER = Symbol('task window no answer')

/** The sections of the server's data the stand-in reads. */
export type TaskWindowWorkspace = Pick<
  Whole,
  | 'auth_user_id'
  | 'myProfileIds'
  | 'profiles'
  | 'projects'
  | 'access'
  | 'teamAccess'
  | 'teams'
  | 'teamMembers'
  | 'issues'
  | 'issueLabels'
  | 'issueSubs'
  | 'links'
  | 'attachments'
  | 'unheld'
>

type Task = Whole['issues'][number]

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byCreation = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  order(a.created_at, b.created_at) || order(a.id, b.id)
const byNumber = (a: { num: number; id: string }, b: { num: number; id: string }) =>
  a.num - b.num || order(a.id, b.id)

const UNAVAILABLE = { state: 'unavailable' as const }

/** What the window's read `name` answers for `args` while the server holds
    `whole`, or TASK_WINDOW_NO_ANSWER for one that never answers; throws a
    failure. */
export function taskWindowStandIn(
  whole: TaskWindowWorkspace,
  name: TaskWindowRead,
  args: Record<string, unknown>,
  force?: ForcedTaskWindow,
): unknown {
  if (force === 'loading') return TASK_WINDOW_NO_ANSWER
  if (force === 'failed') throw new Error(`${name} fails, as the stand-in was asked`)
  if (force === 'unavailable') return UNAVAILABLE
  const orgId = String(args.org_id ?? '')
  const sight = seatSight(whole)
  const projects = new Map(whole.projects.map((p) => [p.id, p]))
  /* the seat's level on the project with this id, null where it does not
     see it */
  const level = (projectId: string) =>
    sight.visible(orgId, projectId) ? (sight.level(orgId, projectId) ?? 'viewer') : null
  /* whether the project with this id and its parent are live */
  const live = (projectId: string) => {
    const p = projects.get(projectId)
    const parent = p?.parent_id === undefined ? undefined : projects.get(p.parent_id)
    return p !== undefined && p.archived_at === undefined && parent?.archived_at === undefined
  }
  const active = whole.issues.filter(
    (t) => t.archived_at === undefined && t.org_id === orgId && live(t.project_id),
  )
  const shown = new Map(
    active.filter((t) => level(t.project_id) !== null).map((t) => [t.id, t] as const),
  )
  const parents = new Set(active.flatMap((t) => (t.parent_id ? [t.parent_id] : [])))
  /* a task the whole holds as a list row of the window, with its group
     fact and the caller's level on its project */
  const short = (row: Task) => {
    const {
      description: _text,
      parent_id: _parent,
      has_hidden_parent: _hiddenParent,
      has_hidden_subtasks: _hidden,
      ...rest
    } = row
    return {
      ...rest,
      has_subtasks: row.has_subtasks === true || parents.has(row.id),
      level: level(row.project_id) as string,
    }
  }
  /* the active task with this id the caller may open, or undefined */
  const opened = (id: string) => shown.get(id)

  if (name === 'taskWindow:task') {
    const named = typeof args.ref === 'string' ? parseIssueRef(args.ref) : null
    if (named === null) return UNAVAILABLE
    const every = [...whole.issues, ...(whole.unheld?.issues ?? [])]
    const task = every.find(
      (t) => t.org_id === orgId && ('uuid' in named ? t.id === named.uuid : t.num === named.num),
    )
    if (task === undefined) return UNAVAILABLE
    const labels = whole.issueLabels.filter((row) => row.issue_id === task.id)
    if (task.archived_at !== undefined) {
      const project = projects.get(task.project_id)
      const parent = project?.parent_id ? projects.get(project.parent_id) : undefined
      const at = level(task.project_id)
      if (project === undefined || at === null) return UNAVAILABLE
      const {
        description,
        parent_id: _parent,
        has_hidden_parent: _hiddenParent,
        has_hidden_subtasks: _hidden,
        has_subtasks,
        ...page
      } = task
      return {
        state: 'archived',
        task: { ...page, archived_at: task.archived_at, is_group: has_subtasks === true },
        description,
        labels,
        level: at,
        project_archived: project.archived_at !== undefined || parent?.archived_at !== undefined,
      }
    }
    if (opened(task.id) === undefined) return UNAVAILABLE
    const kids = active.filter((row) => row.parent_id === task.id).sort(byNumber)
    const incomplete = force === 'incomplete'
    const parent = task.parent_id ? shown.get(task.parent_id) : undefined
    const me = new Set(whole.myProfileIds)
    return {
      state: 'ok',
      task: {
        ...task,
        has_subtasks: task.has_subtasks === true || kids.length > 0,
        ...(incomplete ? { has_hidden_subtasks: true } : {}),
      },
      level: level(task.project_id),
      labels,
      follow:
        whole.issueSubs.find((row) => row.issue_id === task.id && me.has(row.profile_id)) ?? null,
      parent: parent ? { ...short(parent), has_subtasks: true } : null,
      subtasks: {
        rows: (incomplete ? kids.slice(0, Math.floor(kids.length / 2)) : kids).map(short),
        complete: !incomplete,
      },
    }
  }

  const task = opened(String(args.issue_id ?? ''))
  if (task === undefined) return UNAVAILABLE
  if (name === 'taskWindow:links') {
    const other = (link: { source_id: string; target_id: string }) =>
      link.source_id === task.id ? link.target_id : link.source_id
    const all = whole.links
      .filter(
        (link) =>
          (link.source_id === task.id || link.target_id === task.id) && shown.has(other(link)),
      )
      .sort(byCreation)
    const incomplete = force === 'incomplete'
    const links = incomplete ? all.slice(0, Math.floor(all.length / 2)) : all
    const ends = [...new Set(links.map(other))]
    return {
      state: 'ok',
      links,
      tasks: ends.map((id) => short(shown.get(id) as Task)),
      complete: !incomplete,
    }
  }
  const rows = whole.attachments.filter((row) => row.issue_id === task.id).sort(byCreation)
  const incomplete = force === 'incomplete'
  const kept = incomplete ? rows.slice(0, Math.floor(rows.length / 2)) : rows
  return {
    state: 'ok',
    rows: kept,
    count: kept.filter((row) => row.dropped_at === undefined).length,
    complete: !incomplete,
  }
}
