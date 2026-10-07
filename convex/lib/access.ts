// Indexed permission predicates over an already-resolved profile.
// Identity and active-seat checks belong to lib/functions.ts.

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { type AccessLevel, LEVEL_RANK, type OrgRole } from './enums'
import { notFound } from './functions'

export function levelRank(l: AccessLevel | null): number {
  // No grant ranks below every permission level.
  return l === null ? 0 : LEVEL_RANK[l]
}

// Viewer seats cannot exceed viewer access; a missing grant stays missing.
export function cappedLevel(role: OrgRole, level: AccessLevel | null): AccessLevel | null {
  if (role === 'viewer' && level !== null && LEVEL_RANK[level] > LEVEL_RANK.viewer) return 'viewer'
  return level
}

// Enumerate staff roles positively so new roles fail closed.
export function isOrgStaff(me: Doc<'profiles'>): boolean {
  return me.org_role === 'admin' || me.org_role === 'user'
}

// Resolve the root defensively: dangling parents and cycles fail closed.
export async function rootMetaOf(
  ctx: QueryCtx,
  project: Doc<'projects'>,
): Promise<Doc<'projects'>> {
  let current = project
  const seen = new Set<string>([project.id])
  while (current.parent_id !== undefined) {
    const parentId = current.parent_id
    const parent = await ctx.db
      .query('projects')
      .withIndex('by_uuid', (q) => q.eq('id', parentId))
      .unique()
    if (parent === null || seen.has(parent.id)) {
      throw notFound('project not found')
    }
    seen.add(parent.id)
    current = parent
  }
  return current
}

async function grantOn(ctx: QueryCtx, projectId: string, profileId: string) {
  return await ctx.db
    .query('project_access')
    .withIndex('by_project_profile', (q) =>
      q.eq('project_id', projectId).eq('profile_id', profileId),
    )
    .unique()
}

