/* Project navigation: the All projects directory and the sidebar.
 *
 * - setFavorite: stars or unstars a top-level project for the caller's seat
 *   in the organization (model/projectFavorites.ts).
 *
 * The reads that page a person's projects, favorites first, come with
 * t3/limits-project-nav-reads. The app does not star yet. */

import { v } from 'convex/values'
import { orgMutation } from './lib/functions'
import { setFavoriteCore } from './model/projectFavorites'

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
