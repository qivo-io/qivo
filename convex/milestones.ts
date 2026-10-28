/* The app's milestone reads, bounded on the server (model/milestones.ts
 * readMilestones, visibleMilestone). Overview, the Milestones window, the
 * Roadmap and Team sync read their milestones here, a batch or a range of
 * days at a time, instead of every milestone of every project the
 * workspace's projects part sends. The writes are in projects.ts.
 *
 * Each read names projects of any of the caller's organizations and judges
 * each with the caller's seat in its own organization. An unknown, foreign,
 * invisible, archived or deleted project or milestone reads as absent and
 * raises nothing, so an answer tells nothing about what the caller cannot
 * list. Only arguments out of shape are refused, with `bad_request`, and a
 * search past LIMITS.search with that limit's sentence. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedQuery, badRequest } from './lib/functions'
import { limitedText } from './lib/limitRules'
import { LIMITS } from './lib/limits'
import { rowOf } from './lib/workspaceParts'
import { DOCUMENT_MAX_BYTES } from './model/comments'
import {
  MILESTONE_READ,
  type MilestonePosition,
  milestoneProjects,
  readMilestones,
  visibleMilestone,
} from './model/milestones'
import { shiftDay } from './model/orgs'
import { calendarDay, dateShaped } from './model/taskValues'

/** A milestone as the app holds it, as the projects part sends it. */
type MilestoneRow = Omit<Doc<'milestones'>, '_id' | '_creationTime'>

/* A position a batch answers as `next`, to pass back as `after`. */
const vPosition = v.object({ week: v.string(), key: v.string(), id: v.string() })

/* `projects` when it names at most MILESTONE_READ.projects ids. */
function projectsArg(projects: readonly string[]): readonly string[] {
  if (projects.length > MILESTONE_READ.projects)
    throw badRequest(`projects can name at most ${MILESTONE_READ.projects} projects`)
  return projects
}

/* A day argument, one real calendar day. */
const dayArg = (name: string, value: string): string =>
  calendarDay(value, {
    shape: `${name} must be YYYY-MM-DD`,
    date: `${name} must be a valid calendar date`,
  })

/* `after` when it has the shape of a position a batch answers. Its day is
 * checked for shape only, as a day stored before 2026-10-16 can be one that
 * does not exist. Its key and id may be any text of at most
 * DOCUMENT_MAX_BYTES characters. A milestone made before 2026-10-19 can
 * have an id that is not a UUID, no stored id is longer, and a name key is
 * longer only for a name of more than 50,000 characters. */
function afterArg(after: MilestonePosition): MilestonePosition {
  if (
    !dateShaped(after.week) ||
    after.key.length > DOCUMENT_MAX_BYTES ||
    after.id.length > DOCUMENT_MAX_BYTES
  )
    throw badRequest('after must be the next of an earlier batch')
  return after
}

/**
 * One batch of one section of the milestones of `projects`, as Overview,
 * the Milestones window and Team sync list them. 'upcoming' holds those
 * shown on `from` or later, nearest first, and 'past' those shown before
 * it, newest first.
 * `from` is the first day of the caller's current week in the app's week
 * grid, so a milestone is upcoming exactly when the app draws it in the
 * current week or later, a guest project of an organization whose weeks
 * start on another day included. A sub-project stands for its top-level
 * project, and a project is listed once however often it is named.
 *
 * `search`, at most LIMITS.search long, keeps the milestones whose name
 * holds every word of it, in any order, ignoring case and accents. `after`
 * is the `next` of an earlier batch of the same section, and `limit` from 1
 * to MILESTONE_READ.rows. `next` is null only once no milestone of the
 * section follows. `stopped` is null for a full batch, or the stored day the
 * read reached when its budget ran out first; the rows are then every match
 * up to it, possibly none, and `next` goes on from there. A first upcoming
 * batch also says, in `past`, whether one of the projects holds a past
 * milestone, so an empty upcoming list does not read as a project without
 * history.
 */
