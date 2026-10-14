/* Milestone rules shared by every milestone write (projects.ts, roadmap.ts,
 * and any REST or MCP milestone action). A milestone lives on the top-level
 * project whose roadmap shows it, and its week is one real calendar day.
 *
 * Refusals read the same on every surface. A project or milestone the caller
 * cannot see, in their organization or another, reads as not found. One they
 * can see without User access on the project that stores the milestone is
 * forbidden. Callers resolve the caller's seat and check the billing pause
 * (orgMutation, the roadmap writer, asMachineCaller). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canSeeProject, hasProjectLevel, rootMetaOf } from '../lib/access'
import { byId } from '../lib/db'
import { forbidden, notFound, rule } from '../lib/functions'
import { calendarDay } from './taskValues'

/* Milestone policies are User level (0078:497, member→user). */
async function assertMilestoneWriter(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<void> {
  if (!(await hasProjectLevel(ctx, me, project.id, 'user'))) {
    throw forbidden('no write access to this project')
  }
}

/** The top-level project that stores a new milestone `me` names against
 * `projectId`. A sub-project folds up to it, as in the app, and `me` needs
 * User access there, so a grant on a sub-project alone is not enough. An
 * archived named or top-level project is refused with the arrival sentence
 * (milestones_project_archived_guard, 0106:148). */
export async function milestoneTarget(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  projectId: string,
): Promise<Doc<'projects'>> {
  const named = await byId(ctx, 'projects', projectId)
  if (named === null || !(await canSeeProject(ctx, me, named))) {
    throw notFound('project not found')
  }
  const home = await rootMetaOf(ctx, named)
  await assertMilestoneWriter(ctx, me, home)
  if (named.archived_at !== undefined || home.archived_at !== undefined) {
    throw rule('that project is archived — restore it first')
  }
  return home
}

/** An existing milestone `me` may rename, move or delete, with the project
 * that stores it. `me` needs User access on that project. */
export async function changeableMilestone(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  id: string,
): Promise<{ milestone: Doc<'milestones'>; project: Doc<'projects'> }> {
  const milestone = await byId(ctx, 'milestones', id)
  const project = milestone && (await byId(ctx, 'projects', milestone.project_id))
  if (!milestone || !project || !(await canSeeProject(ctx, me, project))) {
    throw notFound('milestone not found')
  }
  await assertMilestoneWriter(ctx, me, project)
  return { milestone, project }
}

/** Validates a milestone week, one real calendar day as YYYY-MM-DD. The app
 * sends the picked day, usually the first day of a week. */
export function cleanMilestoneWeek(raw: string): string {
  return calendarDay(raw, {
    shape: 'a milestone week is an ISO date (YYYY-MM-DD)',
    date: 'a milestone week must be a valid calendar date',
  })
}
