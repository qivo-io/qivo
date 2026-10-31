/* A seat's favorite top-level projects (schema.ts project_favorites), which
 * the All projects directory and the sidebar list first, in name order.
 * A star changes that seat's navigation only. It grants nothing, writes no
 * access, reach, subscription, message or activity row, reads no task and
 * changes no other seat's favorites.
 *
 * setFavoriteCore is the one writer (projectNav.setFavorite): it stars a
 * top-level project the seat sees through ordinary access and unstars any
 * project. A rename, an archive or a restore of a starred project brings
 * the rows' copies in line (model/projectNav.ts treeFavorites,
 * settleFavorites). The teardowns delete rows through the ranges below:
 * profile removal by seat (favoritesOfProfile), the organization teardowns
 * and the public demo's cleanup by organization (favoritesOfOrg), and the
 * Deleted items purges by project (favoritesOn).
 *
 * A loss of access leaves a seat's rows, and so may a rollback to a release
 * that knows no favorites, which keeps no copy. So every reader shows a row
 * only when all of these hold:
 * - its org_id is the seat's organization and the project's;
 * - the live table holds the project, a top-level meta that is not
 *   archived;
 * - its copies are the project's (copiesOf): its name_key is
 *   nameKey(project.name) and its live is true;
 * - the seat sees the project through ordinary access by the writer's rule,
 *   lib/access.ts accessOf of ordinaryOf(seat), visible.
 * A row that fails is skipped: it is never shown, counted, used as a cursor
 * position or allowed to move another row, and it keeps no project out of
 * the list of the rest. A check a bound of OWN_READS stopped
 * (accessUnchecked) makes the read say it is incomplete or refuse; it never
 * moves the project into the other list as if it were no favorite. The list
 * of the rest leaves out a seat's favorites by the same verdict, so a
 * project shows in one list only. A seat's next star of the project resets
 * a row whose copies or organization differ. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { accessOf, ordinaryOf } from '../lib/access'
import { byId } from '../lib/db'
import { badRequest, notFound } from '../lib/functions'
import { nameKey } from '../lib/nameKey'

/** The copies a favorites row holds of project `p`: its name key and
 * whether it is live. */
export const copiesOf = (p: Pick<Doc<'projects'>, 'name' | 'archived_at'>) => ({
  name_key: nameKey(p.name),
  live: p.archived_at === undefined,
})

/** Every favorites row of seat `profileId`, live and archived, for profile
 * removal (model/cascade.ts ACCESS_RANGES) and an organization deletion's
 * profiles phase. */
export const favoritesOfProfile = (ctx: QueryCtx, profileId: string) =>
  ctx.db
    .query('project_favorites')
    .withIndex('by_profile_list', (q) => q.eq('profile_id', profileId))

/** Every seat's favorites row on project `projectId`, for a tree change
 * that keeps their copies and for a Deleted items purge. */
export const favoritesOn = (ctx: QueryCtx, projectId: string) =>
  ctx.db
    .query('project_favorites')
    .withIndex('by_project_profile', (q) => q.eq('project_id', projectId))

/** Every favorites row of organization `orgId`, for the teardowns that
 * delete its projects. */
export const favoritesOfOrg = (ctx: QueryCtx, orgId: string) =>
  ctx.db.query('project_favorites').withIndex('by_org', (q) => q.eq('org_id', orgId))

/* The rows of seat `profileId` on project `projectId`: one, or none. */
const favoriteOf = (ctx: QueryCtx, profileId: string, projectId: string) =>
  ctx.db
    .query('project_favorites')
    .withIndex('by_project_profile', (q) =>
      q.eq('project_id', projectId).eq('profile_id', profileId),
    )

/** The refusal of a star on a sub-project the seat sees. */
export const TOP_LEVEL_ONLY = 'only a top-level project can be a favorite'

/**
 * Stars (`favorite` true) or unstars project `projectId` for seat `me`.
 *
 * A star reads the project and answers `project not found` alike for an
 * unknown id, a project of another organization, one in Deleted items and
 * one `me` does not see through ordinary access, so admin status alone
 * stars nothing. A check a bound of OWN_READS stopped rejects with
 * accessUnchecked and writes nothing. Only then does it refuse a
 * sub-project (TOP_LEVEL_ONLY), so that refusal tells nothing of a project
 * the seat cannot see. It writes the seat's one row on the project with
 * the project's copies, an archived one's live false. A row that holds them
 * already stays as it is, with its created_at, so a repeated star writes
 * nothing; one whose copies or organization differ is reset, and a second
 * row of the seat on the project goes.
 *
 * An unstar deletes the seat's rows on the id whatever the project's state
 * or the seat's access, so a seat can always remove its own preference, and
 * its answer depends on nothing the seat cannot see.
 */
export async function setFavoriteCore(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; projectId: string; favorite: boolean; now: string },
): Promise<void> {
  const { me, projectId } = a
  if (!a.favorite) {
    for await (const row of favoriteOf(ctx, me.id, projectId)) await ctx.db.delete(row._id)
    return
  }
  const project = await byId(ctx, 'projects', projectId)
  if (project === null || project.org_id !== me.org_id) throw notFound('project not found')
  if (!(await accessOf(ctx, ordinaryOf(me), [project]).visible(project.id)))
    throw notFound('project not found')
  if (project.parent_id !== undefined) throw badRequest(TOP_LEVEL_ONLY)
  const want = { org_id: project.org_id, ...copiesOf(project) }
  let kept = false
  for await (const row of favoriteOf(ctx, me.id, project.id)) {
    if (kept) await ctx.db.delete(row._id)
    else if (row.org_id !== want.org_id || row.name_key !== want.name_key || row.live !== want.live)
      await ctx.db.patch(row._id, want)
    kept = true
  }
  if (!kept)
    await ctx.db.insert('project_favorites', {
      ...want,
      profile_id: me.id,
      project_id: project.id,
      created_at: a.now,
    })
}
