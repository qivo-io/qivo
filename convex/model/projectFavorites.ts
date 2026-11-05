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
 * The navigation reads (model/projectNavReads.ts) read a seat's live rows
 * in name order (favoritesIndex) and judge each with favoriteShows:
 * projectNav.page lists the rows that pass first, leaves their projects
 * out of the list of the rest, and marks `favorite` on each row, and
 * projectNav.resolve answers a top-level project's favorite state by the
 * same verdict.
 *
 * A loss of access leaves a seat's rows, and so may a rollback to a release
 * that knows no favorites, which keeps no copy. So every reader shows a row
 * only when all of these hold (favoriteShows):
 * - its org_id is the seat's organization and the project's;
 * - the live table holds the project, a top-level meta that is not
 *   archived;
 * - its copies are the project's (copiesOf): its name_key is
 *   nameKey(project.name) and its live is true;
 * - the seat sees the project through ordinary access, judged as
 *   lib/access.ts accessOf of ordinaryOf(seat) judges it, by the
 *   navigation lists' rule (model/projectNavReads.ts seatSight shows): for
 *   a reason of its own (accessible), or through a live sub-project the
 *   seat sees that a live child reach row of the seat or of one of its
 *   teams names. A project the seat sees only through an archived
 *   sub-project has nothing live to lead to and shows in no list, though
 *   setFavoriteCore, which asks visible, stars it.
 * Before the access check a reader asks for a reach row of the seat or one
 * of its teams on the project, which every top-level project the seat sees
 * holds once the organization's reach rows are complete (org_ready nav_at),
 * so a row on a project the seat lost costs only those lookups and reads no
 * data of that project.
 *
 * A row that fails is skipped. It is never shown, counted or allowed to
 * move another row, and it keeps no project out of the list of the rest.
 * It may be the position where the read budget stops a batch, which is
 * sealed in the cursor (lib/namedPages.ts readBatch answers the last row it
 * read, kept or not) and shows nothing of the row; that keeps every batch
 * moving forward. A check a bound of OWN_READS stopped (accessUnchecked)
 * makes the read say it is incomplete or refuse; it never moves the
 * project into the other list as if it were no favorite. The list of the
 * rest leaves out a seat's favorites by the same verdict, so a project
 * shows in one list only. A seat's next star of the project resets a row
 * whose copies or organization differ. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { accessOf, inMetaTree, ordinaryOf } from '../lib/access'
import { byId } from '../lib/db'
import { badRequest, notFound } from '../lib/functions'
import type { NamedIndex } from '../lib/namedPages'
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

/** The rows of seat `profileId` on project `projectId`: one, or none, as
 * setFavoriteCore keeps them. */
export const favoriteOf = (ctx: QueryCtx, profileId: string, projectId: string) =>
  ctx.db
    .query('project_favorites')
    .withIndex('by_project_profile', (q) =>
      q.eq('project_id', projectId).eq('profile_id', profileId),
    )

/** The live favorites of `seat` in name order (by_profile_list, `live`
 * true), as the navigation lists read them (model/projectNavReads.ts): the
 * copied name key, then the project id and then the seat's organization,
 * which every row of one seat shares, so the positions of two seats of one
 * login never meet. A row of an archived project (`live` false) is never
 * read. */
export function favoritesIndex(
  ctx: QueryCtx,
  seat: Pick<Doc<'profiles'>, 'id' | 'org_id'>,
): NamedIndex<Doc<'project_favorites'>, readonly [string, string]> {
  const rows = () => ctx.db.query('project_favorites')
  return {
    all: () =>
      rows().withIndex('by_profile_list', (q) => q.eq('profile_id', seat.id).eq('live', true)),
    // from the cursor's project id itself, since a cursor another seat's row
    // left at the same key and id lies before this seat's row there when its
    // organization sorts first, and indexAfter drops what is not past it
    after: ({ key, tie: [projectId] }) => [
      () =>
        rows().withIndex('by_profile_list', (q) =>
          q
            .eq('profile_id', seat.id)
            .eq('live', true)
            .eq('name_key', key)
            .gte('project_id', projectId),
        ),
      () =>
        rows().withIndex('by_profile_list', (q) =>
          q.eq('profile_id', seat.id).eq('live', true).gt('name_key', key),
        ),
    ],
    at: (row) => ({ key: row.name_key, tie: [row.project_id, seat.org_id] }),
  }
}

/** What the reader rule asks of a seat's navigation sight
 * (model/projectNavReads.ts seatSight): the seat; the project with an id,
 * read once a call; whether the seat or one of its teams holds a reach row
 * on a project; and whether the seat sees a live top-level meta of its
 * organization for navigation. `shows` rejects with accessUnchecked where a
 * bound stopped its check. */
export type FavoriteSight = {
  seat: Doc<'profiles'>
  project: (id: string) => Promise<Doc<'projects'> | null>
  reached: (projectId: string) => Promise<boolean>
  shows: (project: Doc<'projects'>) => Promise<boolean>
}

/**
 * The project favorites row `row` names when the row shows for
 * `sight.seat` by the reader rule (module header), else null. It checks
 * the row's own fields first, then asks for a reach row on the project
 * (`reached`), so a row on a project the seat cannot see reads none of that
 * project's data, then reads the project and checks its tree, state and
 * copies, and asks the access check last. Rejects with accessUnchecked
 * where that check stopped, never answering such a row as no favorite.
 */
export async function favoriteShows(
  sight: FavoriteSight,
  row: Doc<'project_favorites'>,
): Promise<Doc<'projects'> | null> {
  const { seat } = sight
  if (row.profile_id !== seat.id || row.org_id !== seat.org_id || !row.live) return null
  if (!(await sight.reached(row.project_id))) return null
  const project = await sight.project(row.project_id)
  if (project === null || project.id !== row.project_id || project.org_id !== row.org_id)
    return null
  if (!inMetaTree(project, project) || project.archived_at !== undefined) return null
  const copies = copiesOf(project)
  if (row.name_key !== copies.name_key || row.live !== copies.live) return null
  return (await sight.shows(project)) ? project : null
}

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
