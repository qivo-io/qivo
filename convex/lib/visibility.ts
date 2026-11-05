// Preload projects and applicable grants once per organization. Per-row
// visibility becomes a set lookup; corrupt roots remain invisible. Team
// sync's latest comments (teamSync.ts lastComments) is its last caller; a
// member's task history asks lib/access.ts accessOf about the projects its
// rows name instead (lib/activityVisibility.ts).

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessRowsOf, levelsFrom, orgProjects } from './access'

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
 * of theirs (accessRowsOf), a read at the design size's sum of 13 index
 * ranges, 3,710 documents and 1.15 MiB as convex-test counts them for the
 * catalogue of 2,000 projects, accepted as accessRowsOf's docstring says.
 * Past the design size Convex's own read limit refuses the call with a
 * generic server error, which widens nothing. */
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
