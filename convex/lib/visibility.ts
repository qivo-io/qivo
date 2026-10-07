// Preload projects and applicable grants once per organization. Per-row
// visibility becomes a set lookup; corrupt roots remain invisible.

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { projectLevelsForOrg } from './access'

export type OrgProjectView = {
  /* every project of the org, archived included */
  projects: Doc<'projects'>[]
  byUuid: Map<string, Doc<'projects'>>
  visibleRootIds: Set<string>
  /* can_see_project(projectId) through the precomputed roots */
  visible: (projectId: string) => boolean
}

export async function orgProjectView(ctx: QueryCtx, me: Doc<'profiles'>): Promise<OrgProjectView> {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const byUuid = new Map<string, Doc<'projects'>>()
  for (const p of projects) byUuid.set(p.id, p)

  const visibleRootIds = new Set<string>()
  const levelForProject = await projectLevelsForOrg(ctx, me, projects)
  const visibleIds = new Set<string>()
  for (const p of projects) {
    if (levelForProject(p) === null) continue
    visibleIds.add(p.id)
    if (p.parent_id === undefined) visibleRootIds.add(p.id)
  }
  const visible = (projectId: string): boolean => visibleIds.has(projectId)

  return { projects, byUuid, visibleRootIds, visible }
}