export const section = authedQuery({
  args: {
    projects: v.array(v.string()),
    from: v.string(),
    side: v.union(v.literal('upcoming'), v.literal('past')),
    search: v.optional(v.string()),
    after: v.optional(vPosition),
    limit: v.number(),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{
    rows: MilestoneRow[]
    next: MilestonePosition | null
    stopped: string | null
    past?: boolean
  }> => {
    const projects = projectsArg(a.projects)
    if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MILESTONE_READ.rows)
      throw badRequest(`limit must be a whole number from 1 to ${MILESTONE_READ.rows}`)
    const from = dayArg('from', a.from)
    const after = a.after === undefined ? null : afterArg(a.after)
    const search = limitedText(LIMITS.search, a.search ?? '')
    const batch = await readMilestones(
      ctx,
      await milestoneProjects(ctx, ctx.myProfiles, projects),
      {
        span: a.side === 'upcoming' ? { from, order: 'asc' } : { to: from, order: 'desc' },
        after,
        search,
        limit: a.limit,
        ...(a.side === 'upcoming' && after === null ? { pastBefore: from } : {}),
      },
    )
    return {
      rows: batch.rows.map(rowOf),
      next: batch.next,
      stopped: batch.stopped,
      ...(batch.past === undefined ? {} : { past: batch.past }),
    }
  },
})

/**
 * The milestones of `projects` the app shows on a day in [from, to), in
 * upcoming order, as the Roadmap draws its window (from its first week's
 * first day to the day after its last week) and Team sync this week and
 * next. `to` comes after `from`, at most LIMITS.roadmapWeeks.max weeks
 * later. Projects are read as `section` reads them. `next` and `stopped` are
 * null when every milestone in the range is there. When the read's budget
 * ran out first, the rows are every milestone up to the position `next`
 * names, `stopped` is its stored day, and a call with `after: next` and the
 * same projects and days goes on from there, without answering a milestone
 * twice or skipping one.
 */
export const between = authedQuery({
  args: {
    projects: v.array(v.string()),
    from: v.string(),
    to: v.string(),
    after: v.optional(vPosition),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ rows: MilestoneRow[]; next: MilestonePosition | null; stopped: string | null }> => {
    const projects = projectsArg(a.projects)
    const from = dayArg('from', a.from)
    const to = dayArg('to', a.to)
    if (to <= from) throw badRequest('to must be after from')
    const weeks = LIMITS.roadmapWeeks.max
    if (to > shiftDay(from, 7 * weeks))
      throw badRequest(`to can be at most ${weeks} weeks after from`)
    const after = a.after === undefined ? null : afterArg(a.after)
    const batch = await readMilestones(
      ctx,
      await milestoneProjects(ctx, ctx.myProfiles, projects),
      { span: { from, to, order: 'asc' }, after, search: '', limit: Infinity },
    )
    return { rows: batch.rows.map(rowOf), next: batch.next, stopped: batch.stopped }
  },
})

/**
 * The milestone `id`, the top-level project that stores it and whether the
 * caller may rename, move or delete it (User access on that project), for
 * the Milestones window to open on, or null. A milestone the caller cannot
 * see answers null, and so does one stored on a sub-project before
 * 2026-10-14 or one of an archived project, which the app does not show
 * (model/milestones.ts visibleMilestone).
 */
export const get = authedQuery({
  args: { id: v.string() },
  handler: async (
    ctx,
    { id },
  ): Promise<{
    row: MilestoneRow
    project: Pick<Doc<'projects'>, 'id' | 'name' | 'key' | 'org_id'>
    can_write: boolean
  } | null> => {
    const found = await visibleMilestone(ctx, ctx.myProfiles, id)
    if (found === null) return null
    const { project } = found
    return {
      row: rowOf(found.milestone),
      project: { id: project.id, name: project.name, key: project.key, org_id: project.org_id },
      can_write: found.canWrite,
    }
  },
})
