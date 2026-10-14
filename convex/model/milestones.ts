/* Milestone rules shared by every milestone write (projects.ts, roadmap.ts,
 * and any REST or MCP milestone action). A milestone lives on the top-level
 * project whose roadmap shows it, and its week is one real calendar day. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { rootMetaOf } from '../lib/access'
import { badRequest, rule } from '../lib/functions'

/** The top-level project that stores a new milestone named against `project`.
 * A sub-project folds up to its parent, as in the app. A broken parent chain
 * reads as 'project not found'. Check write access on the result. */
export async function milestoneHome(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>> {
  return await rootMetaOf(ctx, project)
}

/** Refuses a new milestone when the named project or its top-level project is
 * archived (milestones_project_archived_guard, 0106:148). */
export function assertMilestoneArrival(named: Doc<'projects'>, home: Doc<'projects'>): void {
  if (named.archived_at !== undefined || home.archived_at !== undefined) {
    throw rule('that project is archived — restore it first')
  }
}

/** Validates a milestone week, one real calendar day as YYYY-MM-DD. The app
 * sends the picked day, usually the first day of a week. */
export function cleanMilestoneWeek(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest('a milestone week is an ISO date (YYYY-MM-DD)')
  }
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw badRequest('a milestone week must be a valid calendar date')
  }
  return raw
}