const higherLevel = (a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null =>
  levelRank(a) >= levelRank(b) ? a : b

// Guests participate through individual invitations, never through teams.
// Positively enumerate membership roles so future roles fail closed.
const receivesTeamAccess = (me: Doc<'profiles'>): boolean =>
  isOrgStaff(me) || me.org_role === 'viewer'

async function teamGrantOn(ctx: QueryCtx, me: Doc<'profiles'>, root: Doc<'projects'>) {
  if (!receivesTeamAccess(me)) return null
  let level: AccessLevel | null = null
  const grants = ctx.db
    .query('project_team_access')
    .withIndex('by_project', (q) => q.eq('project_id', root.id))
  for await (const grant of grants) {
    const team = await ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', grant.team_id))
      .unique()
    if (team === null || team.org_id !== me.org_id) continue
    const membership = await ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', team.id).eq('profile_id', me.id))
      .unique()
    if (membership !== null) level = higherLevel(level, grant.level)
  }
  return level
}

// Raw membership predicate; callers enforce their own role restriction.
async function leadsTeam(
  ctx: QueryCtx,
  profileId: string,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (teamId === null || teamId === undefined) return false
  const tm = await ctx.db
    .query('team_members')
    .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
    .unique()
  return tm?.is_leader ?? false
}

/* A named lead controls its project. A parent lead has Edit on children
 * with a different lead; legacy children without a lead use their parent's.
 * Team leadership never confers project authority. */
function isProjectLead(me: Doc<'profiles'>, project: Doc<'projects'>, root: Doc<'projects'>) {
  // Guests may lead a project they were explicitly invited to; viewers and
  // unknown future roles cannot. Organization staff is still required for
  // creating a new top-level project and for team administration.
  const canLead = me.org_role === 'admin' || me.org_role === 'user' || me.org_role === 'guest'
  return canLead && (project.lead_id ?? root.lead_id) === me.id
}

async function directLevel(ctx: QueryCtx, me: Doc<'profiles'>, project: Doc<'projects'>) {
  return higherLevel(
    (await grantOn(ctx, project.id, me.id))?.level ?? null,
    await teamGrantOn(ctx, me, project),
  )
}

async function projectLevel(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<AccessLevel | null> {
  const root = await rootMetaOf(ctx, project)
  if (project.org_id !== me.org_id || root.org_id !== me.org_id) return null
  if (me.org_role === 'admin' || isProjectLead(me, project, root)) return 'lead'
  let level = await directLevel(ctx, me, project)
  if (project.id !== root.id) {
    const inherited = isProjectLead(me, root, root) ? 'user' : await directLevel(ctx, me, root)
    level = higherLevel(level, inherited)
  } else if (level === null) {
    // A child grant exposes its parent for navigation, without granting
    // permissions on siblings or control over the parent.
    const children = ctx.db
      .query('projects')
      .withIndex('by_parent', (q) => q.eq('parent_id', root.id))
    for await (const child of children) {
      if (child.org_id !== me.org_id) continue
      if (isProjectLead(me, child, root) || (await directLevel(ctx, me, child)) !== null) {
        level = 'viewer'
        break
      }
    }
  }
  return cappedLevel(me.org_role, level)
}

export async function canSeeProject(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return (await projectLevel(ctx, me, project)) !== null
}

// Recipient visibility uses the same permission rules, without an active-seat
// restriction: callers decide whether inactive recipients are eligible.
export async function profileCanSeeProject(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return await canSeeProject(ctx, profile, project)
}

/* Effective level is the highest leadership, individual or team grant,
 * capped by the org viewer ceiling. Unknown projects answer false. */
export async function hasProjectLevel(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  projectId: string,
  min: 'user' | 'lead' | 'admin',
): Promise<boolean> {
  const project = await ctx.db
    .query('projects')
    .withIndex('by_uuid', (q) => q.eq('id', projectId))
    .unique()
  if (project === null) return false
  return levelRank(await projectLevel(ctx, me, project)) >= levelRank(min)
}

/* Assignment is new work: the recipient must be active and hold effective
 * Edit access, including inherited individual/team grants and leadership.
 * Positively enumerate eligible org roles so new roles fail closed. */
export async function profileCanBeAssigned(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return (
    profile.active &&
    (isOrgStaff(profile) || profile.org_role === 'guest') &&
    (await hasProjectLevel(ctx, profile, project.id, 'user'))
  )
}

/* Team leadership requires an org staff role and a same-org membership;
 * corrupt guest/viewer memberships cannot grant leadership. */
export async function isTeamLeader(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (teamId === null || teamId === undefined) return false
  if (!isOrgStaff(me)) return false
  const team = await ctx.db
    .query('teams')
    .withIndex('by_uuid', (q) => q.eq('id', teamId))
    .unique()
  if (team === null || team.org_id !== me.org_id) return false
  return await leadsTeam(ctx, me.id, teamId)
}

/* Only the named lead and organization administrators control permissions. */
export async function canManageOwnProjectAccess(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  if (!me.active || project.org_id !== me.org_id) return false
  const root = await rootMetaOf(ctx, project)
  return root.org_id === me.org_id && (me.org_role === 'admin' || isProjectLead(me, project, root))
}

export const canManageProjectUsers = canManageOwnProjectAccess

export const canManageProjectTeams = canManageProjectUsers

/* Amortized counterpart of projectLevel, used by snapshots and list reads.
 * Evaluate actual projects rather than reusing the parent's answer for all
 * siblings. Navigation-only parent visibility is never inherited back down.
 * Callers that already loaded the complete org project list can reuse it. */
export async function projectLevelsForOrg(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  loadedProjects?: readonly Doc<'projects'>[],
): Promise<(project: Doc<'projects'>) => AccessLevel | null> {
  const projects =
    loadedProjects ??
    (await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
      .collect())
  const byUuid = new Map(projects.map((p) => [p.id, p]))
  const grants = await ctx.db
    .query('project_access')
    .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
    .collect()
  const levels = new Map<string, AccessLevel>(grants.map((g) => [g.project_id, g.level]))
  if (receivesTeamAccess(me)) {
    const memberships = ctx.db
      .query('team_members')
      .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
    for await (const membership of memberships) {
      const team = await ctx.db
        .query('teams')
        .withIndex('by_uuid', (q) => q.eq('id', membership.team_id))
        .unique()
      if (team === null || team.org_id !== me.org_id) continue
      const shares = ctx.db
        .query('project_team_access')
        .withIndex('by_team', (q) => q.eq('team_id', team.id))
      for await (const share of shares) {
        levels.set(
          share.project_id,
          higherLevel(levels.get(share.project_id) ?? null, share.level) ?? share.level,
        )
      }
    }
  }
  const effective = new Map<string, AccessLevel | null>()
  for (const project of projects) {
    const root = project.parent_id === undefined ? project : byUuid.get(project.parent_id)
    if (!root || root.parent_id !== undefined || root.type !== 'meta') continue
    let level = levels.get(project.id) ?? null
    if (me.org_role === 'admin' || isProjectLead(me, project, root)) level = 'lead'
    else if (project.id !== root.id) {
      level = higherLevel(
        level,
        isProjectLead(me, root, root) ? 'user' : (levels.get(root.id) ?? null),
      )
    }
    effective.set(project.id, cappedLevel(me.org_role, level))
  }
  for (const project of projects) {
    if (
      project.parent_id &&
      effective.get(project.id) != null &&
      effective.get(project.parent_id) === null
    ) {
      effective.set(project.parent_id, 'viewer')
    }
  }
  return (project) => (project.org_id === me.org_id ? (effective.get(project.id) ?? null) : null)
}

/* Staff may curate organization labels when any meta grants user standing,
 * including explicit team sharing. */
export async function canWriteOrgLabels(ctx: QueryCtx, me: Doc<'profiles'>): Promise<boolean> {
  if (!isOrgStaff(me)) return false
  if (me.org_role === 'admin') return true
  const levelForRoot = await projectLevelsForOrg(ctx, me)
  const orgProjects = ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', me.org_id))
  for await (const p of orgProjects) {
    if (p.type === 'meta' && levelRank(levelForRoot(p)) >= LEVEL_RANK.user) return true
  }
  return false
}
