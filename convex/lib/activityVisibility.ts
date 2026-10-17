/* Which activity rows a member receives, the app's rule. The snapshot
 * (convex/snapshot.ts) applies it to the organization feed, and REST and MCP
 * apply it to one task's history (taskActivity below). Organization admins
 * receive every row; memberSeesActivity decides for everyone else. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { namedTaskNums } from '../model/activity'
import { canLeadTeams } from './access'
import type { ActivityTarget } from './enums'
import { type OrgProjectView, orgProjectView } from './visibility'
import type { Shown } from './workingSet'

// Rows about people, labels and the organization itself, not a project.
const NON_PROJECT_ACTIVITY = new Set<ActivityTarget>(['user', 'org'])

/* A project move written before related_project_id existed names a
 * destination that cannot be checked (model/issues.ts moveIssueCore writes
 * "to the <name> sub-project"; status and parent moves say "from" and
 * "under"), so only admins receive it. */
const isUnrecordedProjectMove = (ev: Doc<'activity_events'>): boolean =>
  ev.verb === 'moved' && ev.related_project_id === undefined && !!ev.detail?.startsWith('to the ')

// The verbs teams.ts writes on membership rows, which carry team_id.
const TEAM_VERBS = new Set(['added', 'removed', 'made', 'demoted'])

/* Deleting a team used to clear team_id on its membership rows. Such a row
 * cannot be told apart from profiles.ts's roster rows ('added' to the
 * organization, 'removed' from it), because a team may carry the same name.
 * Failing closed, every person row with one of these verbs and no team_id
 * reaches admins only. */
const isUnscopedTeamRow = (ev: Doc<'activity_events'>): boolean =>
  ev.target_type === 'user' && ev.team_id === undefined && TEAM_VERBS.has(ev.verb)

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

/* tokens.ts narrates agent key creation and revocation against the agent,
 * naming the key, and apiAccess.ts narrates an admin's revocation of any
 * credential against its owner, naming the token or app. Only admins manage
 * and list other people's credentials, so only admins receive these rows. */
const REVOKED_CREDENTIAL = ['the key “', 'a personal token “', 'the connection to “']
const isCredentialRow = (ev: Doc<'activity_events'>): boolean =>
  ev.target_type === 'user' &&
  ((ev.verb === 'created' && !!ev.detail?.startsWith('a new key “')) ||
    (ev.verb === 'revoked' && REVOKED_CREDENTIAL.some((start) => !!ev.detail?.startsWith(start))))

/* Members other than organization admins receive an activity row only if
 * they can access every project it names: the project it was filed under
 * and its related project, such as a move's destination. Seeing a parent
 * only to reach one of its sub-projects is not access. A task row also needs
 * the task in the working set, which keeps out the history of a task that
 * was deleted, archived or moved to a project the member cannot access.
 * Deleting a project clears project_id on its rows (model/cascade.ts). A task
 * that moved out first keeps those rows for everyone who can access it; the
 * other project and milestone rows reach admins only. A row that names
 * another task by key (a parent change or a link) also needs access to that
 * task where it is now; one naming a deleted task reaches admins only. Team
 * rows reach that team's leaders, who are people (lib/access canLeadTeams).
 * A deleted team's rows keep its id and reach admins only, as do person rows
 * that may be older team rows whose id was cleared (isUnscopedTeamRow) and
 * credential rows. The remaining rows reach every member. */
export async function memberSeesActivity(
  ev: Doc<'activity_events'>,
  a: {
    me: Doc<'profiles'>
    view: OrgProjectView
    /* whether the task is in the member's working set */
    inWorkingSet: Shown
    leaderOf: Map<string, boolean>
    /* the current project of the org's task with this number, if any */
    taskProject: (num: number) => Promise<string | undefined>
  },
): Promise<boolean> {
  if (ev.related_project_id !== undefined && !a.view.accessible(ev.related_project_id)) {
    return false
  }
  if (ev.target_type === 'issue') {
    if (!a.inWorkingSet(ev.target_id)) return false
    if (isUnrecordedProjectMove(ev)) return false
    if (ev.project_id !== undefined && !a.view.accessible(ev.project_id)) return false
    const named = namedTaskNums(ev)
    if (named === null) return false
    for (const num of named) {
      const projectId = await a.taskProject(num)
      if (projectId === undefined || !a.view.accessible(projectId)) return false
    }
    return true
  }
  if (ev.project_id !== undefined) return a.view.accessible(ev.project_id)
  if (!NON_PROJECT_ACTIVITY.has(ev.target_type)) return false
  if (isCredentialRow(ev)) return false
  if (ev.team_id !== undefined) return canLeadTeams(a.me) && a.leaderOf.get(ev.team_id) === true
  return !isUnscopedTeamRow(ev)
}

/**
 * The activity rows about `issue` that `me` receives, oldest first, the
 * history the task window shows beside its comments. The caller has already
 * resolved a task `me` can read (lib/core.ts findIssue), which counts as the
 * task being shown, as every machine read counts the tasks it can read,
 * archived ones included. Organization admins receive every row; other
 * members get the rows memberSeesActivity allows, without legacy subtask
 * counts. The organization keeps its newest 500 rows (model/activity.ts), so
 * the walk is bounded.
 */
export async function taskActivity(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
): Promise<Doc<'activity_events'>[]> {
  const rows: Doc<'activity_events'>[] = []
  const feed = ctx.db
    .query('activity_events')
    .withIndex('by_org_ts', (q) => q.eq('org_id', issue.org_id))
    .order('asc')
  for await (const ev of feed) {
    if (ev.target_type === 'issue' && ev.target_id === issue.id) rows.push(ev)
  }
  if (me.org_role === 'admin') return rows
  const view = await orgProjectView(ctx, me)
  const projects = new Map<number, Promise<string | undefined>>()
  const taskProject = (num: number): Promise<string | undefined> => {
    let found = projects.get(num)
    if (found === undefined) {
      found = ctx.db
        .query('issues')
        .withIndex('by_org_num', (q) => q.eq('org_id', issue.org_id).eq('num', num))
        .first()
        .then((task) => task?.project_id)
      projects.set(num, found)
    }
    return found
  }
  const out: Doc<'activity_events'>[] = []
  for (const ev of rows) {
    const sees = await memberSeesActivity(ev, {
      me,
      view,
      inWorkingSet: (taskId) => taskId === issue.id,
      leaderOf: new Map(),
      taskProject,
    })
    if (sees) out.push(withoutLegacySubtaskCount(ev))
  }
  return out
}
