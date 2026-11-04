/* Project navigation: the All projects directory, the sidebar and startup
 * selection.
 *
 * - page: one batch of the top-level projects the caller sees for
 *   navigation across every active seat of their login, each seat's
 *   favorites first and then the rest, each group in name order, 25 a batch
 *   with sealed `after` and `through` cursors.
 * - children: one batch of a top-level project's live sub-projects the
 *   caller sees, 25 a batch, the same way.
 * - resolve: whether one project, named by id or by its organization and
 *   number, is open to the caller for navigation, with its parent and its
 *   favorite state; a check a bound stopped answers apart from a loss.
 * - setFavorite: stars or unstars a top-level project for the caller's seat
 *   in the organization (model/projectFavorites.ts).
 *
 * The reads are live queries, in model/projectNavReads.ts. Each judges every
 * project by the caller's ordinary access, so admin status alone adds
 * none; finds its candidates in the caller's own reach and favorite rows
 * and the projects they name, or, for the sub-projects of a project the
 * caller sees for a reason of its own, in that project's live
 * sub-projects; reads no task; and answers `not_ready`, `stopped` or the
 * access_unchecked refusal where it cannot finish, never a partial list as
 * complete. No app calls them or stars yet. */

import { v } from 'convex/values'
import { authedQuery, orgMutation } from './lib/functions'
import { setFavoriteCore } from './model/projectFavorites'
import {
  type NavChildren,
  type NavPage,
  type NavResolve,
  navChildrenOf,
  navPageOf,
  navResolveOf,
} from './model/projectNavReads'

/** The cursors of a navigation batch: its start (`after`, none for the
 * first batch) and, to keep a loaded batch live, its end (`through`). */
const vNavCursors = { after: v.optional(v.string()), through: v.optional(v.string()) }

/** One batch of the top-level projects the caller sees for navigation
 * across every active seat (model/projectNavReads.ts navPageOf): each
 * seat's favorites by the reader rule first, then the rest, each group in
 * name key order with the project id breaking ties, rows of several
 * organizations in one order. Rows are `{ id, org_id, name, num, favorite
 * }`. `not_ready` while an organization's reach rows or name keys are not
 * complete; `unavailable` with access_unchecked where a check stopped. */
export const page = authedQuery({
  args: vNavCursors,
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
