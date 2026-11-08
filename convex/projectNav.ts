/* Project navigation: the All projects directory with its name search,
 * the sidebar, startup selection and the project pickers.
 *
 * - page: one batch of the top-level projects the caller sees for
 *   navigation across every active seat of their login, the favorites of
 *   every seat first and then the rest of every seat, each group in name
 *   order, 25 a batch with sealed `after` and `through` cursors; with
 *   `org_id` only that seat's, for Team sync's scope menu, and with
 *   `team_id` beside it that team's own shares the caller sees, projects
 *   and sub-projects together, for Team sync's notes.
 * - targets: one batch of the live sub-projects the caller may add tasks to
 *   (Edit or Lead), across every seat or in one organization, grouped under
 *   their top-level projects, with a search, for the New task dialog, the
 *   Move window and the task window's Link task offer.
 * - holds: whether the caller sees any top-level project and any
 *   sub-project, for every "no project" and "no sub-project" note.
 * - children: one batch of a top-level project's live sub-projects the
 *   caller sees, 25 a batch, the same way.
 * - resolve: whether one project, named by id or by its organization and
 *   number, is open to the caller for navigation, with its parent and its
 *   favorite state; a check a bound stopped answers apart from a loss.
 * - byIds: up to 100 projects by id, each one the caller opens for
 *   navigation with the caller's level on it, every sub-project's
 *   top-level project as a row of its own, each judged with the caller's
 *   seat in its organization; a check a bound stopped answers that id apart.
 * - search: one batch of the projects and sub-projects the caller sees for
 *   navigation whose own name holds every word of a search, across every
 *   active seat or in one organization, the matching favorites first and
 *   then every other match by name, 25 a batch, each sub-project with its
 *   parent.
 * - setFavorite: stars or unstars a top-level project for the caller's seat
 *   in the organization (model/projectFavorites.ts).
 *
 * The reads are live queries, in model/projectNavReads.ts. Each judges every
 * project by the caller's ordinary access, so admin status alone adds
 * none, and reads no task. page, children and search find their
 * candidates in the caller's own reach and favorite rows and the projects
 * they name, or, for the sub-projects of a project the caller sees for a
 * reason of its own, in that project's live sub-projects. They answer
 * `not_ready` until the organization's reach rows and name keys are
 * complete and `stopped` where the read budget ends a batch, never a
 * partial list as complete. resolve judges only the project it is asked
 * about and answers before those rows and keys are complete. Where a check
 * a bound stopped, each read answers the access_unchecked refusal, never a
 * loss of access. The app's shared project picker
 * (src/components/ProjectPicker.tsx), for Search in, Archived tasks,
 * Deleted items and the project chooser, calls page, children, search and
 * resolve, the All projects directory (src/components/ProjectDirectory.tsx)
 * calls page, search and children and stars through setFavorite, and the
 * sidebar's project tree (src/components/SidebarProjects.tsx) calls page
 * and children. resolve is also the check startup runs on the project the
 * person opened last and on a project address the workspace does not hold
 * (src/App.tsx), and the open rule's check of a listed project the
 * workspace does not hold (src/components/projectNavRows.tsx). byIds is
 * the read of the store's project cache (src/store/projectCache.ts), which
 * keeps the projects the open views name that the workspace does not hold,
 * and of the staging check's ui/project-by-ids step. */

import { v } from 'convex/values'
import { authedQuery, orgMutation } from './lib/functions'
import { setFavoriteCore } from './model/projectFavorites'
import {
  type NavByIds,
  type NavChildren,
  type NavHolds,
  type NavPage,
  type NavResolve,
  type NavSearch,
  type NavTargets,
  navByIdsOf,
  navChildrenOf,
  navHoldsOf,
  navPageOf,
  navResolveOf,
  navSearchOf,
  navTargetsOf,
} from './model/projectNavReads'

/** The cursors of a navigation batch: its start (`after`, none for the
 * first batch) and, to keep a loaded batch live, its end (`through`). */
const vNavCursors = { after: v.optional(v.string()), through: v.optional(v.string()) }

/** One batch of the top-level projects the caller sees for navigation
 * across every active seat (model/projectNavReads.ts navPageOf), the
 * favorites of every seat by the reader rule first, then the rest of every
 * seat, each group in name key order with the project id breaking ties,
 * rows of several organizations in one order. Rows are `{ id, org_id,
 * name, num, favorite }`. With `org_id` only that seat's, an organization
 * without the caller's seat answering an empty last batch; with `team_id`,
 * which needs `org_id`, the projects and sub-projects that team holds a
 * share on that the caller sees, with `parent_id` (navTeamOf). Each list
 * seals its cursors with what it was asked for. `not_ready` while an
 * organization's reach rows or name keys are not complete; `unavailable`
 * with access_unchecked where a check stopped. */
export const page = authedQuery({
  args: { org_id: v.optional(v.string()), team_id: v.optional(v.string()), ...vNavCursors },
  handler: (ctx, a): Promise<NavPage> => navPageOf(ctx, ctx.myProfiles, a),
})

/** One batch of the live sub-projects the caller sees of top-level
 * project `project_id` (navChildrenOf), rows `{ id, org_id, name, num,
 * parent_id }`. A sub-project the caller sees answers an empty last batch,
 * and every project they cannot open `unavailable` alike. */
