/* The plan_* load family. Both walks disclose busy TIME from projects the
 * caller cannot see, while the projection strips the identity. The fence is
 * in the filter, the anonymization in the projection — kept distinct here.
 *
 * Shared fence (both walks):
 *   scheduled (start_week set — the 0037 envelope CHECK means end_week too),
 *   ordinary task (no active subtasks), status <> done (0073), not paused
 *   (#310: its owner is free for other work; a paused Review task drops out
 *   too), issue not archived (0070), project not archived (0106), owner
 *   (lib/review.ts: the reviewer while In Review with one set, else the
 *   assignee) is a profile of THIS org (0065 — deliberately NO active and NO
 *   kind test: an inactive person's or an agent's scheduled work still counts
 *   as load), and the disclosure trio (0085 guests / 0102 viewers):
 *   isOrgStaff(caller) OR can_see_project(issue) OR the caller owns the row.
 *   So staff get every qualifying row (invisible ones anonymized), while
 *   guests/viewers get only visible-or-own rows — other people's hidden work
 *   does not arrive at all, not even anonymously.
 *
 * org_load ONLY adds `remaining_hours > 0`; assigneeLoad has NO remaining
 * filter — unestimated/zero-remaining scheduled rows are included. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import { authedQuery } from './lib/functions'
import { taskOwnerId } from './lib/review'
import { type OrgProjectView, orgProjectView } from './lib/visibility'
import { subtaskParentIds } from './model/issues'

/* rows.orgLoad element, field names verbatim (planner.ts:90): `remaining`,
 * NOT remaining_hours. */
export type OrgLoadRow = {
  issue_id: string | null
  // the effective owner: the reviewer while In Review with one set, else the assignee (#314)
  owner_id: string
  start_week: string
  end_week: string
  remaining: number
  remaining_set_at: string | null
}

/* plan_assignee_load's wire shape — the SQL column names exactly. The client
 * never reads `title` today, but it is in the SQL contract; kept. */
export type AssigneeLoadRow = {
  issue_id: string | null
  title: string | null
  project_id: string | null
  project_name: string | null
  start_week: string
  end_week: string
  remaining: number | null
  remaining_set_at: string | null
  visible: boolean
}

/* plan_org_load for one org. orgProfileIds = ALL profile ids of the org
 * (active + inactive + agents) — the 0065 owner fence. The snapshot passes
 * its active org task read so planning and grouping do not scan it again. */
export function orgLoadRows(
  me: Doc<'profiles'>,
  view: OrgProjectView,
  orgProfileIds: Set<string>,
  issues: readonly Doc<'issues'>[],
): OrgLoadRow[] {
  const staff = isOrgStaff(me)
  const rows: OrgLoadRow[] = []
  const groupIds = subtaskParentIds(issues)
  for (const i of issues) {
    if (groupIds.has(i.id)) continue
    // groups are skipped above, so the rule's isGroup default holds
    const owner = taskOwnerId(i)
    if (owner === undefined) continue
    if (i.start_week === undefined || i.end_week === undefined) continue
    if (i.status === 'done' || i.paused) continue
    const remaining = i.remaining_hours ?? 0
    if (!(remaining > 0)) continue
    if (i.archived_at !== undefined) continue
    const project = view.byUuid.get(i.project_id)
    if (project === undefined || project.archived_at !== undefined) continue
    if (!orgProfileIds.has(owner)) continue
    const vis = view.visible(i.project_id)
    if (!(staff || vis || owner === me.id)) continue
    rows.push({
      issue_id: vis ? i.id : null,
      owner_id: owner,
      start_week: i.start_week,
      end_week: i.end_week,
      remaining,
      remaining_set_at: i.remaining_set_at ?? null,
    })
  }
  return rows
}

async function assigneeLoadRows(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  view: OrgProjectView,
  assigneeId: string,
): Promise<AssigneeLoadRow[]> {
  const staff = isOrgStaff(me)
  const rows: AssigneeLoadRow[] = []
  const issues = await ctx.db
    .query('issues')
    .withIndex('by_org_archived', (q) => q.eq('org_id', me.org_id).eq('archived_at', undefined))
    .collect()
  const groupIds = subtaskParentIds(issues)
  for (const i of issues) {
    if (groupIds.has(i.id)) continue
    if (taskOwnerId(i) !== assigneeId) continue
    if (i.start_week === undefined || i.end_week === undefined) continue
    if (i.status === 'done' || i.paused) continue
    if (i.archived_at !== undefined) continue
    const project = view.byUuid.get(i.project_id)
    if (project === undefined || project.archived_at !== undefined) continue
    const vis = view.visible(i.project_id)
    if (!(staff || vis || assigneeId === me.id)) continue
    rows.push({
      issue_id: vis ? i.id : null,
      title: vis ? i.title : null,
      project_id: vis ? i.project_id : null,
      project_name: vis ? project.name : null,
      start_week: i.start_week,
      end_week: i.end_week,
      remaining: i.remaining_hours ?? null,
      remaining_set_at: i.remaining_set_at ?? null,
      visible: vis,
    })
  }
  return rows
}

/* The person whose owned load: the assignee, or the reviewer while the task
 * is In Review (lib/review.ts). The arg keeps its `assignee_id` name. The
 * org is resolved server-side as that person's own org (the client's
 * `rows.profiles.get(uuid).org_id || HOME_ORG` fallback wart, removed).
 * Parity with the SQL fences: an unknown person, or a caller holding no
 * active seat in that person's org, yields an EMPTY ARRAY, not an error. */
export const assigneeLoad = authedQuery({
  args: { assignee_id: v.string() },
  handler: async (ctx, { assignee_id }): Promise<AssigneeLoadRow[]> => {
    const assignee = await byId(ctx, 'profiles', assignee_id)
    if (assignee === null) return []
    const me = ctx.myProfiles.get(assignee.org_id)
    if (me === undefined) return []
    const view = await orgProjectView(ctx, me)
    return await assigneeLoadRows(ctx, me, view, assignee.id)
  },
})
