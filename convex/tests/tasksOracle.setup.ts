/* The tasks of a caller's working set as the tests' reference data, which
 * the tests kept when the workspace's tasks part (workspace.tasks) went.
 *
 * tasksOracle answers, for one seat, what the tasks part answered for every
 * one of its windows together: the active tasks of the seat's organization
 * that the seat is shown (lib/workingSet.ts, lib/access.ts Access.holds),
 * each with its text from its description row, its parent's id only when
 * the seat is shown the parent (parentLink), has_subtasks and
 * has_hidden_subtasks from the active subtasks in live projects; the links
 * from each shown task as source whose target the seat is shown; the label
 * assignments, attachment rows and the seat's follows of the shown tasks;
 * and the anonymized load rows of the active tasks the seat is not shown,
 * every such row for staff and only the seat's own for anyone else
 * (lib/loadRows.ts loadRowFor). Rows of an archived task carry a mark
 * (model/archiveMarks.ts) and stay out, and a task restored before its marks
 * were cleared (relations_marked) keeps its marked rows and the marked links
 * to it from a shown source without the flag, as the part sent them.
 *
 * It reads every row whole, with no window, budget or bound, so it serves
 * convex-test fixtures at the design size and no deployment. Access pins
 * belong on the reads the app uses (taskWindow.task, tasks.board,
 * planning.ownerLoads and the others); this oracle only replaces the
 * reference data the parity tests and the published test whole read. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessOf, isOrgStaff } from '../lib/access'
import { byId } from '../lib/db'
import { loadRowFor, type OrgLoadRow } from '../lib/loadRows'
import { taskOwnerId } from '../lib/review'
import { parentLink } from '../lib/workingSet'
import { relationRow, type TaskRow, taskFields } from '../lib/workspaceParts'
import { descriptionOf } from '../model/descriptions'

/** A relation row of table `T` as the app receives one (lib/workspaceParts.ts
 * relationRow). */
type Relation<
  T extends 'issue_links' | 'issue_labels' | 'issue_attachments' | 'issue_subscriptions',
> = Omit<Doc<T>, '_id' | '_creationTime' | 'org_id' | 'task_archived' | 'task_key'>

/** A caller's tasks with their relation rows and the load of the tasks
 * they are not shown, the sections the tasks part sent. */
export type TaskSections = {
  issues: TaskRow[]
  links: Relation<'issue_links'>[]
  issueLabels: Relation<'issue_labels'>[]
  attachments: Relation<'issue_attachments'>[]
  issueSubs: Relation<'issue_subscriptions'>[]
  orgLoad: OrgLoadRow[]
}

/** No task sections, for a caller with no seat. */
export const NO_TASKS: TaskSections = {
  issues: [],
  links: [],
  issueLabels: [],
  attachments: [],
  issueSubs: [],
  orgLoad: [],
}

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/* Hidden load rows in one total order, as the part sorted them. */
function byLoad(a: OrgLoadRow, b: OrgLoadRow): number {
  const keys = (r: OrgLoadRow) => [r.owner_id, r.start_week, r.end_week, r.remaining_set_at ?? '']
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return a.remaining - b.remaining
}

/** The task sections of seat `me` (see the header). Tasks come in the
 * order the part's windows gave them, by window key and then creation. */
