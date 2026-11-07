/* The app's milestone reads, bounded on the server (model/milestones.ts
 * readMilestones, visibleMilestone). They are meant for Overview, the
 * Milestones window, the Roadmap and Team sync, to read their milestones a
 * batch or a range of days at a time. They are the only way the app reads
 * milestones, since the workspace's projects part sends none
 * (lib/workspaceParts.ts readProjects). The app holds them in its store
 * (src/store/planner.ts P.watchMilestones): the Milestones window opened
 * on a milestone reads it with `get`, the window lists a project's
 * upcoming milestones and, once Past is expanded, its past ones with
 * `section`, the Overview lists its scope's Upcoming and, once expanded, a
 * collapsed Past with `section`, My view's with `mine`, the phone's
 * Roadmap agenda lists the same sections, Team sync's opening reads its
 * next milestone with `section` and those of this week and next with
 * `between`, and the Roadmap reads its flags for the weeks on screen with
 * `between`. The writes are in projects.ts.
 *
 * Each read names projects of any of the caller's organizations and judges
 * each with the caller's seat in its own organization, or, for a section
 * read with `mine`, names none and reads My view's projects, which the
 * server finds from the caller's own tasks. An unknown, foreign,
 * invisible, archived or deleted project or milestone reads as absent and
 * raises nothing, so an answer tells nothing about what the caller cannot
 * list. Arguments out of shape are refused with `bad_request`, a search
 * past LIMITS.search with that limit's sentence, and a read whose projects
 * need more reads than one request allows with MILESTONE_READ_TOO_LARGE,
 * which asks for fewer projects. A `mine` read whose person's work lies in
 * more top-level projects than one read names is refused with
 * MILESTONE_TOO_MANY and LIMITS.milestoneProjects' sentence. A check of the
 * caller's access that a bound of their own reads stopped is refused beside
 * them, with its own reason, `access_unchecked` (lib/access.ts
 * accessUnchecked), as these reads refuse instead of answering for part of
 * their projects. */

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
  mineMilestoneProjects,
  readMilestones,
  visibleMilestone,
} from './model/milestones'
import { shiftDay } from './model/orgs'
import { calendarDay, dateShaped } from './model/taskValues'

/** A milestone as the app holds it, the stored row without its document
    fields. */
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
 * does not exist. Its id may be any text of at most DOCUMENT_MAX_BYTES
 * characters, as a milestone made before 2026-10-19 can have an id that is
 * not a UUID and no stored id is longer. Its key may be any text. nameKey
 * can make a key longer than its name (NFKD turns U+FDFA into 18
 * characters), so only Convex's own limit on arguments holds every key a
 * batch can answer, and a compare stops at the end of the shorter key, so a
 * long one costs no more. */
function afterArg(after: MilestonePosition): MilestonePosition {
  if (!dateShaped(after.week) || after.id.length > DOCUMENT_MAX_BYTES)
    throw badRequest('after must be the next of an earlier batch')
  return after
}

/**
 * One batch of one section of the milestones of `projects`, or with `mine`
 * of My view's, for Overview, the phone's Roadmap agenda, the Milestones
 * window and Team sync to list. 'upcoming' holds those shown
 * on `from` or later, nearest first, and 'past' those shown before it,
 * newest first. The app is to pass as `from` the first day of the caller's
 * current week in its week grid, so a milestone is upcoming exactly when the
 * app draws it in the current week or later, a guest project of an
 * organization whose weeks start on another day included. A day stored
 * before 2026-10-16 that does not exist counts on the day it is shown on,
 * except one whose text sorts too far from it (model/milestones.ts
 * OVERFLOW_DAYS), which can be in neither section. A sub-project stands for
 * its top-level project, and a project is listed once however often it is
 * named.
 *
 * `mine: true`, with `projects` empty, reads the top-level projects above
 * the caller's own tasks by the Reviewer rule across every seat of the
 * login, the projects of My view's health table
 * (model/milestones.ts mineMilestoneProjects), each judged with the
 * caller's seat as a named top-level project is, and answers their ids,
 * sorted, as `projects`, so the app can paint the person's own milestone
 * writes over a `mine` answer.
 * Each call finds them again, and its reads follow the person's own tasks,
 * so Convex runs it again when one of them changes. Past 200 such projects
 * it refuses with MILESTONE_TOO_MANY, and past its own read budget with
 * MILESTONE_READ_TOO_LARGE. `mine` beside named projects is refused with
 * `bad_request` before any read.
 *
 * `search`, at most LIMITS.search long, keeps the milestones whose name
 * holds every word of it, in any order, ignoring case and accents. `after`
 * is the `next` of an earlier batch of the same section, and `limit` from 1
 * to MILESTONE_READ.rows (100). The app asks a first batch, 10 for the
 * Overview's and the agenda's Upcoming and 25 for their Past and the
 * window's sections, and grows `limit` by that batch for each Load more,
 * so one live read holds a section the person grew
 * (src/lib/milestoneSection.ts). `next` is null only once no milestone of
 * the section follows. `stopped` is null for a full batch, or the stored
 * day the read reached when its budget ran out first; the rows are then
 * every match up to it, possibly none, and `next` goes on from there. A
 * position only says where to start among the milestones of the projects
 * the caller can see. A first upcoming batch also says, in `past`, whether
 * one of the projects holds a past milestone, so an empty upcoming list
 * does not read as a project without history.
 */
export const section = authedQuery({
  args: {
    projects: v.array(v.string()),
    mine: v.optional(v.literal(true)),
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
    /** with `mine`, the top-level projects the read listed, sorted */
    projects?: string[]
  }> => {
    if (a.mine === true && a.projects.length > 0)
      throw badRequest('projects must be empty when mine is true')
    const projects = projectsArg(a.projects)
    if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > MILESTONE_READ.rows)
      throw badRequest(`limit must be a whole number from 1 to ${MILESTONE_READ.rows}`)
    const from = dayArg('from', a.from)
    const after = a.after === undefined ? null : afterArg(a.after)
    const search = limitedText(LIMITS.search, a.search ?? '')
    const listed =
      a.mine === true
        ? await mineMilestoneProjects(ctx, ctx.myProfiles)
        : await milestoneProjects(ctx, ctx.myProfiles, projects)
    const batch = await readMilestones(ctx, listed, {
      span: a.side === 'upcoming' ? { from, order: 'asc' } : { to: from, order: 'desc' },
      after,
      search,
      limit: a.limit,
      ...(a.side === 'upcoming' && after === null ? { pastBefore: from } : {}),
    })
    return {
      rows: batch.rows.map(rowOf),
      next: batch.next,
      stopped: batch.stopped,
      ...(batch.past === undefined ? {} : { past: batch.past }),
      ...(a.mine === true ? { projects: [...listed].sort() } : {}),
    }
  },
})

/**
 * The milestones of `projects` the app shows on a day in [from, to), in
 * upcoming order, for the Roadmap's window (from its first week's first day
 * to the day after its last week) and Team sync's this week and next. `to`
 * comes after `from`, at most LIMITS.roadmapWeeks.max weeks later. Projects
 * are read as `section` reads them, and a stored day that does not exist
 * counts as it does there. `next` and `stopped` are null when every
 * milestone in the range is there. When the read's budget ran out first,
 * the rows are every milestone up to the position `next` names, `stopped`
 * is its stored day, and a call with `after: next` and the same projects
 * and days goes on from there, without answering a milestone twice or
 * skipping one.
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
 * (model/milestones.ts visibleMilestone). When the check of whether its
 * project shows to the caller for navigation needs more reads than one
 * request allows, it refuses with MILESTONE_READ_TOO_LARGE.
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
