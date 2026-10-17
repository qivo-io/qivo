/* Milestone rules shared by every milestone write (projects.ts, roadmap.ts,
 * and the REST and MCP milestone actions in machine/projects.ts). A milestone
 * lives on the top-level project whose roadmap shows it, its name is not
 * blank, and its week is one real calendar day.
 *
 * Refusals read the same on every surface. A project or milestone the caller
 * cannot see, in their organization or another, reads as not found. One they
 * can see without User access on the project that stores the milestone is
 * forbidden. Callers resolve the caller's seat and check the billing pause
 * (orgMutation, the roadmap writer, asMachineCaller). A machine caller passes
 * its `provenance`, which signs the activity row. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { canSeeProject, hasProjectLevel, rootMetaOf } from '../lib/access'
import { byId, insertUnique } from '../lib/db'
import { badRequest, forbidden, notFound, require, rule } from '../lib/functions'
import { NAME_MAX, nameTooLong } from '../lib/textLimits'
import { logActivity, signedDetail } from './activity'
import { weekLabel } from './orgs'
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

/** cleanMilestoneWeek with the machine surfaces' field name, `date`. */
export function cleanMilestoneDate(raw: unknown): string {
  return calendarDay(raw, {
    shape: 'date must be YYYY-MM-DD',
    date: 'date must be a valid calendar date',
  })
}

export const MILESTONE_NAME_TOO_LONG = `a milestone name must be at most ${NAME_MAX} characters`

/** A milestone name as stored: trimmed, and refused when nothing is left, as
 * the app's Milestones window does before it saves, or when it has more than
 * NAME_MAX code points. A name equal to `current`, the milestone's stored
 * one, passes, so a milestone named before the cap keeps its name through a
 * move that resends it. */
export function cleanMilestoneName(raw: string, current?: string): string {
  const name = raw.trim()
  if (name === '') throw badRequest('a milestone name cannot be blank')
  if (name !== current && nameTooLong(name)) throw rule(MILESTONE_NAME_TOO_LONG)
  return name
}

/* The organization whose calendar labels a milestone's week. */
async function orgOf(ctx: QueryCtx, me: Doc<'profiles'>): Promise<Doc<'organizations'>> {
  const org = await byId(ctx, 'organizations', me.org_id)
  require(org !== null, notFound('organization not found'))
  return org
}

/**
 * Adds a milestone named against `projectId` to the top-level project that
 * stores it (milestoneTarget) and narrates it. Narration details embed
 * weekLabel computed against the organization's settings, frozen at write
 * time (trap T1).
 */
export async function addMilestoneCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    id: string
    projectId: string
    name: string
    week: string
    now: string
    provenance?: string
  },
): Promise<Doc<'milestones'>> {
  const { me, id, now } = a
  const home = await milestoneTarget(ctx, me, a.projectId)
  const week = cleanMilestoneWeek(a.week)
  const name = cleanMilestoneName(a.name)
  await insertUnique(
    ctx,
    'milestones',
    'by_uuid',
    { id },
    { id, project_id: home.id, name, week, created_at: now },
    badRequest('a milestone with this id already exists'),
  )
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'added milestone',
    target_type: 'milestone',
    target_id: id,
    label: name,
    detail: signedDetail(`at ${weekLabel(week, await orgOf(ctx, me))}`, a.provenance),
    project_id: home.id,
    ts: now,
  })
  const row = await byId(ctx, 'milestones', id)
  require(row !== null, notFound('milestone not found'))
  return row
}

/**
 * Renames or moves a milestone the caller may change (changeableMilestone)
 * and narrates it. The verb names what actually CHANGED, so a pure rename
 * does not read as a move (bc022c2:3536-3562, trap T15); a submit that
 * changes nothing still narrates the bare 'updated milestone', as the app's
 * dialog always sends both fields.
 */
export async function updateMilestoneCore(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    milestone: Doc<'milestones'>
    patch: { name?: string; week?: string }
    now: string
    provenance?: string
  },
): Promise<Doc<'milestones'>> {
  const { me, milestone, now } = a
  const db: Partial<Doc<'milestones'>> = {}
  if (a.patch.name !== undefined) db.name = cleanMilestoneName(a.patch.name, milestone.name)
  if (a.patch.week !== undefined) db.week = cleanMilestoneWeek(a.patch.week)
  const weekChanged = db.week !== undefined && db.week !== milestone.week
  const renamed = db.name !== undefined && db.name !== milestone.name
  if (Object.keys(db).length > 0) await ctx.db.patch(milestone._id, db)
  const name = db.name ?? milestone.name
  const org = await orgOf(ctx, me)
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: weekChanged ? 'moved milestone' : renamed ? 'renamed milestone' : 'updated milestone',
    target_type: 'milestone',
    target_id: milestone.id,
    label: name,
    detail: signedDetail(
      weekChanged
        ? `from ${weekLabel(milestone.week, org)} to ${weekLabel(db.week as string, org)}` +
            (renamed ? ` (renamed from “${milestone.name}”)` : '')
        : renamed
          ? `from “${milestone.name}”`
          : undefined,
      a.provenance,
    ),
    project_id: milestone.project_id,
    ts: now,
  })
  const row = await ctx.db.get(milestone._id)
  require(row !== null, notFound('milestone not found'))
  return row
}

/** Deletes a milestone the caller may change and narrates it. */
export async function removeMilestoneCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; milestone: Doc<'milestones'>; now: string; provenance?: string },
): Promise<void> {
  const { me, milestone, now } = a
  await ctx.db.delete(milestone._id)
  await logActivity(ctx, {
    org_id: me.org_id,
    actor_id: me.id,
    verb: 'deleted milestone',
    target_type: 'milestone',
    target_id: milestone.id,
    label: milestone.name,
    detail: signedDetail(undefined, a.provenance),
    project_id: milestone.project_id,
    ts: now,
  })
}