export async function tasksOracle(ctx: QueryCtx, me: Doc<'profiles'>): Promise<TaskSections> {
  const active = (
    await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', me.org_id).eq('archived_at', undefined))
      .collect()
  ).sort(
    (a, b) => order(a.window_key ?? '', b.window_key ?? '') || a._creationTime - b._creationTime,
  )
  const access = accessOf(ctx, me)
  const heldOf = new Map<string, boolean>()
  for (const task of active) heldOf.set(task.id, await access.holds(task))
  /* whether the seat is shown the task with this id, active or not */
  const shown = async (id: string): Promise<boolean> => {
    const known = heldOf.get(id)
    if (known !== undefined) return known
    const task = await byId(ctx, 'issues', id)
    const held = task !== null && task.org_id === me.org_id && (await access.holds(task))
    heldOf.set(id, held)
    return held
  }
  const tasks = active.filter((task) => heldOf.get(task.id) === true)
  // the active subtasks in live projects of each active task, and whether
  // the seat cannot see each such subtask's project
  const liveOf = new Map<string, boolean>()
  const live = async (projectId: string) => {
    let known = liveOf.get(projectId)
    if (known === undefined) {
      known = await access.live(projectId)
      liveOf.set(projectId, known)
    }
    return known
  }
  const kids = new Map<string, Doc<'issues'>[]>()
  const hiddenKid = new Set<string>()
  for (const kid of active) {
    if (kid.parent_id === undefined || !(await live(kid.project_id))) continue
    kids.set(kid.parent_id, [...(kids.get(kid.parent_id) ?? []), kid])
    if (!(await access.visible(kid.project_id))) hiddenKid.add(kid.id)
  }

  const issues: TaskSections['issues'] = []
  const links: TaskSections['links'] = []
  const issueLabels: TaskSections['issueLabels'] = []
  const attachments: TaskSections['attachments'] = []
  const issueSubs: TaskSections['issueSubs'] = []
  for (const task of tasks) {
    const flagged = task.relations_marked === true
    // an unflagged task's rows carry no mark; a flagged one keeps its marked
    // rows, as it read them through its own indexes
    const kept = <R extends { task_archived?: true }>(rows: R[]) =>
      flagged ? rows : rows.filter((row) => row.task_archived !== true)
    const ownParent = task.parent_id === undefined ? false : await shown(task.parent_id)
    const own = kids.get(task.id) ?? []
    issues.push({
      ...taskFields(task),
      description: await descriptionOf(ctx.db, task),
      ...parentLink(task, () => ownParent),
      has_subtasks: own.length > 0,
      has_hidden_subtasks: own.some((kid) => hiddenKid.has(kid.id)),
    })
    for (const row of kept(
      await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect(),
    ))
      issueLabels.push(relationRow(row))
    for (const row of kept(
      await ctx.db
        .query('issue_attachments')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect(),
    ))
      attachments.push(relationRow(row))
    for (const link of kept(
      await ctx.db
        .query('issue_links')
        .withIndex('by_source', (q) => q.eq('source_id', task.id))
        .collect(),
    ))
      if (await shown(link.target_id)) links.push(relationRow(link))
    if (flagged)
      for (const link of await ctx.db
        .query('issue_links')
        .withIndex('by_target', (q) => q.eq('target_id', task.id))
        .collect()) {
        if (link.task_archived !== true || !(await shown(link.source_id))) continue
        const source = await byId(ctx, 'issues', link.source_id)
        if (source?.relations_marked !== true) links.push(relationRow(link))
      }
    const follow = await ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id).eq('profile_id', me.id))
      .unique()
    // a flagged task shows its marked follow, an unflagged one only an
    // unmarked follow
    if (follow !== null && (flagged || follow.task_archived !== true))
      issueSubs.push(relationRow(follow))
  }

  // the load of the active tasks the seat is not shown, anonymized
  const staff = isOrgStaff(me)
  const owners = new Map<string, boolean>()
  const orgLoad: OrgLoadRow[] = []
  for (const task of active) {
    if (
      task.start_week === undefined ||
      task.paused ||
      task.status === 'done' ||
      !((task.remaining_hours ?? 0) > 0) ||
      !(staff || taskOwnerId(task) === me.id)
    )
      continue
    if (!(await live(task.project_id)) || (await access.visible(task.project_id))) continue
    const owner = taskOwnerId(task)
    if (owner === undefined) continue
    let inOrg = owners.get(owner)
    if (inOrg === undefined) {
      const p = await byId(ctx, 'profiles', owner)
      inOrg = p !== null && p.org_id === me.org_id
      owners.set(owner, inOrg)
    }
    if (!inOrg) continue
    const row = loadRowFor(task, {
      isGroup: (kids.get(task.id) ?? []).length > 0,
      projectLive: true,
      ownerInOrg: () => true,
      visible: false,
      staff,
      meId: me.id,
    })
    if (row !== null) orgLoad.push(row)
  }
  orgLoad.sort(byLoad)
  return { issues, links, issueLabels, attachments, issueSubs, orgLoad }
}

/** The task sections of every seat in `seats`, joined in seat order, as
 * the app's workspace listed each organization's tasks. */
export async function tasksOracleOf(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
): Promise<TaskSections> {
  const out: TaskSections = {
    issues: [],
    links: [],
    issueLabels: [],
    attachments: [],
    issueSubs: [],
    orgLoad: [],
  }
  for (const seat of seats) {
    const one = await tasksOracle(ctx, seat)
    out.issues.push(...one.issues)
    out.links.push(...one.links)
    out.issueLabels.push(...one.issueLabels)
    out.attachments.push(...one.attachments)
    out.issueSubs.push(...one.issueSubs)
    out.orgLoad.push(...one.orgLoad)
  }
  return out
}
