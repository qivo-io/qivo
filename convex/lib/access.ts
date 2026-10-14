// Indexed permission predicates over an already-resolved profile, plus the
// credential access rule the machine surfaces share (end of file).
// Identity and active-seat checks belong to lib/functions.ts.

import type { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { type AccessLevel, type CredentialAccess, LEVEL_RANK, type OrgRole } from './enums'
import { badRequest, forbidden, notFound, type Refusal } from './functions'

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

// Raw membership predicate; isTeamLeader adds the role and kind restriction.
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
  // unknown future roles cannot. Creating a new top-level project follows the
  // organization's project_creators setting (lib/projectCreators.ts), and
  // team administration still requires organization staff.
  const canLead = me.org_role === 'admin' || me.org_role === 'user' || me.org_role === 'guest'
  return canLead && (project.lead_id ?? root.lead_id) === me.id
}

async function directLevel(ctx: QueryCtx, me: Doc<'profiles'>, project: Doc<'projects'>) {
  return higherLevel(
    (await grantOn(ctx, project.id, me.id))?.level ?? null,
    await teamGrantOn(ctx, me, project),
  )
}

/* includeNavigation: whether a parent visible only for navigation to one of
 * its sub-projects counts (it then answers 'viewer'). */
async function projectLevel(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  includeNavigation = true,
): Promise<AccessLevel | null> {
  const root = await rootMetaOf(ctx, project)
  if (project.org_id !== me.org_id || root.org_id !== me.org_id) return null
  if (me.org_role === 'admin' || isProjectLead(me, project, root)) return 'lead'
  let level = await directLevel(ctx, me, project)
  if (project.id !== root.id) {
    const inherited = isProjectLead(me, root, root) ? 'user' : await directLevel(ctx, me, root)
    level = higherLevel(level, inherited)
  } else if (level === null && includeNavigation) {
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

/* Access for a reason other than read-only navigation, the per-profile
 * counterpart of OrgProjectView.accessible. On a parent it means organization
 * admin, its lead, or an individual or team grant on the parent itself. On a
 * sub-project it equals canSeeProject. */
export async function canAccessProject(
  ctx: QueryCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<boolean> {
  return (await projectLevel(ctx, profile, project, false)) !== null
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

/* Only a person with an org staff role can lead a team. The kind is named
 * positively, so agents and any future kind never lead one. */
export function canLeadTeams(me: Doc<'profiles'>): boolean {
  return isOrgStaff(me) && me.kind === 'person'
}

/* Team leadership requires canLeadTeams and a same-org leader row; leader
 * rows held by guests, viewers or agents grant nothing. */
export async function isTeamLeader(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  teamId: string | null | undefined,
): Promise<boolean> {
  if (teamId === null || teamId === undefined) return false
  if (!canLeadTeams(me)) return false
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

export type OrgProjectLevels = {
  levelOf: (project: Doc<'projects'>) => AccessLevel | null
  /* true when levelOf answers 'viewer' only because the person can access
   * one of the project's sub-projects */
  navigationOnly: (projectId: string) => boolean
}

/* Amortized counterpart of projectLevel, used by snapshots and list reads.
 * Evaluate actual projects rather than reusing the parent's answer for all
 * siblings. Navigation-only parent visibility is never inherited back down.
 * Callers that already loaded the complete org project list can reuse it. */
export async function projectLevelsForOrg(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  loadedProjects?: readonly Doc<'projects'>[],
): Promise<OrgProjectLevels> {
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
  const navigation = new Set<string>()
  for (const project of projects) {
    if (
      project.parent_id &&
      effective.get(project.id) != null &&
      effective.get(project.parent_id) === null
    ) {
      effective.set(project.parent_id, 'viewer')
      navigation.add(project.parent_id)
    }
  }
  return {
    levelOf: (project) =>
      project.org_id === me.org_id ? (effective.get(project.id) ?? null) : null,
    navigationOnly: (projectId) => navigation.has(projectId),
  }
}

/* Staff may add organization labels when any meta grants user standing,
 * including explicit team sharing. Renaming, recoloring and deleting follow
 * canManageOrgLabels. */
export async function canWriteOrgLabels(ctx: QueryCtx, me: Doc<'profiles'>): Promise<boolean> {
  if (!isOrgStaff(me)) return false
  if (me.org_role === 'admin') return true
  const { levelOf: levelForRoot } = await projectLevelsForOrg(ctx, me)
  const orgProjects = ctx.db.query('projects').withIndex('by_org', (q) => q.eq('org_id', me.org_id))
  for await (const p of orgProjects) {
    if (p.type === 'meta' && levelRank(levelForRoot(p)) >= LEVEL_RANK.user) return true
  }
  return false
}

/* Only organization admins rename, recolor or delete labels, as on the app's
 * admin-only Labels settings page. */
export function canManageOrgLabels(me: Doc<'profiles'>): boolean {
  return me.active && me.org_role === 'admin'
}

/* -------------------------------------------------------- credential access
 * What a machine credential lets its holder do, 'read' or 'write'. It is the
 * credential's own ceiling, and a person still needs their role's project
 * rules to write anything. REST, MCP and webhooks all ask credentialAccess, and
 * every branch names the writing case positively, so a missing field, an
 * unknown role or a new credential kind can only read. */

/** A resolved machine credential, keyed by its table like an EventOwner. */
export type AccessCredential =
  | {
      table: 'mcp_tokens'
      token: Pick<Doc<'mcp_tokens'>, 'access' | 'expires_at'>
      /** epoch milliseconds the expiry is judged against */
      now: number
    }
  | { table: 'oauth_connections'; scopes: readonly string[] }
  | { table: 'agent_keys' }

/**
 * The credential's access. A personal token writes only when it was created
 * with write access and has not expired; an OAuth grant only with both
 * qivo:read and qivo:write; an agent key only for a Standard user agent.
 */
export function credentialAccess(
  credential: AccessCredential,
  profile: Pick<Doc<'profiles'>, 'kind' | 'org_role'>,
): CredentialAccess {
  switch (credential.table) {
    case 'mcp_tokens':
      return profile.kind === 'person' &&
        credential.token.access === 'write' &&
        !tokenExpired(credential.token, credential.now)
        ? 'write'
        : 'read'
    case 'oauth_connections':
      return profile.kind === 'person' &&
        credential.scopes.includes('qivo:read') &&
        credential.scopes.includes('qivo:write')
        ? 'write'
        : 'read'
    case 'agent_keys':
      return profile.kind === 'agent' && profile.org_role === 'user' ? 'write' : 'read'
    default:
      return 'read'
  }
}

/**
 * What a machine caller may do right now. It is the access its credential
 * was resolved with, narrowed for an agent by its live role, which can change
 * between authentication and dispatch. asMachineCaller refuses a write unless
 * this is 'write', and get_me reports it.
 */
export function machineAccess(
  profile: Pick<Doc<'profiles'>, 'kind' | 'org_role'>,
  access: CredentialAccess,
): CredentialAccess {
  const live =
    profile.kind === 'agent' ? credentialAccess({ table: 'agent_keys' }, profile) : 'write'
  return access === 'write' && live === 'write' ? 'write' : 'read'
}

/**
 * Whether a personal token has expired at `now` (epoch milliseconds). A
 * token without an expiry never expires; an unreadable one counts as expired.
 */
export function tokenExpired(token: Pick<Doc<'mcp_tokens'>, 'expires_at'>, now: number): boolean {
  if (token.expires_at === undefined) return false
  return !(Date.parse(token.expires_at) > now)
}

export const VIEWER_AGENT_READS_ONLY = 'this agent is a Viewer and can only read'
export const CREDENTIAL_READS_ONLY = 'this credential can only read'

/** The refusal for a write through a credential that can only read. */
export function readOnlyRefusal(profile: Pick<Doc<'profiles'>, 'kind'>): ConvexError<Refusal> {
  return forbidden(profile.kind === 'agent' ? VIEWER_AGENT_READS_ONLY : CREDENTIAL_READS_ONLY)
}

const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

/**
 * A personal token expiry as stored, normalized to toISOString's form so it
 * sorts like every other timestamp. Refuses anything but a real UTC
 * date-time such as 2027-01-31T00:00:00Z (no offsets, no rolled-over days).
 */
export function cleanTokenExpiry(value: string): string {
  const at = UTC_DATE_TIME.test(value) ? new Date(value) : null
  const iso = at !== null && !Number.isNaN(at.getTime()) ? at.toISOString() : null
  if (iso === null || iso.slice(0, 19) !== value.slice(0, 19)) {
    throw badRequest('expires_at must be a UTC date-time such as 2027-01-31T00:00:00Z')
  }
  return iso
}
