// Preload projects and applicable grants once per organization. Per-row
// visibility becomes a set lookup; corrupt roots remain invisible.

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
