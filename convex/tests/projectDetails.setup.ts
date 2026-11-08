/* The oracles of the project details and project user suites
 * (projectDetails.test.ts, projectUsers.test.ts): the reads REST and MCP
 * made before these lists paged, each project's milestones and grants read
 * whole and the organization's whole roster walked one profile at a time,
 * sorted here into the order the pages answer. Two dots in the basename
 * keep the Convex CLI from deploying this module, as helpers.setup.ts. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canAccessProject, profileCanBeAssigned, rootMetaOf } from '../lib/access'
import { userJson } from '../lib/core'
import { byId } from '../lib/db'
import { compareNamed } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'

/** The organization's whole roster, as lib/core.ts listUsersCore read it,
 * in the order the user pages answer: the stored name key, then the id. */
export async function wholeRoster(ctx: QueryCtx, orgId: string): Promise<Doc<'profiles'>[]> {
  const rows = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return rows.sort((a, b) =>
    compareNamed({ key: a.name_key ?? '', tie: [a.id] }, { key: b.name_key ?? '', tie: [b.id] }),
  )
}

/** A project's users as the list built them before, one canAccessProject
 * and one profileCanBeAssigned walk per profile, in the pages' order. */
export async function perProfileUsers(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
) {
  const out = []
  for (const profile of await wholeRoster(ctx, me.org_id)) {
    if (!(await canAccessProject(ctx, profile, project))) continue
    out.push({
      ...userJson(profile),
      assignable: await profileCanBeAssigned(ctx, profile, project),
    })
  }
  return out
}

type Milestone = { id: string; name: string; date: string }
type Grant = { id: string; name: string; level: string }

/** A project's milestones and grants as the details read them before, the
 * top-level project's milestones and the project's own grants and shares
 * whole, in the order the pages answer: milestones by stored day, name key
 * and id, grants by the holder's name key copy and id. */
export async function wholeRelated(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<{ milestones: Milestone[]; user_grants: Grant[]; team_grants: Grant[] }> {
  const root = await rootMetaOf(ctx, project)
  const milestones = (
    await ctx.db
      .query('milestones')
      .withIndex('by_project', (q) => q.eq('project_id', root.id))
      .collect()
  )
    .sort((a, b) =>
      compareNamed(
        { key: a.week, tie: [nameKey(a.name), a.id] },
        { key: b.week, tie: [nameKey(b.name), b.id] },
      ),
    )
    .map((m) => ({ id: m.id, name: m.name, date: m.week }))
  const users: (Grant & { at: string })[] = []
  for (const g of await ctx.db
    .query('project_access')
    .withIndex('by_project', (q) => q.eq('project_id', project.id))
    .collect()) {
    const p = await byId(ctx, 'profiles', g.profile_id)
    if (p !== null && p.org_id === project.org_id)
      users.push({ id: p.id, name: p.name, level: g.level, at: g.name_key ?? '' })
  }
  const teams: (Grant & { at: string })[] = []
  for (const s of await ctx.db
    .query('project_team_access')
    .withIndex('by_project', (q) => q.eq('project_id', project.id))
    .collect()) {
    const team = await byId(ctx, 'teams', s.team_id)
    if (team !== null && team.org_id === project.org_id)
      teams.push({ id: team.id, name: team.name, level: s.level, at: s.name_key ?? '' })
  }
  const ordered = (rows: (Grant & { at: string })[]) =>
    rows
      .sort((a, b) => compareNamed({ key: a.at, tie: [a.id] }, { key: b.at, tie: [b.id] }))
      .map(({ at: _at, ...row }) => row)
  return { milestones, user_grants: ordered(users), team_grants: ordered(teams) }
}
