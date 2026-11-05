/* The project view a member's reads built at once before they asked about
 * the projects their rows name: every project of the organization and the
 * member's grants and team shares, read together, with each project's
 * visibility a set lookup. Team sync's latest comments (teamSync.ts
 * lastComments) was its last caller. The access suites keep it as the
 * oracle they compare the per-project reads with (lib/access.ts accessOf),
 * over the same batched rules (levelsFrom). Named *.setup.ts: two dots in
 * the basename is the Convex CLI's skip rule (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessRowsOf, levelsFrom, orgProjects } from '../lib/access'

export type OrgProjectView = {
  /* every project of the org, archived included */
  projects: Doc<'projects'>[]
  byUuid: Map<string, Doc<'projects'>>
  visibleRootIds: Set<string>
  /* can_see_project(projectId) through the precomputed roots */
  visible: (projectId: string) => boolean
  /* visible for a reason other than read-only navigation to a sub-project */
  accessible: (projectId: string) => boolean
}

/** What `me` sees of every project of the organization, read at once:
 * every project (lib/access.ts orgProjects) and every grant and team share
 * of theirs (accessRowsOf). */
export async function orgProjectView(ctx: QueryCtx, me: Doc<'profiles'>): Promise<OrgProjectView> {
  // the projects and the caller's grants and shares, read at once
  const [projects, { grants, shares }] = await Promise.all([
    orgProjects(ctx, me.org_id),
    accessRowsOf(ctx, me),
  ])
  const byUuid = new Map<string, Doc<'projects'>>()
  for (const p of projects) byUuid.set(p.id, p)

  const visibleRootIds = new Set<string>()
  const { levelOf, navigationOnly } = levelsFrom(me, projects, grants, shares)
  const visibleIds = new Set<string>()
  for (const p of projects) {
    if (levelOf(p) === null) continue
    visibleIds.add(p.id)
    if (p.parent_id === undefined) visibleRootIds.add(p.id)
  }
  const visible = (projectId: string): boolean => visibleIds.has(projectId)
  const accessible = (projectId: string): boolean =>
    visibleIds.has(projectId) && !navigationOnly(projectId)

  return { projects, byUuid, visibleRootIds, visible, accessible }
}