export const children = authedQuery({
  args: { project_id: v.string(), ...vNavCursors },
  handler: (ctx, a): Promise<NavChildren> => navChildrenOf(ctx, ctx.myProfiles, a),
})

/** Whether one project is open to the caller for navigation
 * (navResolveOf), named by `project_id` alone or by `org_id` with `num`,
 * its number in the organization; any other form is a bad_request. Answers
 * the project with its parent and, for a top-level project, its favorite
 * state; `unavailable` alike for every project the caller cannot open, and
 * with access_unchecked and its sentence where a check stopped. */
export const resolve = authedQuery({
  args: {
    project_id: v.optional(v.string()),
    org_id: v.optional(v.string()),
    num: v.optional(v.number()),
  },
  handler: (ctx, a): Promise<NavResolve> => navResolveOf(ctx, ctx.myProfiles, a),
})

/** One batch of the live sub-projects the caller may add tasks to, Edit or
 * Lead (model/projectNavReads.ts navTargetsOf), across every active seat or
 * only the seat in `org_id`, in the order of the parent's name, the
 * parent's id, the sub-project's name and its id, 25 a batch, rows `{ id,
 * org_id, name, num, parent_id, parent_name, parent_num }`. `search` keeps
 * a row whose own or whose parent's name holds every word. An organization
 * Viewer lists none. `not_ready`, `stopped` and the access_unchecked
 * refusal answer as the other lists do. */
export const targets = authedQuery({
  args: { org_id: v.optional(v.string()), search: v.optional(v.string()), ...vNavCursors },
  handler: (ctx, a): Promise<NavTargets> => navTargetsOf(ctx, ctx.authUserId, ctx.myProfiles, a),
})

/** Whether the caller sees any live top-level project (`top`) and any live
 * sub-project (`sub`) for navigation (model/projectNavReads.ts
 * navHoldsOf), across every seat or only the seat in `org_id`, both false
 * for an organization without the caller's seat; `stopped` where the read
 * share ended the walk, and `not_ready` or the access_unchecked refusal,
 * none of which is ever an answer of no project. */
export const holds = authedQuery({
  args: { org_id: v.optional(v.string()) },
  handler: (ctx, a): Promise<NavHolds> => navHoldsOf(ctx, ctx.myProfiles, a),
})

/** Up to 100 projects by id (model/projectNavReads.ts navByIdsOf), each
 * judged with the caller's seat in its organization by ordinary access and
 * the navigation rule of resolve, rows `{ id, org_id, name, num, parent_id,
 * level, track_delay, lead_id, review_hours }` with the caller's level, the
 * project's own lead and its resolved Review time, and the top-level project
 * of every sub-project answered as a row of its own whatever the order of
 * the ids. Every project the caller cannot open is left out alike, and an id
 * whose check a bound stopped is listed in `unchecked` with `message`,
 * never left out as no access. More than 100 ids, repeats included, is a
 * bad_request before any project is read. */
export const byIds = authedQuery({
  args: { ids: v.array(v.string()) },
  handler: (ctx, { ids }): Promise<NavByIds> => navByIdsOf(ctx, ctx.myProfiles, ids),
})

/** One batch of the projects and sub-projects the caller sees for
 * navigation whose own name holds every word of `search`, in any order,
 * ignoring case and accents (model/projectNavReads.ts navSearchOf), across
 * every active seat, or only the seat in `org_id` when given. The matching
 * favorites come first, then every other match, top-level projects and
 * sub-projects together, each group in name key order with the project id
 * breaking ties. Rows are `{ id, org_id, name, num, parent, favorite }`, a
 * sub-project's `parent` its top-level project and its `favorite` null. A
 * search with nothing to match, an empty org_id or a cursor of another
 * list, login, organization or search is a bad_request, and a search past
 * its limit is refused with the limit's sentence. An org_id without the
 * caller's seat answers an empty last batch. `not_ready` while a searched
 * organization's reach rows or name keys are not complete; `unavailable`
 * with access_unchecked where a check stopped. */
export const search = authedQuery({
  args: { search: v.string(), org_id: v.optional(v.string()), ...vNavCursors },
  handler: (ctx, a): Promise<NavSearch> => navSearchOf(ctx, ctx.authUserId, ctx.myProfiles, a),
})

/** Stars (`favorite` true) or unstars top-level project `project_id` for
 * the caller's seat, as model/projectFavorites.ts setFavoriteCore writes
 * it. A star of a project the caller cannot see through ordinary access,
 * one of another organization, one in Deleted items or an unknown id
 * answers `project not found` alike, and a sub-project they see a
 * bad_request. A repeated star or unstar changes nothing. Like following a
 * task, it is refused in a read-only organization and counts as one public
 * demo write. Answers null. */
export const setFavorite = orgMutation({
  args: { project_id: v.string(), favorite: v.boolean() },
  handler: async (ctx, { project_id, favorite }): Promise<null> => {
    await setFavoriteCore(ctx, {
      me: ctx.me,
      projectId: project_id,
      favorite,
      now: new Date().toISOString(),
    })
    return null
  },
})
