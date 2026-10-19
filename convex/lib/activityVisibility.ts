/* Which task activity rows a member receives, the app's rule. The task
 * window (snapshot.ts commentThread), REST and MCP apply it to one task's
 * history (taskActivity below). Organization admins receive every task row;
 * memberSeesActivity decides for everyone else. Rows about anything but a
 * task reach no client; admins read them in the organization export.
 * memberSeesActivity and withoutLegacySubtaskCount stay exported because
 * scripts/benchmark-backend.mjs loads an earlier snapshot.ts against this
 * module. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { namedTaskNums, SUBJECT_ACTIVITY_CAP } from '../model/activity'
import { usedMoreThan } from './db'
import { type OrgProjectView, orgProjectView } from './visibility'
import type { Shown } from './workingSet'

/* A project move written before related_project_id existed names a
 * destination that cannot be checked (model/issues.ts moveIssueCore writes
 * "to the <name> sub-project"; status and parent moves say "from" and
 * "under"), so only admins receive it. */
const isUnrecordedProjectMove = (ev: Doc<'activity_events'>): boolean =>
  ev.verb === 'moved' && ev.related_project_id === undefined && !!ev.detail?.startsWith('to the ')

/* Task archive rows used to say 'with N subtasks', counting subtasks in
 * projects a reader may not access (model/issues.ts archiveIssueCore no
 * longer writes it). Members other than admins get such rows without it. */
const LEGACY_SUBTASK_COUNT = /^with \d+ subtasks?$/
export function withoutLegacySubtaskCount(ev: Doc<'activity_events'>): Doc<'activity_events'> {
  if (ev.target_type !== 'issue' || ev.verb !== 'archived') return ev
  if (!LEGACY_SUBTASK_COUNT.test(ev.detail ?? '')) return ev
  const { detail: _count, ...rest } = ev
  return rest
}

/* Members other than organization admins receive a task row only if the
 * task is in their working set, which keeps out the history of a task that
 * was deleted, archived or moved to a project the member cannot access, and
 * they can access every project the row names: the project it was filed
 * under and its related project, such as a move's destination. Seeing a
 * parent only to reach one of its sub-projects is not access. Deleting a
 * project clears project_id on its rows (model/deletedItems.ts
 * purgeActivity), so a task that moved out first keeps those rows. A row that
 * names another task (a parent change or a link) also needs access to that
 * task where it is now; one naming a deleted task reaches admins only. Rows
 * written since numbering list the tasks they name in named_task_nums; one
 * with a seq but no list fails closed, and older rows are parsed
 * (model/activity.ts namedTaskNums). Rows about anything but a task never
 * reach a member. */
export async function memberSeesActivity(
  ev: Doc<'activity_events'>,
  a: {
    view: OrgProjectView
    /* whether the task is in the member's working set */
    inWorkingSet: Shown
    /* the current project of the org's task with this number, if any */
    taskProject: (num: number) => Promise<string | undefined>
  },
): Promise<boolean> {
  if (ev.target_type !== 'issue') return false
  if (ev.related_project_id !== undefined && !a.view.accessible(ev.related_project_id)) return false
  if (!a.inWorkingSet(ev.target_id)) return false
  if (isUnrecordedProjectMove(ev)) return false
  if (ev.project_id !== undefined && !a.view.accessible(ev.project_id)) return false
  // new rows decide by their stored list; one written without it fails closed
  const named = ev.named_task_nums ?? (ev.seq === undefined ? namedTaskNums(ev) : null)
  if (named === null) return false
  for (const num of named) {
    const projectId = await a.taskProject(num)
    if (projectId === undefined || !a.view.accessible(projectId)) return false
  }
  return true
}

/** How full a member's taskActivity read may get while it looks up the
 * tasks its rows name (lib/db.ts usedMoreThan). Each lookup reads a whole
 * task, and a row can name two. Past `room`, a row naming a task not yet
 * looked up is left out, so the read fails closed instead of failing on
 * Convex's limits. The rest serves the caller: commentThread has read its
 * comments already, and REST and MCP read one profile per actor next
 * (machine/records.ts activityOut). Tests may lower it. */
export const NAMED_TASK_ROOM = { room: 0.8 }

/**
 * The activity rows about `issue` that `me` receives, oldest first by ts,
 * the history the task window shows beside its comments. The caller has
 * already resolved a task `me` can read (lib/core.ts findIssue), which counts
 * as the task being shown, as every machine read counts the tasks it can
 * read, archived ones included. It reads the task's own newest
 * SUBJECT_ACTIVITY_CAP rows through by_target, which is every row the task
 * keeps besides rows stored before numbering beyond that. Organization admins
 * receive all of them; other members get the rows memberSeesActivity allows,
 * without legacy subtask counts. For members it also reads the
 * organization's projects and grants (lib/visibility.ts orgProjectView) and
 * one task for each distinct number the rows name, until the read passes
 * NAMED_TASK_ROOM; rows naming a task it could not look up are left out.
 */
export async function taskActivity(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
): Promise<Doc<'activity_events'>[]> {
  const newest = await ctx.db
    .query('activity_events')
    .withIndex('by_target', (q) =>
      q.eq('org_id', issue.org_id).eq('target_type', 'issue').eq('target_id', issue.id),
    )
    .order('desc')
    .take(SUBJECT_ACTIVITY_CAP)
  // oldest first by ts as before; the sort is stable, so ties keep index order
  const rows = newest.reverse().sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
  if (me.org_role === 'admin' || rows.length === 0) return rows
  const view = await orgProjectView(ctx, me)
  const projects = new Map<number, Promise<string | undefined>>()
  const taskProject = async (num: number): Promise<string | undefined> => {
    let found = projects.get(num)
    if (found === undefined) {
      // no room to look it up: unknown, so the row is left out
      if (await usedMoreThan(ctx, NAMED_TASK_ROOM.room)) return undefined
      found = ctx.db
        .query('issues')
        .withIndex('by_org_num', (q) => q.eq('org_id', issue.org_id).eq('num', num))
        .first()
        .then((task) => task?.project_id)
      projects.set(num, found)
    }
    return await found
  }
  const out: Doc<'activity_events'>[] = []
  for (const ev of rows) {
    const sees = await memberSeesActivity(ev, {
      view,
      inWorkingSet: (taskId) => taskId === issue.id,
      taskProject,
    })
    if (sees) out.push(withoutLegacySubtaskCount(ev))
  }
  return out
}
